import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { OllamaProvider } from "../../../src/ai/ollamaProvider";
import { setStreamingSettingReader } from "../../../src/ai/ollamaStream";
import { bundledFeatureOutput } from "../../../src/core/bundledTuning";
import { workspace } from "../support/vscodeStub";
import { useMemoryTuningStore } from "../support/tuningStore";

/**
 * 手元の Ollama が出力を止めずに書き続けたとき、製品が1回ぶんで打ち切れるか
 * （2026-10-08 の測定。qwen3.5:9b の誤字脱字で、1話あたり約5,000トークンの
 * 入力に対して出力が15,000トークンを超えて続き、1話に10分かかった）。
 *
 * ## 何が足りなかったか
 *
 * 1. **出力の上限を送っていなかった**（設計書6.58.2「出力上限は制限不要」）。
 *    止めるものが時間切れしか無い
 * 2. **流す道（既定）の時間切れは、断片が届くたびに数え直していた。**
 *    書き続けている限り一度も切れない
 *
 * ここで固めるのは、
 *
 * - 機能の見込み（`core/featureOutputTokens.ts`）がある機能だけ、その値を
 *   `num_predict` に載せる（見込みの無い機能は従来どおり送らない）
 * - 流す道でも、作者が選んだ秒数で**呼び出し1回ぶん**を打ち切る
 */

const params = {
  systemPrompt: "指示",
  userPrompt: "本文",
  model: "test-model",
  temperature: 0.0,
};

/** 同梱の見込み（`typo_check`）から、送るはずの上限を組み立てる（数字を写さない） */
function expectedTypoCap(): number {
  const seed = bundledFeatureOutput("typo_check");
  if (!seed) throw new Error("同梱の typo_check が無い");
  return Math.ceil((seed.outputTokens * 1.25) / 1024) * 1024;
}

function ndjson(lines: unknown[]): string {
  return lines.map((line) => JSON.stringify(line)).join("\n") + "\n";
}

/** 送った本文を溜めながら、決まった応答を流す */
function stubFetch(): Array<Record<string, unknown>> {
  const bodies: Array<Record<string, unknown>> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.endsWith("/api/show")) {
        return new Response(
          JSON.stringify({ model_info: { "test.context_length": 131_072 } }),
          { status: 200 }
        );
      }
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(
        ndjson([
          { message: { content: "{}" }, done: false },
          { done: true, done_reason: "stop", eval_count: 3, prompt_eval_count: 9 },
        ]),
        { status: 200 }
      );
    })
  );
  return bodies;
}

const originalConfig = workspace.getConfiguration;

/** 待ち時間の設定だけを差し替える（秒） */
function useTimeoutSeconds(seconds: number | undefined): void {
  workspace.getConfiguration = (() => ({
    get: <T>(key: string, defaultValue: T): T =>
      key === "ollama.timeoutSeconds" && seconds !== undefined
        ? (seconds as unknown as T)
        : defaultValue,
  })) as unknown as typeof workspace.getConfiguration;
}

beforeEach(async () => {
  await useMemoryTuningStore({});
  useTimeoutSeconds(undefined);
  setStreamingSettingReader(() => true);
});

afterEach(() => {
  workspace.getConfiguration = originalConfig;
  setStreamingSettingReader(undefined);
  vi.unstubAllGlobals();
});

describe("出力の上限（num_predict）", () => {
  test("機能の見込みがある機能は、その値を num_predict に載せる", async () => {
    const bodies = stubFetch();

    await new OllamaProvider().generate({
      ...params,
      meta: { feature: "typo_check" },
    });

    const options = bodies[0].options as Record<string, unknown>;
    expect(options.num_predict).toBe(expectedTypoCap());
  });

  test("機能の分からない呼び出しには、これまでどおり送らない", async () => {
    const bodies = stubFetch();

    await new OllamaProvider().generate(params);

    const options = bodies[0].options as Record<string, unknown>;
    expect(options.num_predict).toBeUndefined();
  });

  test("一度上限に当たった機能（切り詰めの印）には送らない", async () => {
    // 「要る量が分からない」という印。上限を送り続けると、本当に長く要る
    // 回が毎回切れて、そのチャンクが毎回捨てられる
    await useMemoryTuningStore({
      "出力見込み/ollama/test-model/typo_check": { outputTruncated: true },
    });
    const bodies = stubFetch();

    await new OllamaProvider().generate({
      ...params,
      meta: { feature: "typo_check" },
    });

    const options = bodies[0].options as Record<string, unknown>;
    expect(options.num_predict).toBeUndefined();
  });

  test("書ける量の測定（capOutputTokens）は、従来どおり設定の上限を送る", async () => {
    const bodies = stubFetch();

    await new OllamaProvider().generate({
      ...params,
      maxOutputTokens: 4096,
      capOutputTokens: true,
      meta: { feature: "typo_check" },
    });

    const options = bodies[0].options as Record<string, unknown>;
    expect(options.num_predict).toBe(4096);
  });
});

describe("流す道の時間切れ", () => {
  test("書き続けて終わらない応答は、選んだ秒数で打ち切る", async () => {
    useTimeoutSeconds(0.3);
    const encoder = new TextEncoder();
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        pulled += 1;
        // 打ち切らなければ約3秒で自分から閉じる（試験が終わらなくならないため）。
        // 閉じたときは正常に終わった形になるので、直す前はここで「成功」する
        if (pulled > 150) {
          controller.enqueue(
            encoder.encode(
              JSON.stringify({ done: true, done_reason: "stop", eval_count: 150 }) + "\n"
            )
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
    });
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
        return new Response(stream, { status: 200 });
      })
    );

    const failure = await new OllamaProvider()
      .generate(params)
      .then(() => undefined, (error: unknown) => error);

    expect(failure).toMatchObject({ kind: "timeout" });
    expect(String((failure as Error).message)).toContain("終わらなかった");
    // 待ち時間（0.3秒）のあたりでやめている。自分から閉じるまで待っていない
    expect(pulled).toBeLessThan(100);
  });
});
