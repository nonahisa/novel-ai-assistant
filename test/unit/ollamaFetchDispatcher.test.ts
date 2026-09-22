import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * **Ollama へ投げる fetch に、こちらの待ち時間の dispatcher が渡っている**
 * （設計書6.63。2026-09-23）。
 *
 * ノートPCの実機（0.75.9）で、台帳1800秒・設定900秒なのに約300秒で
 * `UND_ERR_HEADERS_TIMEOUT` になった。`timeoutDispatcher` は `httpClient.ts`
 * にしか入っておらず、Ollama の自前の fetch には一度も渡っていなかった。
 *
 * ソースを読む網（`fetchDispatcherNet.test.ts`）は「渡す字面があるか」を
 * 見る。こちらは**実際に呼んで、その呼び出しの待ち時間で作った役が
 * fetch に届くか**を見る——字面があっても値を取り違えれば同じ穴になる。
 *
 * 部品そのもの（undici の Agent を作る）は差し替える。本物の Agent が
 * 300秒を越えて待てることは、ノートPCが Electron の Node で確かめてある。
 */

/** 部品が作ったことにする役。何ミリ秒で頼まれたかを持たせる */
interface FakeDispatcher {
  readonly fake: true;
  readonly ms: number;
}

// `vi.mock` は先頭へ巻き上げられるので、中で使う入れ物も一緒に巻き上げる
const { requested } = vi.hoisted(() => ({ requested: [] as number[] }));

vi.mock("../../src/ai/fetchTimeouts", () => ({
  timeoutDispatcher: vi.fn(async (ms: number): Promise<FakeDispatcher> => {
    requested.push(ms);
    return { fake: true, ms };
  }),
  clearDispatcherCache: vi.fn(),
}));

import { OllamaProvider } from "../../src/ai/ollamaProvider";
import { OllamaEmbeddingProvider } from "../../src/ai/ollamaEmbedding";
import { setStreamingSettingReader } from "../../src/ai/ollamaStream";
import { ollamaGenerate, MCP_OLLAMA_WAIT_MS } from "../../src/mcp/tools/ollama";
import { workspace } from "./support/vscodeStub";

/** 作者の設定：Ollama の待ち時間を900秒へ延ばしてある（ノートPCと同じ） */
const CONFIGURED_SECONDS = 900;

const params = {
  systemPrompt: "system",
  userPrompt: "user",
  model: "gemma4:e2b",
  temperature: 0.2,
  numCtx: 16384,
};

function dispatcherOf(init: RequestInit | undefined): FakeDispatcher | undefined {
  return (init as (RequestInit & { dispatcher?: FakeDispatcher }) | undefined)
    ?.dispatcher;
}

describe("Ollama の fetch に、その呼び出しの待ち時間で作った dispatcher を渡す", () => {
  beforeEach(() => {
    requested.length = 0;
    workspace.getConfiguration = () => ({
      get: <T>(key: string, defaultValue: T): T =>
        (key === "ollama.timeoutSeconds" ? CONFIGURED_SECONDS : defaultValue) as T,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    setStreamingSettingReader(undefined);
  });

  test("まとめて受け取る道（streaming=false。ノートPCが踏んだ道）", async () => {
    setStreamingSettingReader(() => false);
    const seen: Array<FakeDispatcher | undefined> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        seen.push(dispatcherOf(init));
        return new Response(
          JSON.stringify({ message: { content: "はい" }, done_reason: "stop" }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      })
    );

    await new OllamaProvider().generate(params);

    expect(seen).toEqual([{ fake: true, ms: CONFIGURED_SECONDS * 1000 }]);
  });

  test("流す道（本文を読み終えるまで頭が来ないので、ここも要る）", async () => {
    setStreamingSettingReader(() => true);
    const seen: Array<FakeDispatcher | undefined> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        seen.push(dispatcherOf(init));
        return new Response(
          '{"message":{"content":"はい"},"done":false}\n{"done":true,"done_reason":"stop"}\n',
          { status: 200, headers: { "Content-Type": "application/x-ndjson" } }
        );
      })
    );

    await new OllamaProvider().generate(params);

    expect(seen).toEqual([{ fake: true, ms: CONFIGURED_SECONDS * 1000 }]);
  });

  test("埋め込み（/api/embed）", async () => {
    const seen: Array<FakeDispatcher | undefined> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        seen.push(dispatcherOf(init));
        return new Response(JSON.stringify({ embeddings: [[0.1, 0.2]] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      })
    );

    await new OllamaEmbeddingProvider("bge-m3").embed(["あ"]);

    expect(seen).toHaveLength(1);
    expect(seen[0]?.fake).toBe(true);
    // 埋め込みの待ち時間（呼び出し側が決めた値）と同じ長さで作っている
    expect(requested).toEqual([seen[0]?.ms]);
  });

  test("MCP の ollama.generate（自前の打ち切りが無いので、長めの上限を渡す）", async () => {
    const seen: Array<FakeDispatcher | undefined> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        seen.push(dispatcherOf(init));
        return new Response('{"message":{"content":"{}"},"done":false}\n{"done":true}\n', {
          status: 200,
        });
      })
    );

    await ollamaGenerate({ ...params, numCtx: 4096, temperature: 0 });

    expect(seen).toEqual([{ fake: true, ms: MCP_OLLAMA_WAIT_MS }]);
    // 製品で作者が選びうる長さ（台帳で1800秒の実例）より短くしない
    expect(MCP_OLLAMA_WAIT_MS).toBeGreaterThanOrEqual(1800 * 1000);
  });
});
