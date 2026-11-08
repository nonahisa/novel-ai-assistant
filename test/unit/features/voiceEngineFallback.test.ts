import { describe, expect, test, vi } from "vitest";
import { pcmWav } from "../support/fakeVoiceEngine";
import type { VoiceEngineId } from "../../../src/core/voiceEngine";

const { VoiceReadingService } = await import("../../../src/features/voiceReading");
const { buildReadingPlan } = await import("../../../src/core/readAloud");

/**
 * 0.146.0 でノートPCの実機確認から足した2つ（設計書6.42.3）。
 *
 * 1. 選んだエンジンに届かなかったとき、もう片方のエンジンが動いているかを1回だけ短く問い合わせる
 *    （設定は VOICEVOX を指していたが起動しておらず、AivisSpeech は動いていたのに読まなかった）
 * 2. 声づくりが読む速さに追いつかない状態が続いたら、1回の読み上げで1回だけ知らせる
 *    （約8.5秒の音に 13.6〜23.3秒かかり、文の間があいた）
 */

const URLS: Record<VoiceEngineId, string> = {
  aivisspeech: "http://127.0.0.1:10101",
  voicevox: "http://127.0.0.1:50021",
};

/** 宛先ごとに「動いている」かを決める偽の fetch。名乗り・話者・下ごしらえ・合成に答える */
function fakeEngines(running: Partial<Record<string, boolean>>, wav: Uint8Array = new Uint8Array(pcmWav({ ms: 1000 }))) {
  const calls: string[] = [];
  const impl = async (input: string, init?: RequestInit): Promise<Response> => {
    calls.push(input);
    const url = new URL(input);
    if (!running[url.origin]) throw new TypeError("fetch failed");
    if (init?.signal?.aborted) throw new DOMException("中止", "AbortError");
    if (url.pathname === "/engine_manifest") return new Response(JSON.stringify({ brand_name: "AivisSpeech" }));
    if (url.pathname === "/speakers") {
      return new Response(
        JSON.stringify([{ name: "まい", speaker_uuid: "u", styles: [{ name: "ノーマル", id: 1, type: "talk" }] }])
      );
    }
    if (url.pathname === "/audio_query") return new Response(JSON.stringify({ speedScale: 1 }));
    return new Response(wav);
  };
  return { calls, impl };
}

describe("選んだエンジンに届かなかったとき、もう片方を1回だけ問い合わせる", () => {
  test("選んだ VOICEVOX に届かず、AivisSpeech が動いていれば、そのエンジンと宛先を返す（名乗りを1回だけ）", async () => {
    const { calls, impl } = fakeEngines({ [URLS.aivisspeech]: true });
    const service = new VoiceReadingService((engine) => URLS[engine], impl, async () => true);
    const sentences = buildReadingPlan("地の文。", "curly", [], { splitDialogue: true });
    const planned = await service.plan(undefined, "/x.txt", "地の文。", sentences, "voicevox");
    expect(planned).toMatchObject({ engineDown: true });
    const running = await service.otherEngineRunning("voicevox");
    expect(running).toEqual({ engine: "aivisspeech", host: "127.0.0.1:10101" });
    expect(calls.filter((u) => u.startsWith(URLS.aivisspeech))).toEqual([`${URLS.aivisspeech}/engine_manifest`]);
  });

  test("もう片方も動いていなければ undefined（今までの窓だけ）", async () => {
    const { impl } = fakeEngines({});
    const service = new VoiceReadingService((engine) => URLS[engine], impl, async () => true);
    expect(await service.otherEngineRunning("voicevox")).toBeUndefined();
    expect(await service.otherEngineRunning("aivisspeech")).toBeUndefined();
  });

  test("返事が来なければ短く切る（窓を待たせない）", async () => {
    const impl = (_input: string, init?: RequestInit): Promise<Response> =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("中止", "AbortError")));
      });
    const service = new VoiceReadingService((engine) => URLS[engine], impl, async () => true);
    const startedAt = Date.now();
    expect(await service.otherEngineRunning("voicevox", 50)).toBeUndefined();
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  test("もう片方がこの PC の外なら、問い合わせる前に確認を通す。断られたら1回も繋がない", async () => {
    const outside = "http://192.168.3.15:10101";
    const { calls, impl } = fakeEngines({ [outside]: true });
    const declined = vi.fn(async (_host: string) => false);
    const service = new VoiceReadingService(
      (engine) => (engine === "aivisspeech" ? outside : URLS.voicevox),
      impl,
      declined
    );
    expect(await service.otherEngineRunning("voicevox")).toBeUndefined();
    expect(declined).toHaveBeenCalledWith("192.168.3.15:10101");
    expect(calls.filter((u) => u.startsWith(outside))).toEqual([]);

    // 送ってよいと答えたら問い合わせ、動いていればそのホストを返す
    const allowed = vi.fn(async (_host: string) => true);
    const service2 = new VoiceReadingService(
      (engine) => (engine === "aivisspeech" ? outside : URLS.voicevox),
      impl,
      allowed
    );
    expect(await service2.otherEngineRunning("voicevox")).toEqual({
      engine: "aivisspeech",
      host: "192.168.3.15:10101",
    });
    expect(allowed).toHaveBeenCalledTimes(1);
  });
});

describe("声づくりが読む速さに追いつかないときの知らせ", () => {
  /**
   * 1文の合成に `seconds` 秒かかる時計。**本物のエンジンと同じく1つずつ作る**——合成の頼みは
   * 列に並び、前の音を返してから次を作り始める（時計は作り終えたときに進める）。返したあと少し
   * 間を置くのは、受け取った側が時刻を読む前に次の音で時計が進まないようにするため
   */
  function slowService(secondsPerSentence: number) {
    let clock = 0;
    let queue: Promise<void> = Promise.resolve();
    const { impl } = fakeEngines({ [URLS.aivisspeech]: true });
    const timed = async (input: string, init?: RequestInit): Promise<Response> => {
      if (new URL(input).pathname !== "/synthesis") return impl(input, init);
      const turn = queue.then(() => {
        clock += secondsPerSentence * 1000;
      });
      queue = turn.then(() => new Promise<void>((resolve) => setTimeout(resolve, 5)));
      await turn;
      return impl(input, init);
    };
    return new VoiceReadingService((engine) => URLS[engine], timed, async () => true, () => clock);
  }

  let round = 0;
  async function readAll(service: InstanceType<typeof VoiceReadingService>, start: boolean, count = 8) {
    // 読むたびに違う文にする（同じ文は控えから出て、作り直さない＝測らない）
    round++;
    const text = Array.from({ length: count }, (_, i) => `${round}回目の文${i + 1}。`).join("\n");
    const sentences = buildReadingPlan(text, "curly", [], { splitDialogue: true });
    const planned = await service.plan(undefined, "/x.txt", text, sentences, "aivisspeech", { start });
    if (!("units" in planned)) throw new Error(planned.problem);
    const notices: string[] = [];
    for (let i = 0; i < planned.units.length; i++) {
      const result = await service.audio(planned.units, i, 1);
      if ("slowNotice" in result && result.slowNotice) notices.push(result.slowNotice);
    }
    return notices;
  }

  test("1秒の音に2秒かかる状態が続けば、1回の読み上げで1回だけ、測った値とエンジンの名前で知らせる", async () => {
    const service = slowService(2);
    const notices = await readAll(service, true);
    expect(notices).toEqual([
      "この PC では、AivisSpeech の声づくりが読む速さに追いついていません（1.0秒の音に約2秒）。" +
        "［音声に書き出す］で先に作っておくと、間をあけずに聞けます。",
    ]);
    // 読んでいる途中の取り直し（start でない計画）では出し直さない
    expect(await readAll(service, false, 9)).toEqual([]);
    // 読み始め直せば、また1回出す（覚えない）
    expect(await readAll(service, true, 10)).toHaveLength(1);
  });

  test("追いついていれば知らせない。2つ並べて頼んだときのエンジンの中の待ちは数えない", async () => {
    // 1文 0.7秒なら追いついている。並べて頼んだ後の文を「頼んでから」で測ると 1.4秒になり、誤って知らせる
    expect(await readAll(slowService(0.7), true)).toEqual([]);
  });

  test("はじめの2文と続けて3文に届かないあいだは知らせない（4文の話では出ない）", async () => {
    expect(await readAll(slowService(2), true, 4)).toEqual([]);
  });
});
