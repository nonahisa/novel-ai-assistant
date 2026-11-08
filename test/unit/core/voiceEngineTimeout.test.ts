import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  VoiceEngineClient,
  VoiceEngineError,
  voiceEngineNextStep,
  voiceParamsFor,
  type FetchLike,
} from "../../../src/core/voiceEngine";
import { fakeWav } from "../support/fakeVoiceEngine";

/**
 * 遅い PC で、声づくりの時間切れを「エンジンに届かない」と取り違えない（0.147.1。設計書6.42.3）。
 *
 * ノートPCの実機確認（i5-1335U・メモリ 8GB・GPU なし・AivisSpeech を CPU で）：8.5秒の音を作るのに
 * 13.6〜23.3秒かかり、エンジンは頼みを1つずつしか作らない。先読みで2つ並べて頼むと、後ろの頼みは
 * 前の音ができるまで待つので、頼んでから30秒を超え、「エンジンに繋がりませんでした」の窓が出て止まった。
 * 直後に測ると、エンジンは動いていた。
 *
 * 時計は差し替える（本当に30秒も待たない）。偽のエンジンは、本物と同じく1つずつ作る。
 */

/** 1つずつ作る偽のエンジン。頼みごとにかかる時間（ミリ秒）を道で決める */
function serialEngine(durations: { audioQuery: number; synthesis: number }): {
  fetch: FetchLike;
  served: string[];
} {
  const served: string[] = [];
  let busyUntil = 0;
  const fetchImpl: FetchLike = (input, init) =>
    new Promise<Response>((resolve, reject) => {
      const path = new URL(input).pathname;
      const took = path === "/synthesis" ? durations.synthesis : durations.audioQuery;
      // 前の頼みが終わるまで待ってから作る（エンジンの中の行列）
      const startAt = Math.max(Date.now(), busyUntil);
      busyUntil = startAt + took;
      const timer = setTimeout(() => {
        served.push(path);
        resolve(
          path === "/synthesis"
            ? new Response(new Uint8Array(fakeWav(path)), { status: 200 })
            : new Response(JSON.stringify({ accent_phrases: [], speedScale: 1 }), { status: 200 })
        );
      }, busyUntil - Date.now());
      init?.signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(new DOMException("This operation was aborted", "AbortError"));
      });
    });
  return { fetch: fetchImpl, served };
}

/** 答えを返さない偽のエンジン（頼みは受けたまま、いつまでも作り終えない） */
const silentEngine: FetchLike = (_input, init) =>
  new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () =>
      reject(new DOMException("This operation was aborted", "AbortError"))
    );
  });

const params = voiceParamsFor("平静", "中", false, 1);

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("時間切れ・作者の中止・届かないを別の種別にする", () => {
  test("答えが来ないまま待てる時間を過ぎたら timeout（unreachable ではない）", async () => {
    const client = new VoiceEngineClient("http://127.0.0.1:10101", silentEngine, "aivisspeech");
    const failed = client.speakers().catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(31_000);
    const error = await failed;
    expect(error).toBeInstanceOf(VoiceEngineError);
    expect((error as VoiceEngineError).kind).toBe("timeout");
    expect((error as VoiceEngineError).engine).toBe("aivisspeech");
  });

  test("作者の中止は aborted。待てる時間を待たずにすぐ効く", async () => {
    const client = new VoiceEngineClient("http://127.0.0.1:10101", silentEngine, "aivisspeech");
    const controller = new AbortController();
    const failed = client.speak("文", 1, params, controller.signal).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(10);
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    const error = await failed;
    expect((error as VoiceEngineError).kind).toBe("aborted");
  });

  test("接続が断られた（ECONNREFUSED）は unreachable", async () => {
    const refused: FetchLike = () =>
      Promise.reject(
        Object.assign(new TypeError("fetch failed"), {
          cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:10101"), { code: "ECONNREFUSED" }),
        })
      );
    const client = new VoiceEngineClient("http://127.0.0.1:10101", refused, "aivisspeech");
    const error = await client.speakers().catch((e: unknown) => e);
    expect((error as VoiceEngineError).kind).toBe("unreachable");
  });

  test("時間切れの次の操作は、届かないときの「起動して」ではなく、先に作っておく案内（1つ）", () => {
    const step = voiceEngineNextStep(
      new VoiceEngineError("timeout", "待てる時間を過ぎました", undefined, "aivisspeech")
    );
    expect(step).not.toContain("繋がりませんでした");
    expect(step).not.toContain("起動して");
    expect(step).toContain("AivisSpeech");
    expect(step).toContain("［音声に書き出す］");
    // 書き出しの道では、［音声に書き出す］で先に作れとは言わない（いま押しているのがそれ）
    const exportStep = voiceEngineNextStep(
      new VoiceEngineError("timeout", "待てる時間を過ぎました", undefined, "aivisspeech"),
      "export"
    );
    expect(exportStep).not.toContain("先に作って");
    expect(exportStep).toContain("もう一度［音声に書き出す］");
  });
});

describe("遅い PC でも、声づくりを時間切れで止めない", () => {
  test("1文25秒かかるエンジンへ2文を並べて頼んでも、どちらも音ができる（後ろの頼みは50秒待つ）", async () => {
    const engine = serialEngine({ audioQuery: 300, synthesis: 25_000 });
    const client = new VoiceEngineClient("http://127.0.0.1:10101", engine.fetch, "aivisspeech");
    const first = client.speak("一つ目の文です。", 1, params).catch((e: unknown) => e);
    const second = client.speak("二つ目の文です。", 1, params).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await first).toBeInstanceOf(Uint8Array);
    expect(await second).toBeInstanceOf(Uint8Array);
    expect(engine.served.filter((p) => p === "/synthesis")).toHaveLength(2);
  });

  test("1文で30秒を超える長い文も、文の長さに応じて待つ", async () => {
    const engine = serialEngine({ audioQuery: 300, synthesis: 45_000 });
    const client = new VoiceEngineClient("http://127.0.0.1:10101", engine.fetch, "aivisspeech");
    const text = "あ".repeat(120);
    const made = client.speak(text, 1, params).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(50_000);
    expect(await made).toBeInstanceOf(Uint8Array);
  });

  test("並んで待っているあいだの下ごしらえ（audio_query）も、前の声づくりの時間を数えない", async () => {
    // 前の文の声づくりが40秒。後ろの文の audio_query は、その40秒を待ってから作られる
    const engine = serialEngine({ audioQuery: 300, synthesis: 40_000 });
    const client = new VoiceEngineClient("http://127.0.0.1:10101", engine.fetch, "aivisspeech");
    const first = client.speak("あ".repeat(80), 1, params).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(1_000);
    const queued = client.audioQuery("後ろの文。", 1).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(45_000);
    expect(await first).toBeInstanceOf(Uint8Array);
    expect(await queued).not.toBeInstanceOf(Error);
  });

  test("止まったままのエンジンは、いつかは時間切れにする（いつまでも待たない）", async () => {
    const client = new VoiceEngineClient("http://127.0.0.1:10101", silentEngine, "aivisspeech");
    const failed = client.synthesis({ accent_phrases: [] }, 1).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect((await failed as VoiceEngineError).kind).toBe("timeout");
  });
});
