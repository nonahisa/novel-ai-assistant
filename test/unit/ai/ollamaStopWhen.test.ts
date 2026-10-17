import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { OllamaProvider } from "../../../src/ai/ollamaProvider";
import { setStreamingSettingReader } from "../../../src/ai/ollamaStream";
import { endsWithInlineRepetition } from "../../../src/core/inlineRepetition";
import { parsePhotoTranscriptionStoppingRepeats } from "../../../src/core/photoTranscribeValidation";
import { useMemoryTuningStore } from "../support/tuningStore";
import { ollamaShowResponse } from "../support/aiResponses";

/**
 * 機能が決めた条件で、流しの途中で受け取りをやめる（`GenerateParams.stopWhen`。
 * 2026-10-11、残課題 A17）。
 *
 * 写真の書き起こしで、逆さの写真に gemma4:26b が1行の中に同じ9字を903回
 * 書き続け、上限まで待ったうえ JSON が閉じずにページが空になった。
 */

const params = {
  systemPrompt: "指示",
  userPrompt: "本文",
  model: "test-model",
  temperature: 0.0,
};

const UNIT = "の上に立つ彼女は、";

/** 書き出しのあと、同じ9字を903回、1字ずつ流す。最後まで読まれたら上限で切れた印で閉じる */
function runawayStream(): { stream: ReadableStream<Uint8Array>; pulled: () => number; total: number } {
  const text = '{"lines":["私は窓の外を見ていた。","机' + UNIT.repeat(903);
  const pieces = [...text];
  const encoder = new TextEncoder();
  let index = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index >= pieces.length) {
        controller.enqueue(
          encoder.encode(JSON.stringify({ done: true, done_reason: "length", eval_count: 8192 }) + "\n")
        );
        controller.close();
        return;
      }
      controller.enqueue(
        encoder.encode(JSON.stringify({ message: { content: pieces[index] }, done: false }) + "\n")
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
        return ollamaShowResponse();
      }
      return new Response(body(), { status: 200 });
    })
  );
}

beforeEach(async () => {
  await useMemoryTuningStore({});
  setStreamingSettingReader(() => true);
});

afterEach(() => {
  setStreamingSettingReader(undefined);
  vi.unstubAllGlobals();
});

describe("流しの途中で、機能の条件で受け取りをやめる", () => {
  test("1行の中の繰り返しで止まり、切り詰めた答えとして返す。機能が1つ目の並びまでを読む", async () => {
    const source = runawayStream();
    stubStream(() => source.stream);

    const result = await new OllamaProvider().generate({
      ...params,
      stopWhen: (content) => endsWithInlineRepetition(content) !== undefined,
    });

    // 上限まで待っていない（8回ぶん＝72字ほどで止まる）
    expect(source.pulled()).toBeLessThan(200);
    expect(source.pulled()).toBeLessThan(source.total / 20);
    expect(result.truncated).toBe(true);

    const { parse, repeatStopped } = parsePhotoTranscriptionStoppingRepeats(result.text);
    expect(repeatStopped).toBe(true);
    expect(parse.ok).toBe(true);
    if (!parse.ok) return;
    expect(parse.value.text).toBe(`私は窓の外を見ていた。\n机${UNIT}`);
  });

  test("条件を渡さなければ、これまでどおり上限まで読む", async () => {
    const source = runawayStream();
    stubStream(() => source.stream);

    const result = await new OllamaProvider().generate(params);

    expect(source.pulled()).toBe(source.total);
    expect(result.truncated).toBe(true);
  });
});
