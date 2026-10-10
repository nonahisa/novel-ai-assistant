import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { OllamaProvider } from "../../../src/ai/ollamaProvider";
import { setStreamingSettingReader } from "../../../src/ai/ollamaStream";
import { REPEATED_ELEMENT_LIMIT } from "../../../src/core/repeatedElements";
import { useMemoryTuningStore } from "../support/tuningStore";

/**
 * 手元の AI が**同じ指摘を延々と繰り返した**とき、製品が途中で受け取りを
 * やめ、それまでの答えを閉じて機能へ渡せるか（2026-10-10。
 * `docs/measurements/2026-10-10-typo-runaway.md`）。
 *
 * 直す前は、上限（11,264 トークン）まで約290秒待ち、閉じていない JSON を
 * 「切り詰められた」として機能へ渡していた。機能はそれを解析せずに捨てる
 * ので、繰り返しの前に書いた指摘まで消えた。
 */

const params = {
  systemPrompt: "指示",
  userPrompt: "本文",
  model: "test-model",
  temperature: 0.0,
};

const FIRST = { line: 1, target: "いますい", suggestion: "います" };
const REPEATED = { line: 2, target: "癇癪", suggestion: "癇嘶" };

/**
 * 1件目のあとに同じ要素を `times` 回、1字ずつ流す（Ollama は1トークンずつ
 * 1行で流してくる）。最後まで読まれたら上限で切れた印で閉じる
 */
function runawayStream(times: number): {
  stream: ReadableStream<Uint8Array>;
  pulled: () => number;
  total: number;
} {
  const items = [JSON.stringify(FIRST)];
  for (let i = 0; i < times; i++) items.push(JSON.stringify(REPEATED));
  const text = `{"issues":[${items.join(",")},{"line":2,"tar`;
  const encoder = new TextEncoder();
  const pieces = [...text];
  let index = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index >= pieces.length) {
        controller.enqueue(
          encoder.encode(
            JSON.stringify({ done: true, done_reason: "length", eval_count: 11264 }) + "\n"
          )
        );
        controller.close();
        return;
      }
      controller.enqueue(
        encoder.encode(
          JSON.stringify({ message: { content: pieces[index] }, done: false }) + "\n"
        )
      );
      index += 1;
    },
  });
  return { stream, pulled: () => index, total: pieces.length };
}

function stubStream(body: () => ReadableStream<Uint8Array>): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.endsWith("/api/show")) {
        return new Response(
          JSON.stringify({ model_info: { "test.context_length": 131_072 } }),
          { status: 200 }
        );
      }
      return new Response(body(), { status: 200 });
    })
  );
}

beforeEach(async () => {
  await useMemoryTuningStore({});
});

afterEach(() => {
  setStreamingSettingReader(undefined);
  vi.unstubAllGlobals();
});

describe("流す道：同じ要素が続いたら受け取りをやめる", () => {
  beforeEach(() => setStreamingSettingReader(() => true));

  test("途中で止め、繰り返しの前の指摘を残した読める答えを渡す", async () => {
    const source = runawayStream(150);
    stubStream(() => source.stream);

    const result = await new OllamaProvider().generate({
      ...params,
      meta: { feature: "typo_check" },
    });

    // 最後まで読んでいない（上限まで待っていない）
    expect(source.pulled()).toBeLessThan(source.total / 5);
    // 機能の側が捨てないよう、切り詰めの印は立てない
    expect(result.truncated).toBe(false);
    expect(result.stoppedEarly).toEqual({
      reason: "repetition",
      stoppedAt: 1 + REPEATED_ELEMENT_LIMIT,
      kept: 2,
    });
    const parsed = JSON.parse(result.text) as { issues: unknown[] };
    expect(parsed.issues).toEqual([FIRST, REPEATED]);
  });

  test("同じ要素が続かなければ、これまでどおり書き切った答えを渡す", async () => {
    const encoder = new TextEncoder();
    const text = JSON.stringify({ issues: [FIRST, REPEATED, FIRST, REPEATED] });
    stubStream(
      () =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                JSON.stringify({ message: { content: text }, done: false }) +
                  "\n" +
                  JSON.stringify({ done: true, done_reason: "stop", eval_count: 50 }) +
                  "\n"
              )
            );
            controller.close();
          },
        })
    );

    const result = await new OllamaProvider().generate(params);

    expect(result.text).toBe(text);
    expect(result.truncated).toBe(false);
    expect(result.stoppedEarly).toBeUndefined();
  });
});

describe("流さない道：上限で切れた答えからも救う", () => {
  beforeEach(() => setStreamingSettingReader(() => false));

  test("上限で切れた繰り返しの答えを、切り戻して閉じる", async () => {
    const items = [JSON.stringify(FIRST)];
    for (let i = 0; i < 40; i++) items.push(JSON.stringify(REPEATED));
    const content = `{"issues":[${items.join(",")},{"line":2,"tar`;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: Parameters<typeof fetch>[0]) => {
        const url = input instanceof Request ? input.url : String(input);
        if (url.endsWith("/api/show")) {
          return new Response(
            JSON.stringify({ model_info: { "test.context_length": 131_072 } }),
            { status: 200 }
          );
        }
        return new Response(
          JSON.stringify({
            message: { content },
            done_reason: "length",
            eval_count: 11264,
          }),
          { status: 200 }
        );
      })
    );

    const result = await new OllamaProvider().generate(params);

    expect(result.truncated).toBe(false);
    expect(result.stoppedEarly?.kept).toBe(2);
    expect((JSON.parse(result.text) as { issues: unknown[] }).issues).toHaveLength(2);
  });
});
