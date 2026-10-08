import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { bundledFeatureOutput } from "../../../src/core/bundledTuning";

/**
 * MCP の `novel.run`（runner ollama）で、手元の Ollama が出力を止めずに
 * 書き続けたとき、**そのチャンクだけ**を打ち切って残りを続けられるか。
 *
 * 2026-10-08 の測定（`scripts/measure.mjs typo --model qwen3.5:9b`）で、
 * 10話のうち3話が出力1.5万トークンを超えて書き続け、1話に10分かかったうえ
 * 「スキーマに沿っていません」で落ちた。`--timeout 180` は効かなかった。
 *
 * この道には、
 *
 * - 出力の上限（`num_predict`）が無かった
 * - 1回の呼び出しを打ち切る時計が無かった（通信部品の30分は「頭を待つ上限」と
 *   「断片の間があいたときの上限」で、書き続けている限り一度も切れない）
 * - 上限に当たったことが、失敗の理由に出なかった
 *
 * 製品の側（`ai/ollamaProvider.ts`）は `test/unit/ai/ollamaRunaway.test.ts`。
 */

/** そのとき返す応答（`localFetch` の差し替えが読む） */
let respond: () => Response = () => new Response("", { status: 200 });
/** 送った本文（呼ばれた順） */
let sentBodies: Array<Record<string, unknown>> = [];

vi.mock("../../../src/ai/fetchTimeouts", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/ai/fetchTimeouts")>();
  return {
    ...actual,
    localFetch: async (_url: string, init?: RequestInit) => {
      sentBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return respond();
    },
  };
});

import { ollamaGenerate } from "../../../src/mcp/tools/ollama";
import { runByRunner } from "../../../src/mcp/tools/run";

const input = {
  model: "test-model",
  systemPrompt: "指示",
  userPrompt: "本文",
  numCtx: 8192,
  temperature: 0,
};

function ndjson(lines: unknown[]): string {
  return lines.map((line) => JSON.stringify(line)).join("\n") + "\n";
}

/** 同梱の見込み（`typo_check`）から、送るはずの上限を組み立てる（数字を写さない） */
function expectedTypoCap(): number {
  const seed = bundledFeatureOutput("typo_check");
  if (!seed) throw new Error("同梱の typo_check が無い");
  return Math.ceil((seed.outputTokens * 1.25) / 1024) * 1024;
}

afterEach(() => {
  sentBodies = [];
  respond = () => new Response("", { status: 200 });
});

describe("ollama.generate の出力の上限", () => {
  test("numPredict を渡せば num_predict に載る", async () => {
    respond = () =>
      new Response(ndjson([{ message: { content: "{}" }, done: true }]), {
        status: 200,
      });

    await ollamaGenerate({ ...input, numPredict: 4096 });

    const options = sentBodies[0].options as Record<string, unknown>;
    expect(options.num_predict).toBe(4096);
    // **num_ctx と温度は外さない**（CLAUDE.md 規則6）
    expect(options.num_ctx).toBe(8192);
  });

  test("渡さなければ、これまでどおり送らない", async () => {
    respond = () =>
      new Response(ndjson([{ message: { content: "{}" }, done: true }]), {
        status: 200,
      });

    await ollamaGenerate(input);

    const options = sentBodies[0].options as Record<string, unknown>;
    expect(options.num_predict).toBeUndefined();
  });

  test("上限で切られた応答は、そうと分かる印を付けて返す", async () => {
    respond = () =>
      new Response(
        ndjson([
          { message: { content: '{"issues": [' }, done: false },
          { done: true, done_reason: "length", eval_count: 4096 },
        ]),
        { status: 200 }
      );

    const result = await ollamaGenerate({ ...input, numPredict: 4096 });

    expect(result.truncated).toBe(true);
  });
});

describe("ollama.generate の時間切れ", () => {
  test("書き続けて終わらない応答は、渡した時間で打ち切る", async () => {
    const encoder = new TextEncoder();
    let pulled = 0;
    respond = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          async pull(controller) {
            pulled += 1;
            // 打ち切らなければ約3秒で自分から閉じる（試験が終わらなくならないため）
            if (pulled > 150) {
              controller.enqueue(
                encoder.encode(JSON.stringify({ done: true, done_reason: "stop" }) + "\n")
              );
              controller.close();
              return;
            }
            await new Promise((resolve) => setTimeout(resolve, 20));
            controller.enqueue(
              encoder.encode(
                JSON.stringify({ message: { content: "あ" }, done: false }) + "\n"
              )
            );
          },
        }),
        { status: 200 }
      );

    const failure = await ollamaGenerate({ ...input, timeoutMs: 1000 }).then(
      () => undefined,
      (error: unknown) => error
    );

    expect(String((failure as Error | undefined)?.message)).toContain(
      "1 秒で応答が終わらなかったので打ち切りました"
    );
    expect(pulled).toBeLessThan(100);
  });
});

describe("novel.run（runner ollama）で1チャンクずつ打ち切る", () => {
  const PROMPTS = {
    systemPrompt: "s",
    schema: { type: "object" },
    temperature: 0,
    chunks: [
      { chunkId: "c1", userPrompt: "u1" },
      { chunkId: "c2", userPrompt: "u2" },
      { chunkId: "c3", userPrompt: "u3" },
    ],
  };

  function tempFolder(): string {
    return fs.mkdtempSync(nodePath.join(os.tmpdir(), "novelai-runaway-"));
  }

  test("機能の見込みを num_predict に渡し、失敗したチャンクだけを落として続ける", async () => {
    const folder = tempFolder();
    try {
      const seen: Array<{ numPredict?: number; timeoutMs?: number }> = [];
      const outcome = await runByRunner(
        { runner: "ollama", model: "test-model", numCtx: 8192, timeoutSeconds: 5 },
        PROMPTS,
        "novel.validate（feature: typo）",
        (chunkId, text) => {
          if (text !== "{}") throw new Error("スキーマに沿っていません");
          return chunkId;
        },
        async (params) => {
          seen.push({ numPredict: params.numPredict, timeoutMs: params.timeoutMs });
          if (params.userPrompt === "u2") {
            throw new Error("5 秒で応答が終わらなかったので打ち切りました");
          }
          if (params.userPrompt === "u3") {
            // 上限で切られた応答。JSON が閉じていない
            return { text: '{"issues": [', truncated: true };
          }
          return { text: "{}" };
        },
        {
          folder,
          feature: "typo_check",
          promptVersion: "test",
          hashOf: (chunkId) => chunkId,
          parse: () => undefined,
        }
      );

      // 3つとも、同じ上限と同じ時間で投げている
      expect(seen).toEqual([
        { numPredict: expectedTypoCap(), timeoutMs: 5000 },
        { numPredict: expectedTypoCap(), timeoutMs: 5000 },
        { numPredict: expectedTypoCap(), timeoutMs: 5000 },
      ]);
      expect(outcome).toMatchObject({ runner: "ollama", results: ["c1"] });
      if (outcome.runner !== "ollama") throw new Error("ollama の道を通っていない");
      expect(outcome.failures.map((failure) => failure.chunkId)).toEqual([
        "c2",
        "c3",
      ]);
      expect(outcome.failures[0].reason).toContain("応答が終わらなかった");
      // **「スキーマに沿っていません」だけにしない。** 何が起きたかを先に言う
      expect(outcome.failures[1].reason).toContain(
        `出力が上限（${expectedTypoCap()} トークン）に達したので打ち切りました`
      );
    } finally {
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  test("機能の分からない道具（キャッシュを渡さない）は、上限を送らない", async () => {
    const seen: Array<number | undefined> = [];
    await runByRunner(
      { runner: "ollama", model: "test-model", numCtx: 8192 },
      { ...PROMPTS, chunks: [PROMPTS.chunks[0]] },
      "novel.validate（feature: x）",
      () => "ok",
      async (params) => {
        seen.push(params.numPredict);
        return { text: "{}" };
      }
    );
    expect(seen).toEqual([undefined]);
  });
});
