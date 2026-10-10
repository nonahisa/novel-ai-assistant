import { afterEach, describe, expect, test, vi } from "vitest";
import { REPEATED_ELEMENT_LIMIT } from "../../../src/core/repeatedElements";

/**
 * MCP の Ollama の道（`novel.run` の runner ollama）でも、同じ指摘の繰り返しを
 * 途中で止めて、それまでの答えを検算へ回せるか（2026-10-10。製品の側は
 * `test/unit/ai/ollamaRepetition.test.ts`）。
 *
 * 再現は `novel.run` で取った（`docs/measurements/2026-10-10-typo-runaway.md`）。
 * 「出力が上限（11264 トークン）に達したので打ち切りました…応答を読み取れ
 * ませんでした」でチャンクごと落ちていた。
 */

let respond: () => Response = () => new Response("", { status: 200 });

vi.mock("../../../src/ai/fetchTimeouts", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/ai/fetchTimeouts")>();
  return {
    ...actual,
    localFetch: async () => respond(),
  };
});

import { ollamaGenerate } from "../../../src/mcp/tools/ollama";

const input = {
  model: "test-model",
  systemPrompt: "指示",
  userPrompt: "本文",
  numCtx: 8192,
  temperature: 0,
};

const FIRST = { line: 1, target: "いますい", suggestion: "います" };
const REPEATED = { line: 2, target: "癇癪", suggestion: "癇嘶" };

afterEach(() => {
  respond = () => new Response("", { status: 200 });
});

describe("ollama.generate の繰り返しの打ち切り", () => {
  test("同じ要素が続いたら読むのをやめ、閉じた答えを返す", async () => {
    const items = [JSON.stringify(FIRST)];
    for (let i = 0; i < 150; i++) items.push(JSON.stringify(REPEATED));
    const pieces = [...`{"issues":[${items.join(",")},{"li`];
    const encoder = new TextEncoder();
    let index = 0;
    respond = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            if (index >= pieces.length) {
              controller.enqueue(
                encoder.encode(
                  JSON.stringify({ done: true, done_reason: "length" }) + "\n"
                )
              );
              controller.close();
              return;
            }
            controller.enqueue(
              encoder.encode(
                JSON.stringify({ message: { content: pieces[index] }, done: false }) +
                  "\n"
              )
            );
            index += 1;
          },
        }),
        { status: 200 }
      );

    const result = await ollamaGenerate({ ...input, numPredict: 11264 });

    expect(index).toBeLessThan(pieces.length / 5);
    expect(result.truncated).toBe(false);
    expect(result.stoppedEarly).toEqual({
      reason: "repetition",
      stoppedAt: 1 + REPEATED_ELEMENT_LIMIT,
      kept: 2,
    });
    expect((JSON.parse(result.text) as { issues: unknown[] }).issues).toEqual([
      FIRST,
      REPEATED,
    ]);
  });

  test("繰り返していない、上限で切れただけの答えは、これまでどおり切れた印で返す", async () => {
    respond = () =>
      new Response(
        [
          JSON.stringify({ message: { content: '{"issues": [' }, done: false }),
          JSON.stringify({ done: true, done_reason: "length", eval_count: 4096 }),
        ].join("\n") + "\n",
        { status: 200 }
      );

    const result = await ollamaGenerate({ ...input, numPredict: 4096 });

    expect(result.truncated).toBe(true);
    expect(result.stoppedEarly).toBeUndefined();
  });
});
