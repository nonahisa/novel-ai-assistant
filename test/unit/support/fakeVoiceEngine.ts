import * as http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * テストの中で立てる、偽の VOICEVOX 互換エンジン（設計書6.42.3）。
 *
 * 本物の AivisSpeech／VOICEVOX はテストで動かさない（落とさない・起動しない）。
 * `/speakers`・`/audio_query`・`/synthesis` の3つの口だけを、本物と同じ形で返す。
 * 受けた頼みは `requests` に残し、テストが「何が送られたか」を見られるようにする。
 */

export interface FakeEngineRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  body: unknown;
}

export interface FakeEngine {
  url: string;
  requests: FakeEngineRequest[];
  close(): Promise<void>;
}

/** AivisSpeech の形に似せた話者の一覧 */
export const FAKE_SPEAKERS = [
  {
    name: "まい",
    speaker_uuid: "uuid-mai",
    styles: [
      { name: "ノーマル", id: 888753760, type: "talk" },
      { name: "上機嫌", id: 888753761, type: "talk" },
      { name: "怒り・悲しみ", id: 888753762, type: "talk" },
    ],
  },
  {
    name: "花音",
    speaker_uuid: "uuid-kanon",
    styles: [
      { name: "ノーマル", id: 1325133120, type: "talk" },
      { name: "ささやき", id: 1325133121, type: "talk" },
      { name: "歌", id: 1325133199, type: "sing" },
    ],
  },
];

/** 合成の答えにする小さな WAV（頭は RIFF） */
export function fakeWav(tag: string): Buffer {
  const header = Buffer.from("RIFF0000WAVEfmt ", "latin1");
  return Buffer.concat([header, Buffer.from(tag, "utf8")]);
}

/**
 * 本物の形の WAV（16bit PCM・RIFF の塊を並べたもの）。音の書き出し（設計書6.42.4）を
 * 試すために、**MP3 へ変換できる本物の音**が要る（`fakeWav` は頭だけ RIFF の作り物）。
 *
 * `LIST` の塊を `data` の前に置く——本物のエンジンにも 44バイト固定でない WAV があり、
 * 読み手が塊を歩かずに 44バイト目から読むと壊れる（その見逃しを試験で止める）。
 */
export function pcmWav(
  options: { sampleRate?: number; channels?: number; ms?: number; hz?: number } = {}
): Buffer {
  const sampleRate = options.sampleRate ?? 24000;
  const channels = options.channels ?? 1;
  const frames = Math.round((sampleRate * (options.ms ?? 200)) / 1000);
  const hz = options.hz ?? 440;
  const data = Buffer.alloc(frames * channels * 2);
  for (let i = 0; i < frames; i++) {
    const value = Math.round(Math.sin((2 * Math.PI * hz * i) / sampleRate) * 8000);
    for (let c = 0; c < channels; c++) data.writeInt16LE(value, (i * channels + c) * 2);
  }
  const fmt = Buffer.alloc(16);
  fmt.writeUInt16LE(1, 0); // PCM
  fmt.writeUInt16LE(channels, 2);
  fmt.writeUInt32LE(sampleRate, 4);
  fmt.writeUInt32LE(sampleRate * channels * 2, 8);
  fmt.writeUInt16LE(channels * 2, 12);
  fmt.writeUInt16LE(16, 14);
  const chunk = (id: string, body: Buffer): Buffer => {
    const head = Buffer.alloc(8);
    head.write(id, 0, "latin1");
    head.writeUInt32LE(body.length, 4);
    // 塊の長さが奇数なら1バイト詰める（RIFF の決まり）
    return Buffer.concat([head, body, body.length % 2 === 1 ? Buffer.alloc(1) : Buffer.alloc(0)]);
  };
  const body = Buffer.concat([
    Buffer.from("WAVE", "latin1"),
    chunk("fmt ", fmt),
    chunk("LIST", Buffer.from("INFOISFT\u0005\u0000\u0000\u0000fake\u0000\u0000", "latin1")),
    chunk("data", data),
  ]);
  const riff = Buffer.alloc(8);
  riff.write("RIFF", 0, "latin1");
  riff.writeUInt32LE(body.length, 4);
  return Buffer.concat([riff, body]);
}

/** 偽のエンジンの「どのエンジンのふりをするか」と、ライセンス・規約の答え */
export interface FakeEngineTerms {
  /** `/engine_manifest` の `brand_name`。undefined なら `/engine_manifest` は 404 */
  brand?: string;
  /** `/aivm_models` の答え（AivisSpeech のふりのとき） */
  aivmModels?: unknown;
  /** 話者の uuid → `/speaker_info` の `policy` */
  policies?: Record<string, string>;
}

/** ACML 1.0 の全文の頭（作者の4つのモデルと同じ見出し。中身は試験用の短い写し） */
export const FAKE_ACML_TEXT =
  "# Aivis Common Model License (ACML) 1.0\n\n本モデルは営利・非営利を問わず利用できます（試験用の写し）。\n";

/** 非商用の ACML の全文の頭（試験用。見出しの形は ACML 1.0 に倣った仮のもの） */
export const FAKE_ACML_NC_TEXT =
  "# Aivis Common Model License - Non Commercial (ACML-NC) 1.0\n\n非営利の目的に限り利用できます（試験用の写し）。\n";

/** `FAKE_SPEAKERS` の2人を、それぞれ別のモデルとして返す `/aivm_models` */
export function fakeAivmModels(licenses: { mai?: string | null; kanon?: string | null }): unknown {
  const model = (uuid: string, name: string, speaker: string, license: string | null | undefined) => ({
    is_loaded: true,
    manifest: {
      manifest_version: "1.0",
      name,
      creators: [`${name}の制作者`],
      license: license ?? null,
      uuid,
      speakers: [{ name: speaker, uuid: `uuid-${speaker === "まい" ? "mai" : "kanon"}`, styles: [] }],
    },
  });
  return {
    "model-mai": model("model-mai", "まいモデル", "まい", licenses.mai),
    "model-kanon": model("model-kanon", "花音モデル", "花音", licenses.kanon),
  };
}

export async function startFakeVoiceEngine(
  options: {
    failSynthesis?: boolean;
    /** 合成の答えを本物の形の WAV にする（MP3 へ変換する試験のため） */
    pcm?: boolean;
    terms?: FakeEngineTerms;
    /** 合成の答えを返す前に待つ（中止の試験のため） */
    synthesisDelayMs?: number;
  } = {}
): Promise<FakeEngine> {
  const requests: FakeEngineRequest[] = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body: unknown = undefined;
      if (raw !== "") {
        try {
          body = JSON.parse(raw);
        } catch {
          body = raw;
        }
      }
      requests.push({
        method: req.method ?? "",
        path: url.pathname,
        query: Object.fromEntries(url.searchParams.entries()),
        body,
      });
      if (url.pathname === "/speakers" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(FAKE_SPEAKERS));
        return;
      }
      if (url.pathname === "/audio_query" && req.method === "POST") {
        res.writeHead(200, { "Content-Type": "application/json" });
        // 本物の答えに似せる（調子の欄と、こちらが触らない欄）
        res.end(
          JSON.stringify({
            accent_phrases: [{ text: url.searchParams.get("text") }],
            speedScale: 1,
            pitchScale: 0,
            intonationScale: 1,
            volumeScale: 1,
            prePhonemeLength: 0.1,
            postPhonemeLength: 0.1,
            outputSamplingRate: 44100,
            outputStereo: false,
            kana: "テスト",
          })
        );
        return;
      }
      if (url.pathname === "/synthesis" && req.method === "POST") {
        if (options.failSynthesis) {
          res.writeHead(422, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ detail: "合成できません（偽のエンジン）" }));
          return;
        }
        const answer = (): void => {
          res.writeHead(200, { "Content-Type": "audio/wav" });
          res.end(options.pcm ? pcmWav() : fakeWav(`${url.searchParams.get("speaker")}`));
        };
        if (options.synthesisDelayMs) setTimeout(answer, options.synthesisDelayMs);
        else answer();
        return;
      }
      const terms = options.terms;
      if (url.pathname === "/engine_manifest" && req.method === "GET" && terms?.brand) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({ manifest_version: "0.13.1", name: `${terms.brand} Engine`, brand_name: terms.brand })
        );
        return;
      }
      if (url.pathname === "/aivm_models" && req.method === "GET" && terms?.aivmModels) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(terms.aivmModels));
        return;
      }
      if (url.pathname === "/speaker_info" && req.method === "GET" && terms) {
        const policy = terms.policies?.[url.searchParams.get("speaker_uuid") ?? ""];
        if (policy === undefined) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ detail: "話者が見つかりません（偽のエンジン）" }));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ policy, portrait: "", style_infos: [] }));
        return;
      }
      res.writeHead(404);
      res.end("not found");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
