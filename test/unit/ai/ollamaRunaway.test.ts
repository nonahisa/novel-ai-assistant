import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { OllamaProvider } from "../../../src/ai/ollamaProvider";
import { setStreamingSettingReader } from "../../../src/ai/ollamaStream";
import {
  AIError,
  isConnectivityFailure,
  isFatalProviderFailure,
  recoveryForAIError,
} from "../../../src/ai/types";
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

describe("書き続けた末の時間切れの札（output_deadline）", () => {
  test("待ち時間を延ばせとは案内しない（延ばせば長く書くだけ）", () => {
    const advice = recoveryForAIError(
      new AIError("打ち切りました", "output_deadline")
    );
    expect(advice).not.toContain("タイムアウト");
    expect(advice).toContain("モデル");
  });
});

/** 誤字脱字の呼び出しの記録欄（締め切りは機能ごとの実測で決まる） */
const TYPO_META = { feature: "typo_check" };

/** この機械で誤字脱字を測った実測がある台帳（同梱ではなく作者の行） */
async function useMeasuredTypoLedger(outputTokens = 3000): Promise<void> {
  await useMemoryTuningStore({
    "出力見込み/ollama/test-model/typo_check": {
      outputTokens,
      outputTokenSamples: 1,
    },
  });
}

/** `pulls` 回、20ミリ秒おきに1字ずつ流してから正常に閉じる応答 */
function slowStream(pulls: number): { stream: ReadableStream<Uint8Array>; pulled: () => number } {
  const encoder = new TextEncoder();
  let pulled = 0;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      pulled += 1;
      if (pulled > pulls) {
        controller.enqueue(
          encoder.encode(
            JSON.stringify({ done: true, done_reason: "stop", eval_count: pulls }) + "\n"
          )
        );
        controller.close();
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
      controller.enqueue(
        encoder.encode(JSON.stringify({ message: { content: "あ" }, done: false }) + "\n")
      );
    },
  });
  return { stream, pulled: () => pulled };
}

function stubStream(stream: ReadableStream<Uint8Array>): void {
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
}

describe("流す道の時間切れ", () => {
  test("実測の無いモデル×機能は、待ち時間を越えて書き続けても切らない（F-52 の前例を守る）", async () => {
    // 待ち時間0.3秒に対して約1秒書き続ける。台帳は空（同梱の typo_check はある）
    useTimeoutSeconds(0.3);
    const { stream } = slowStream(50);
    stubStream(stream);

    const result = await new OllamaProvider().generate({ ...params, meta: TYPO_META });

    expect(result.text).toBe("あ".repeat(50));
  });

  test("実測があっても、時刻を越えて書いた量が見込みの内なら切らない（遅いだけ）", async () => {
    // 見込み 3,000×1.25 → 4,096。待ち時間0.3秒に対して約1秒・50トークン書く
    await useMeasuredTypoLedger(3000);
    useTimeoutSeconds(0.3);
    const { stream } = slowStream(50);
    stubStream(stream);

    const result = await new OllamaProvider().generate({ ...params, meta: TYPO_META });

    expect(result.text).toBe("あ".repeat(50));
  });

  test("時刻を越え、見込み×1.25 を越えて書き続ける応答は打ち切る（暴走）", async () => {
    // 見込み 10×1.25 → 刻みで 1,024。20ミリ秒ごとに30トークンずつ流す
    await useMeasuredTypoLedger(10);
    useTimeoutSeconds(0.3);
    const encoder = new TextEncoder();
    const line = JSON.stringify({ message: { content: "あ" }, done: false }) + "\n";
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        pulled += 1;
        // 打ち切らなければ約3秒で自分から閉じる（試験が終わらなくならないため）。
        // 閉じたときは正常に終わった形になるので、直す前はここで「成功」する
        if (pulled > 150) {
          controller.enqueue(
            encoder.encode(
              JSON.stringify({ done: true, done_reason: "stop", eval_count: 4500 }) + "\n"
            )
          );
          controller.close();
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
        controller.enqueue(encoder.encode(line.repeat(30)));
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
      .generate({ ...params, meta: TYPO_META })
      .then(() => undefined, (error: unknown) => error);

    // **接続の失敗の札（timeout）にしない。** 断片は届いていたので繋がっている。
    // timeout にすると、3話続いたときに誤字脱字などが一括処理ごと止まる
    expect(failure).toMatchObject({ kind: "output_deadline" });
    expect(String((failure as Error).message)).toContain("終わらなかった");
    const kind = (failure as AIError).kind;
    expect(isConnectivityFailure(kind)).toBe(false);
    expect(isFatalProviderFailure(kind)).toBe(false);
    // 時刻（0.3秒＝約450トークン）では切らず、見込み（1,024）を越えたところで
    // やめている。自分から閉じるまで待っていない
    expect(pulled).toBeGreaterThan(30);
    expect(pulled).toBeLessThan(100);
  });

  test("1つも断片が来ないまま時間が来たら、これまでどおり時間切れ（接続の失敗の側）", async () => {
    // 締め切りが掛かる条件（実測あり）でも、何も届いていなければ無応答として扱う
    await useMeasuredTypoLedger();
    useTimeoutSeconds(0.3);
    const stream = new ReadableStream<Uint8Array>({
      // 何も流さずに約3秒待ってから閉じる（本物の無応答の代わり）
      async pull(controller) {
        await new Promise((resolve) => setTimeout(resolve, 3000));
        controller.close();
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
      .generate({ ...params, meta: TYPO_META })
      .then(() => undefined, (error: unknown) => error);

    expect(failure).toMatchObject({ kind: "timeout" });
    expect(isConnectivityFailure((failure as AIError).kind)).toBe(true);
  });
});
