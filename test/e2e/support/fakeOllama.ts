/**
 * 偽の Ollama（画面の自動テストが「AI の答えが出たあとの画面」を見るための口。設計書6.113）。
 *
 * **本物の AI は呼ばない。** 127.0.0.1 の空いている口で小さな HTTP サーバーを立て、
 * Ollama と同じ形（`/api/tags`・`/api/show`・`/api/chat`）で、テストが決めた答えを返す。
 * 作者の画面・作者の Ollama には触れない（行き先は VS Code の設定 `novelai.ollama.endpoint`
 * で一時的に向ける。使い捨ての user-data の中だけ）。
 *
 * 見られるのは「答えが返ったあとの配線と画面」だけで、**答えの出来（見逃し・誤検出）は
 * 見えない**——それは実機の AI での測定（`→〔AIの測定〕`）の仕事。
 *
 * 使い方：
 *   const fake = await startFakeOllama((request) => "答えの文");
 *   withVsCode(..., body, { ...FAKE_OLLAMA_LAUNCH(fake) });
 *   await fake.close();
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Page } from "playwright-core";
import type { LaunchOptions } from "./vscodeApp";
import { dialogText, pressDialogButton } from "./workbenchDom";

/** 偽のモデル名（作者のモデルと取り違えない名前にする） */
export const FAKE_OLLAMA_MODEL = "e2e-fake:1b";

export interface FakeOllamaRequest {
  /** system の発言（無ければ空） */
  system: string;
  /** 最後の user の発言 */
  user: string;
  /** `format` に JSON スキーマが渡されたか（構造化出力を求められた呼び出しか） */
  structured: boolean;
}

export interface FakeOllama {
  /** `http://127.0.0.1:<port>` */
  endpoint: string;
  /** 受けた `/api/chat` の中身（古い順）。何が送られたかを確かめるのに使う */
  requests: FakeOllamaRequest[];
  close(): Promise<void>;
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * 偽の Ollama を立てる。`respond` が `/api/chat` の答え（本文）を返す。
 * 構造化出力を求められた呼び出し（`structured`）には JSON の文字列を返すこと
 */
export async function startFakeOllama(respond: (request: FakeOllamaRequest) => string): Promise<FakeOllama> {
  const requests: FakeOllamaRequest[] = [];
  const server: Server = createServer((request, response) => {
    void (async () => {
      const url = request.url ?? "/";
      const sendJson = (value: unknown): void => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(value));
      };
      if (url.startsWith("/api/tags")) {
        sendJson({
          models: [
            {
              name: FAKE_OLLAMA_MODEL,
              size: 1_000_000,
              details: { parameter_size: "1B", quantization_level: "Q4_0" },
              capabilities: ["completion"],
            },
          ],
        });
        return;
      }
      if (url.startsWith("/api/show")) {
        sendJson({
          capabilities: ["completion"],
          details: { parameter_size: "1B" },
          model_info: { "fake.context_length": 32768 },
        });
        return;
      }
      if (url.startsWith("/api/chat")) {
        const body = JSON.parse(await readBody(request)) as {
          messages?: Array<{ role: string; content: string }>;
          stream?: boolean;
          format?: unknown;
        };
        const messages = body.messages ?? [];
        const system = messages.find((message) => message.role === "system")?.content ?? "";
        const user = [...messages].reverse().find((message) => message.role === "user")?.content ?? "";
        const parsed: FakeOllamaRequest = { system, user, structured: body.format !== undefined };
        requests.push(parsed);
        const text = respond(parsed);
        const tail = { model: FAKE_OLLAMA_MODEL, done: true, done_reason: "stop", prompt_eval_count: 10, eval_count: 10 };
        if (body.stream === true) {
          response.writeHead(200, { "content-type": "application/x-ndjson" });
          response.write(JSON.stringify({ model: FAKE_OLLAMA_MODEL, message: { role: "assistant", content: text }, done: false }) + "\n");
          response.end(JSON.stringify({ ...tail, message: { role: "assistant", content: "" } }) + "\n");
        } else {
          sendJson({ ...tail, message: { role: "assistant", content: text } });
        }
        return;
      }
      // 版の問い合わせ・生存確認など、そのほかは「動いている」とだけ答える
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("Ollama is running");
    })().catch(() => {
      response.writeHead(500);
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    endpoint: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/**
 * 「手元のAIへ送る前に確かめてください」の確認が出ていれば［このまま送る］で進める。
 *
 * **これは製品の関所（`features/localAiGate.ts`）で、この機械の GPU の使用率が高いと
 * 実際に出る**（2026-10-09、別の用で GPU が 98% のとき相談の送信で出た）。偽の Ollama でも
 * 手元のAI扱いなので同じ関所を通る。出る・出ないは機械の状態しだいなので、
 * 待つ側（`waitUntil` の条件の中）から呼んで、出ていたら通す。出ていなければ何もしない
 */
export async function passLocalAiGate(page: Page): Promise<void> {
  const text = await dialogText(page);
  if (text === undefined || !text.includes("手元のAIへ送る前に確かめてください")) return;
  await pressDialogButton(page, "このまま送る").catch(() => undefined);
}

/** 偽の Ollama を使う件が `withVsCode` の起こし方へ足すもの（AI の選択と行き先） */
export function fakeOllamaLaunch(fake: FakeOllama, extra: LaunchOptions = {}): LaunchOptions {
  return {
    ...extra,
    globalState: {
      "novelai.ai.provider": "ollama",
      "novelai.ai.model": FAKE_OLLAMA_MODEL,
      ...extra.globalState,
    },
    settings: {
      "novelai.ollama.endpoint": fake.endpoint,
      ...extra.settings,
    },
  };
}
