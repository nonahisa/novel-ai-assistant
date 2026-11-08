/**
 * 偽の音声合成エンジン（AivisSpeech・VOICEVOX と同じ口の形。画面の自動テストが「人物の声」の配線を見るための口。
 * 設計書6.42.3・6.42.4・6.113）。
 *
 * **本物のエンジンは起こさない。** 127.0.0.1 の空いている口で小さな HTTP サーバーを立て、`/speakers`・
 * `/audio_query`・`/synthesis`・`/engine_manifest`（名乗り）・`/aivm_models`・`/speaker_info`（ライセンスと規約）を
 * テストが決めた形で返す。話者の一覧・WAV・ライセンスの見本は単体テストの偽のエンジン
 * （`test/unit/support/fakeVoiceEngine.ts`）と同じものを使う（見本を二重に持たない）。
 * 行き先は VS Code の設定 `novelai.readAloud.aivisSpeechUrl`・`novelai.readAloud.voicevoxUrl` で一時的に向ける
 * （使い捨ての user-data の中だけ。`voiceEngineSettings`）。127.0.0.1 なので、外のホストへ送る確認の窓は出ない。
 *
 * 単体テストの偽のエンジンとの違いは1つ：**合成を1つずつ順に返す**（`synthesisDelayMs` を付けたとき）。
 * 本物のエンジンは1文ずつ作るので、2つ並べて頼むと後の頼みは前の音ができるまで待つ。製品の速さの見張り
 * （`features/voiceReading.ts` の `synthesize`）はその待ちを数えない作りなので、並べて同時に返すと
 * 2つ目が「速い」と数えられ、遅いエンジンを写せない。
 *
 * 見られるのは「エンジンの答えが返ったあとの配線と画面」だけで、**声が自然か・読み分けて聞こえるかは
 * 見えない**——それは作者の耳の仕事。
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { FAKE_SPEAKERS, pcmWav, type FakeEngineTerms } from "../../unit/support/fakeVoiceEngine";

export { FAKE_ACML_TEXT, FAKE_SPEAKERS, fakeAivmModels } from "../../unit/support/fakeVoiceEngine";

export interface FakeVoiceRequest {
  method: string;
  path: string;
  /** `/audio_query`・`/synthesis` の `text`（無ければ空） */
  text: string;
  /** `speaker` の番号（無ければ空） */
  speaker: string;
}

export interface FakeVoiceEngine {
  /** `http://127.0.0.1:<port>` */
  url: string;
  /** `127.0.0.1:<port>`（製品が窓に出す宛先の形） */
  host: string;
  /** 受けた頼み（古い順） */
  requests: FakeVoiceRequest[];
  close(): Promise<void>;
}

export interface FakeVoiceEngineOptions {
  /** `/engine_manifest` の `brand_name`（既定 AivisSpeech）。書き出しは［声］のエンジンと名乗りが違えば止まる */
  brand?: "AivisSpeech" | "VOICEVOX";
  /** ライセンス・規約の答え（書き出しの件だけが要る）。`brand` はこちらでは見ない */
  terms?: Omit<FakeEngineTerms, "brand">;
  /** 1文の音の長さ（ミリ秒。既定 200） */
  wavMs?: number;
  /** 1文を作るのにかかる時間（ミリ秒）。付けると合成を1つずつ順に返す（頭のコメント） */
  synthesisDelayMs?: number;
}

/** 偽のエンジンを立てる */
export async function startFakeVoiceEngine(options: FakeVoiceEngineOptions = {}): Promise<FakeVoiceEngine> {
  const requests: FakeVoiceRequest[] = [];
  const brand = options.brand ?? "AivisSpeech";
  const wav = pcmWav({ ms: options.wavMs ?? 200 });
  /** 合成の順番待ち（前の音ができてから次を作り始める） */
  let synthesisQueue: Promise<void> = Promise.resolve();

  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    // 本文は送られた分だけ控える（中身を外へは出さない。一時のこの試験の中だけ）
    request.resume();
    request.on("end", () => {
      requests.push({
        method: request.method ?? "",
        path: url.pathname,
        text: url.searchParams.get("text") ?? "",
        speaker: url.searchParams.get("speaker") ?? "",
      });
      const json = (body: unknown, status = 200): void => {
        response.writeHead(status, { "Content-Type": "application/json" });
        response.end(JSON.stringify(body));
      };
      if (url.pathname === "/speakers") return json(FAKE_SPEAKERS);
      if (url.pathname === "/engine_manifest") {
        return json({ manifest_version: "0.13.1", name: `${brand} Engine`, brand_name: brand });
      }
      if (url.pathname === "/audio_query") {
        return json({
          accent_phrases: [],
          speedScale: 1,
          pitchScale: 0,
          intonationScale: 1,
          volumeScale: 1,
          prePhonemeLength: 0.1,
          postPhonemeLength: 0.1,
          outputSamplingRate: 24000,
          outputStereo: false,
          kana: "テスト",
        });
      }
      if (url.pathname === "/synthesis") {
        const answer = (): void => {
          response.writeHead(200, { "Content-Type": "audio/wav" });
          response.end(wav);
        };
        const delay = options.synthesisDelayMs;
        if (!delay) return answer();
        synthesisQueue = synthesisQueue.then(
          () =>
            new Promise<void>((resolve) =>
              setTimeout(() => {
                answer();
                resolve();
              }, delay)
            )
        );
        return;
      }
      const terms = options.terms;
      if (url.pathname === "/aivm_models" && terms?.aivmModels) return json(terms.aivmModels);
      if (url.pathname === "/speaker_info" && terms) {
        const policy = terms.policies?.[url.searchParams.get("speaker_uuid") ?? ""];
        if (policy === undefined) return json({ detail: "話者が見つかりません（偽のエンジン）" }, 404);
        return json({ policy, portrait: "", style_infos: [] });
      }
      response.writeHead(404);
      response.end("not found");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    host: `127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/**
 * 「エンジンが閉じている」接続先（いったん待ち受けて閉じた口）。製品の既定の口（10101・50021）を使わないのは、
 * テストを流す機械で本物の AivisSpeech・VOICEVOX が動いていると、閉じているつもりが繋がってしまうため
 */
export async function closedEngineUrl(): Promise<string> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return `http://127.0.0.1:${port}`;
}

/** 使い捨ての settings.json へ足す、エンジンごとの接続先（`LaunchOptions.settings`） */
export function voiceEngineSettings(urls: { aivisspeech: string; voicevox: string }): Record<string, string> {
  return {
    "novelai.readAloud.aivisSpeechUrl": urls.aivisspeech,
    "novelai.readAloud.voicevoxUrl": urls.voicevox,
  };
}

/** 本文を運ぶ頼み（`/audio_query`・`/synthesis`）だけ。`/speakers`・名乗りは本文を運ばない */
export function textCarrying(engine: FakeVoiceEngine, since = 0): FakeVoiceRequest[] {
  return engine.requests.slice(since).filter((request) => request.path === "/audio_query" || request.path === "/synthesis");
}

/** 落ちた文に添える、受けた頼みの短い控え */
export function describeVoiceRequests(engine: FakeVoiceEngine, since = 0): string {
  return JSON.stringify(engine.requests.slice(since).slice(-10).map((request) => `${request.path}${request.text ? `:${request.text.slice(0, 12)}` : ""}${request.speaker ? `#${request.speaker}` : ""}`));
}
