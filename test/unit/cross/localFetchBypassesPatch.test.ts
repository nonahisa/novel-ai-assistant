import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * **手元のAI（Ollama・LM Studio）への通信は、VS Code が差し替えた
 * `globalThis.fetch` を通らない**（設計書6.63。2026-09-23）。
 *
 * ## 何が起きていたか
 *
 * VS Code（1.138 で確認）は、拡張機能の中の `globalThis.fetch` を
 * `@vscode/proxy-agent` の `createFetchPatch` で差し替えている。証明書を
 * 足す設定（既定で入）が効いていると、差し替えた fetch は `init.dispatcher` を
 * **自分で作る新しい `undici.Agent` に置き換える**——こちらが渡した
 * `headersTimeout`/`bodyTimeout` は捨てられ、既定の300秒に戻る。
 *
 * ノートPCの実測（VS Code 1.138.0、310秒黙る模擬サーバー、同じ Agent）：
 * `globalThis.fetch`＋Agent は306秒で `UND_ERR_HEADERS_TIMEOUT`、
 * npm の `undici` の `fetch`＋同じ Agent は311秒で 200。
 *
 * **「dispatcher を渡しているか」を字面で見る網は、これを見逃した。**
 * 渡してはいたのである。捨てられていただけで。だからここでは、
 * **差し替えを真似た偽の `globalThis.fetch` を置いて、実際に呼ぶ**。
 *
 * ## 見ること
 *
 * - 手元のAIの呼び出しは、偽の差し替えを**通らない**（npm の undici の
 *   fetch を通る）。そして**その呼び出しの待ち時間で作った役が届く**
 * - クラウドの呼び出しは、偽の差し替えを**通る**（VS Code のプロキシと
 *   社内証明書の対応を失わない）
 * - ブラウザ版（undici が無い）では、手元のAIも `globalThis.fetch` へ落ちる
 *
 * 宛先は本物の HTTP サーバー（この試験の中で立てる）。応答を undici の
 * `Response` として読み切れること（流す道の `getReader()` を含む）も
 * これで確かめられる。
 */

interface UndiciCall {
  url: string;
  dispatcher: unknown;
}

// `vi.mock` は先頭へ巻き上げられるので、中で使う入れ物も一緒に巻き上げる
const { undiciCalls, webFlag } = vi.hoisted(() => ({
  undiciCalls: [] as UndiciCall[],
  webFlag: { on: false },
}));

/*
  npm の undici の fetch を、**本物のまま**記録だけ挟む。
  中身を差し替えないのは、undici の Response を製品の読み方
  （`json()`・`text()`・`body.getReader()`）で読み切れるかも見たいため。
*/
vi.mock("undici", async (importOriginal) => {
  const actual = await importOriginal<typeof import("undici")>();
  return {
    ...actual,
    fetch: (async (input: Parameters<typeof actual.fetch>[0], init?: Parameters<typeof actual.fetch>[1]) => {
      undiciCalls.push({
        url: String(input),
        dispatcher: (init as { dispatcher?: unknown } | undefined)?.dispatcher,
      });
      return actual.fetch(input, init);
    }) as typeof actual.fetch,
  };
});

/** ブラウザ版のふりをするときだけ、処理を起こせない側へ倒す */
vi.mock("../../../src/core/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/core/runtime")>();
  return {
    ...actual,
    canRunProcesses: () => !webFlag.on && actual.canRunProcesses(),
  };
});

import { Agent } from "undici";
import { OllamaProvider } from "../../../src/ai/ollamaProvider";
import { OllamaEmbeddingProvider } from "../../../src/ai/ollamaEmbedding";
import { LmStudioProvider } from "../../../src/ai/lmstudioProvider";
import { setStreamingSettingReader } from "../../../src/ai/ollamaStream";
import { fetchJson, isFetchTimeout } from "../../../src/ai/httpClient";
import * as fetchTimeouts from "../../../src/ai/fetchTimeouts";
import { ollamaGenerate, MCP_OLLAMA_WAIT_MS } from "../../../src/mcp/tools/ollama";
import { workspace } from "../support/vscodeStub";

/** 作者の設定：Ollama の待ち時間を900秒へ延ばしてある（ノートPCと同じ） */
const CONFIGURED_SECONDS = 900;

/**
 * `/slow` が応答の頭を返すまで黙る長さ。
 *
 * **undici の頭待ちの時計は刻みが約1秒**（`setFastTimeout`）なので、0.2秒を
 * 頼んでも切れるのは約1秒後になる。1.5秒だと差が0.5秒しかなく、重い機械
 * では揺れうる（統合テスト `src/test/fetchPatch.ts` の実測、2026-09-23）
 */
const SLOW_HEADERS_MS = 3000;
/** `/slow` を使う試験の制限時間。既定の5秒だと黙る長さに近すぎる */
const SLOW_TEST_TIMEOUT_MS = 15_000;
/** `/slow` へ投げるときの待ち時間。黙る長さより短くして、切れるかを見る */
const SHORT_WAIT_MS = 200;

interface PatchedCall {
  url: string;
  /** 呼んだ側が dispatcher を渡していたか（渡しても捨てられる） */
  hadDispatcher: boolean;
}

let server: http.Server;
let base = "";
const received: string[] = [];
const patchedCalls: PatchedCall[] = [];
const realFetch = globalThis.fetch;
const originalGetConfiguration = workspace.getConfiguration;

/**
 * VS Code の `createFetchPatch` の振る舞いを写した偽物。
 *
 * **こちらの dispatcher を捨て、自分で作った Agent（待ち時間は既定）に
 * 置き換えてから本物の fetch へ渡す。** 実物は証明書を足すために
 * `new undici.Agent({ allowH2, connect: { ca } })` を作る。
 */
async function vscodeLikePatchedFetch(
  input: Parameters<typeof fetch>[0],
  init?: RequestInit
): Promise<Response> {
  const { dispatcher, ...rest } = (init ?? {}) as RequestInit & { dispatcher?: unknown };
  patchedCalls.push({ url: String(input), hadDispatcher: dispatcher !== undefined });
  return realFetch(input, { ...rest, dispatcher: new Agent({}) } as unknown as RequestInit);
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    void (async () => {
      const text = await readBody(req);
      const url = req.url ?? "";
      received.push(url);
      const json = (value: unknown) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(value));
      };
      if (url === "/api/chat") {
        const body = JSON.parse(text) as { stream?: boolean };
        if (body.stream) {
          res.writeHead(200, { "Content-Type": "application/x-ndjson" });
          res.end(
            '{"message":{"content":"はい"},"done":false}\n{"done":true,"done_reason":"stop"}\n'
          );
          return;
        }
        json({ message: { content: "はい" }, done_reason: "stop" });
        return;
      }
      if (url === "/api/embed") {
        json({ embeddings: [[0.1, 0.2]] });
        return;
      }
      if (url === "/v1/chat/completions") {
        json({
          choices: [{ message: { content: "はい" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        });
        return;
      }
      if (url === "/slow") {
        // 応答の頭を返すまで黙る（CPUだけの機械で長い本文を読む Ollama の真似）
        await new Promise((r) => setTimeout(r, SLOW_HEADERS_MS));
        json({ ok: true });
        return;
      }
      if (url === "/cloud") {
        json({ ok: true });
        return;
      }
      res.writeHead(404);
      res.end("not found");
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  undiciCalls.length = 0;
  patchedCalls.length = 0;
  received.length = 0;
  webFlag.on = false;
  fetchTimeouts.clearDispatcherCache();
  vi.stubGlobal("fetch", vscodeLikePatchedFetch);
  workspace.getConfiguration = () => ({
    get: <T>(key: string, defaultValue: T): T => {
      if (key === "ollama.endpoint") return base as T;
      if (key === "lmstudio.endpoint") return `${base}/v1` as T;
      if (key === "ollama.timeoutSeconds") return CONFIGURED_SECONDS as T;
      return defaultValue;
    },
  });
  // 単体テストの下ごしらえ（`support/setup.ts`）は手元の口を
  // `globalThis.fetch` へ回している。**この試験だけは製品の道で見る**
  fetchTimeouts.setLocalFetchForTests(undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  setStreamingSettingReader(undefined);
  workspace.getConfiguration = originalGetConfiguration;
});

const params = {
  systemPrompt: "system",
  userPrompt: "user",
  model: "gemma4:e2b",
  temperature: 0.2,
  numCtx: 16384,
};

describe("手元のAIは、VS Code の差し替えた fetch を通らず、こちらの待ち時間を届ける", () => {
  test("Ollama・まとめて受け取る道（ノートPCが踏んだ道）", async () => {
    setStreamingSettingReader(() => false);
    const result = await new OllamaProvider().generate(params);

    expect(result.text).toBe("はい");
    expect(patchedCalls).toEqual([]);
    expect(undiciCalls.map((c) => c.url)).toEqual([`${base}/api/chat`]);
    expect(undiciCalls[0]?.dispatcher).toBe(
      await fetchTimeouts.timeoutDispatcher(CONFIGURED_SECONDS * 1000)
    );
  });

  test("Ollama・流す道（本文を読み終えるまで頭が来ないので、ここも要る）", async () => {
    setStreamingSettingReader(() => true);
    const result = await new OllamaProvider().generate(params);

    // undici の Response を getReader() で読み切れている
    expect(result.text).toBe("はい");
    expect(patchedCalls).toEqual([]);
    expect(undiciCalls.map((c) => c.url)).toEqual([`${base}/api/chat`]);
    expect(undiciCalls[0]?.dispatcher).toBe(
      await fetchTimeouts.timeoutDispatcher(CONFIGURED_SECONDS * 1000)
    );
  });

  test("Ollama・埋め込み（/api/embed）", async () => {
    const vectors = await new OllamaEmbeddingProvider("bge-m3").embed(["あ"]);

    expect(vectors).toHaveLength(1);
    expect(patchedCalls).toEqual([]);
    expect(undiciCalls.map((c) => c.url)).toEqual([`${base}/api/embed`]);
    // 埋め込みが自分で決めている待ち時間（`ollamaEmbedding.ts` の120秒）で作った役
    expect(undiciCalls[0]?.dispatcher).toBe(await fetchTimeouts.timeoutDispatcher(120_000));
  });

  test("MCP の ollama.generate（自前の打ち切りが無いので、長めの上限を渡す）", async () => {
    const result = await ollamaGenerate({
      ...params,
      endpoint: base,
      numCtx: 4096,
      temperature: 0,
    });

    expect(result.text).toBe("はい");
    expect(patchedCalls).toEqual([]);
    expect(undiciCalls.map((c) => c.url)).toEqual([`${base}/api/chat`]);
    expect(undiciCalls[0]?.dispatcher).toBe(
      await fetchTimeouts.timeoutDispatcher(MCP_OLLAMA_WAIT_MS)
    );
    // 製品で作者が選びうる長さ（台帳で1800秒の実例）より短くしない
    expect(MCP_OLLAMA_WAIT_MS).toBeGreaterThanOrEqual(1800 * 1000);
  });

  test("LM Studio の生成（/v1/chat/completions）", async () => {
    const result = await new LmStudioProvider().generate(params);

    expect(result.text).toBe("はい");
    expect(patchedCalls).toEqual([]);
    expect(undiciCalls.map((c) => c.url)).toEqual([`${base}/v1/chat/completions`]);
    expect(undiciCalls[0]?.dispatcher).toBeInstanceOf(Agent);
  });
});

/*
  **渡したかではなく、効いたかを見る。** 待ち受け役の `headersTimeout` を
  短くして、黙る相手へ投げる。手元の口ではこちらの長さで切れ、
  差し替えを通る口では（役を捨てられて既定の300秒に戻るので）切れない。
  ノートPCの実測（306秒で切れる／311秒で届く）を、短い長さで写したもの。
*/
describe("手元の口では、こちらの待ち時間が本当に効く", () => {
  test("localFetch：頭を待つ上限がこちらの長さで効き、Node の待ち時間切れになる", async () => {
    const failure = await fetchTimeouts
      .localFetch(`${base}/slow`, { method: "GET" }, SHORT_WAIT_MS)
      .then(
        () => undefined,
        (error: unknown) => error
      );

    expect(isFetchTimeout(failure)).toBe(true);
    expect(patchedCalls).toEqual([]);
  }, SLOW_TEST_TIMEOUT_MS);

  test("cloudFetch：差し替えを通ると、渡した上限は捨てられて届いてしまう", async () => {
    const response = await fetchTimeouts.cloudFetch(
      `${base}/slow`,
      { method: "GET" },
      SHORT_WAIT_MS
    );

    expect(response.status).toBe(200);
    // 渡してはいた。捨てられただけ——字面の網が見逃した形
    expect(patchedCalls).toEqual([{ url: `${base}/slow`, hadDispatcher: true }]);
  }, SLOW_TEST_TIMEOUT_MS);
});

describe("クラウドのAIは、VS Code の fetch を通る（プロキシと社内証明書を保つ）", () => {
  test("手元の印を付けない fetchJson は、差し替えた fetch を通る", async () => {
    const result = await fetchJson<{ ok: boolean }>({
      url: `${base}/cloud`,
      timeoutMs: 5000,
      label: "Gemini",
    });

    expect(result.ok).toBe(true);
    expect(undiciCalls).toEqual([]);
    expect(patchedCalls.map((c) => c.url)).toEqual([`${base}/cloud`]);
  });
});

describe("ブラウザ版（undici が無い）では、手元のAIも globalThis.fetch へ落ちる", () => {
  test("Ollama の生成は、ブラウザの fetch で届く", async () => {
    webFlag.on = true;
    setStreamingSettingReader(() => false);
    const result = await new OllamaProvider().generate(params);

    expect(result.text).toBe("はい");
    expect(undiciCalls).toEqual([]);
    // ブラウザには待ち受け役が無いので、渡すものも無い
    expect(patchedCalls).toEqual([{ url: `${base}/api/chat`, hadDispatcher: false }]);
  });
});
