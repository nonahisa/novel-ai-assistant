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

export async function startFakeVoiceEngine(
  options: { failSynthesis?: boolean } = {}
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
        res.writeHead(200, { "Content-Type": "audio/wav" });
        res.end(fakeWav(`${url.searchParams.get("speaker")}`));
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
