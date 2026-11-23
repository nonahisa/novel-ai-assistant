/**
 * 作り物の llama.cpp の server（llama-server）。画面の自動テストが「LM Studio の欄で llama-server を
 * つなぐ」道（設計書6.24。作者の決定 2026-11-23「llama.cpp を製品を直して正式に」）を見るための口。
 *
 * **本物の AI は呼ばない。** 127.0.0.1 の空いている口で小さな HTTP サーバーを立て、
 * 本物の llama-server b12647 で取った形（2026-11-23）をそのまま返す。
 * - `GET /api/v0/models` → 404（LM Studio の自前の口は無い。製品はここで llama-server の口へ回る）
 * - `GET /v1/models` → `meta`（`n_params`・`n_ctx` など）つきのモデル1件
 * - `GET /props` → スロットあたりの長さと別名
 * - `POST /v1/chat/completions` → 受けた本文を丸ごと記録し、OpenAI 互換の答えを返す
 *
 * 行き先は VS Code の設定 `novelai.lmstudio.endpoint`（`<endpoint>/v1`）で一時的に向ける。
 * 使い捨ての user-data の中だけで、作者の LM Studio・llama-server には触れない。
 * 偽の Ollama（`fakeOllama.ts`）と同じく、見えるのは「答えが返ったあとの配線と画面」だけ。
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/** 本物の llama-server（`--alias gemma4:26b`）が名乗るモデル名 */
export const FAKE_LLAMA_MODEL = "gemma4:26b";

/** `/v1/models` の答え（本物の b12647 の実測そのまま） */
const MODELS_BODY = {
  data: [
    {
      id: FAKE_LLAMA_MODEL,
      meta: {
        vocab_type: 2,
        n_vocab: 262144,
        n_ctx: 8192,
        n_ctx_train: 262144,
        n_embd: 2816,
        n_params: 25233142046,
        size: 16931716216,
        ftype: "Q4_K - Medium",
      },
    },
  ],
};

/** `/props` の答え（使う項目だけ。本物はもっと多い） */
const PROPS_BODY = { default_generation_settings: { n_ctx: 8192 }, model_alias: FAKE_LLAMA_MODEL };

/** `/api/v0/models` の答え（本物の 404 の本文そのまま） */
const NOT_FOUND_BODY = { error: { message: "File Not Found", type: "not_found_error", code: 404 } };

/** 受けた `/v1/chat/completions` の本文（読めた JSON をそのまま持つ） */
export type FakeLlamaChatBody = Record<string, unknown>;

export interface FakeLlamaServer {
  /** `http://127.0.0.1:<port>`（`/v1` は付けない。設定へ入れるときに足す） */
  origin: string;
  /** 受けた `/v1/chat/completions` の本文（古い順） */
  chatBodies: FakeLlamaChatBody[];
  /** 受けた頼みの「方法 道」（古い順）。落ちたときの文に添える */
  hits: string[];
  close(): Promise<void>;
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * 作り物の llama-server を立てる。`respond` が `/v1/chat/completions` の答えの本文（content）を返す。
 * 構造化出力（`response_format`）を求められた呼び出しには、その機能のスキーマに合う JSON の文字列を返すこと
 */
export async function startFakeLlamaServer(respond: (body: FakeLlamaChatBody) => string): Promise<FakeLlamaServer> {
  const chatBodies: FakeLlamaChatBody[] = [];
  const hits: string[] = [];
  const server: Server = createServer((request, response) => {
    void (async () => {
      const url = (request.url ?? "/").split("?")[0];
      const method = request.method ?? "GET";
      hits.push(`${method} ${url}`);
      const sendJson = (status: number, value: unknown): void => {
        response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
        response.end(JSON.stringify(value));
      };
      if (method === "GET" && url === "/v1/models") {
        sendJson(200, MODELS_BODY);
        return;
      }
      if (method === "GET" && url === "/props") {
        sendJson(200, PROPS_BODY);
        return;
      }
      if (method === "POST" && url === "/v1/chat/completions") {
        const body = JSON.parse(await readBody(request)) as FakeLlamaChatBody;
        chatBodies.push(body);
        const content = respond(body);
        // 送られた字数を大まかに数える（製品は usage を記録に使うだけなので、目安でよい）
        const messages = Array.isArray(body.messages) ? (body.messages as Array<{ content?: unknown }>) : [];
        const sentChars = messages.reduce((sum, message) => sum + (typeof message.content === "string" ? message.content.length : 0), 0);
        sendJson(200, {
          choices: [{ message: { content }, finish_reason: "stop" }],
          usage: { prompt_tokens: Math.max(1, sentChars), completion_tokens: Math.max(1, content.length) },
        });
        return;
      }
      // `/api/v0/models` を含め、llama-server に無い道は本物と同じ 404 で返す
      sendJson(404, NOT_FOUND_BODY);
    })().catch(() => {
      response.writeHead(500);
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    origin: `http://127.0.0.1:${port}`,
    chatBodies,
    hits,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
