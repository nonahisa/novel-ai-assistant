import { beforeEach, describe, expect, test, vi } from "vitest";
import { window, workspace } from "./support/vscodeStub";
import type { AIRegistry } from "../../src/ai/registry";
import type { GenerateParams, GenerateResult } from "../../src/ai/types";

/**
 * 「読める長さ」を入力トークン数で測る道を、**送るところまで通して**見る
 * （作者の依頼、2026-09-13。設計書6.27.11）。
 *
 * 純粋な判定は `contextProbeTokens.test.ts` にある。こちらで確かめるのは
 * 繋ぎ目——**合言葉の出来不出来が、長さの判定に混ざっていないこと**と、
 * どちらで測ったかが台帳に残ることである。
 *
 * この作品でくり返し起きた失敗の1番（単体テストが通っても実データで
 * 動かない）に効かせるため、偽のAIは**実機と同じ壊れ方**をする
 * ——本文は全部届いているのに合言葉だけ書けない、という回を作る。
 */

const state = vi.hoisted(() => ({
  /** このAIが実際に読める、プロンプト全体の字数 */
  limitChars: 30_000,
  /** 1字あたりの入力トークン数（実機の詰め物はおよそ0.82だった） */
  tokensPerChar: 0.82,
  /** 入力トークン数を申告するか。false のとき、合言葉で測ることになる */
  reportsTokens: true,
  /** キャッシュから読めた分として申告するトークン数 */
  cachedInputTokens: undefined as number | undefined,
  /** 合言葉を書き写せるか。**長さの判定に混ざっていないことを見るための栓** */
  copiesWords: false,
  calls: [] as GenerateParams[],
}));

vi.mock("../../src/core/logger", () => ({
  logStep: vi.fn(),
  logLine: vi.fn(),
  logFailure: vi.fn(),
  showLog: vi.fn(),
  useLogFile: vi.fn(),
}));

vi.mock("../../src/ai/registry", () => ({
  ensureConfigured: vi.fn(async () => ({
    provider: {
      id: "ollama",
      displayName: "検査用",
      isPaid: false,
      generate: async (params: GenerateParams): Promise<GenerateResult> => {
        state.calls.push(params);
        const promptChars =
          params.systemPrompt.length + params.userPrompt.length;
        // **切られたぶんは、入力トークン数にそのまま出る。**
        // これがこの測り方の前提そのものである
        const delivered = Math.min(promptChars, state.limitChars);
        const head =
          /ひとつ目の合言葉は『(.+?)』/.exec(params.userPrompt)?.[1] ?? "";
        const tail =
          /ふたつ目の合言葉は『(.+?)』/.exec(params.userPrompt)?.[1] ?? "";
        return {
          // 合言葉を書けないときは、実機と同じく指示の言葉を返す
          text: state.copiesWords ? `${head} ${tail}` : "合言葉",
          usage: state.reportsTokens
            ? {
                inputTokens: Math.round(delivered * state.tokensPerChar),
                outputTokens: 4,
                ...(state.cachedInputTokens !== undefined
                  ? { cachedInputTokens: state.cachedInputTokens }
                  : {}),
              }
            : undefined,
          truncated: false,
          elapsedMs: 1,
        };
      },
    },
    model: "gemma4:12b",
  })),
}));

vi.mock("../../src/features/aiConnectivity", () => ({
  confirmPaidUsage: vi.fn(async () => true),
  confirmProviderReachable: vi.fn(async () => true),
  ollamaEndpoint: vi.fn(() => "http://127.0.0.1:11434"),
}));

vi.mock("../../src/views/progress", () => ({
  withCancellableProgress: vi.fn(
    async (
      _title: string,
      task: (
        progress: { report: (value: unknown) => void },
        token: {
          isCancellationRequested: boolean;
          onCancellationRequested: (listener: () => void) => void;
        }
      ) => Promise<unknown>
    ) =>
      task(
        { report: () => {} },
        { isCancellationRequested: false, onCancellationRequested: () => {} }
      )
  ),
}));

import { measureContext } from "../../src/features/measureContext";

const registry = {
  resolveModelInfo: async () => ({ contextWindow: 262144 }),
} as unknown as AIRegistry;

function installSettings(values: Record<string, unknown>): void {
  workspace.getConfiguration = () =>
    ({
      get: <T>(key: string, defaultValue?: T): T =>
        (key in values ? values[key] : defaultValue) as T,
      inspect: () => ({ workspaceValue: undefined }),
      update: async (key: string, value: unknown) => {
        values[key] = value;
      },
    }) as unknown as ReturnType<typeof workspace.getConfiguration>;
}

function ledger(values: Record<string, unknown>): Record<string, unknown> {
  return ((values.modelTuning as Record<string, unknown> | undefined)?.[
    "ollama/gemma4:12b"
  ] ?? {}) as Record<string, unknown>;
}

/** 測って、結果を台帳へ反映させる。返すのは台帳と、作者が読んだ通知 */
async function measure(): Promise<{
  tuning: Record<string, unknown>;
  notice: string;
}> {
  const values: Record<string, unknown> = {};
  installSettings(values);
  const showInformationMessage = vi.fn(async () => "設定に反映");
  Object.assign(window, {
    showInformationMessage,
    showWarningMessage: vi.fn(async () => undefined),
    showErrorMessage: vi.fn(async () => undefined),
  });

  // 「読める長さだけ」を選んだ道。書ける長さは別の話なので巻き込まない
  await measureContext(registry, "default", undefined, "input");

  return {
    tuning: ledger(values),
    notice: showInformationMessage.mock.calls
      .map((call) => call.map(String).join(" / "))
      .join("\n"),
  };
}

beforeEach(() => {
  state.limitChars = 30_000;
  state.tokensPerChar = 0.82;
  state.reportsTokens = true;
  state.cachedInputTokens = undefined;
  state.copiesWords = false;
  state.calls = [];
});

describe("入力トークン数で測る", () => {
  test("合言葉を一度も書けないAIでも、実効の長さが出る", () => {
    /*
      **ここが作り直しの理由である。** 合言葉で測っていた頃、このAIは
      「1字も読めていません」と判定された。実際には30,000字まで届いている。
    */
    return measure().then(({ tuning, notice }) => {
      const measured = tuning.measuredChars as number;
      expect(measured).toBeGreaterThan(30_000 * 0.75);
      expect(measured).toBeLessThanOrEqual(30_000);
      expect(tuning.contextMeasuredBy).toBe("tokens");
      expect(notice).toContain("入力トークン数の伸び");
    });
  });

  test("合言葉を完璧に書けても、伸びが止まればそこで止まる", async () => {
    // 合言葉に引きずられていたら、天井（公称値）まで通ってしまう
    state.copiesWords = true;
    const { tuning } = await measure();
    expect(tuning.measuredChars as number).toBeLessThanOrEqual(30_000);
    expect(tuning.contextHitCeiling).toBeUndefined();
  });

  test("切られる側を言わない（この測り方では分からない）", async () => {
    const { notice } = await measure();
    expect(notice).not.toContain("切り落とされます");
  });

  test("同じ測定から、字/トークンの実測も台帳へ入る", async () => {
    const { tuning, notice } = await measure();
    // 1 ÷ 0.82 ＝ 1.219…（切り捨てて小数3桁）
    expect(tuning.charsPerToken as number).toBeGreaterThan(1.19);
    expect(tuning.charsPerToken as number).toBeLessThan(1.23);
    expect(tuning.charsPerTokenSamples).toBe(1);
    expect(notice).toContain("字/トークン");
  });
});

describe("トークン数を返さないAIへの備え", () => {
  test("申告が無ければ、これまでどおり合言葉で測る", async () => {
    state.reportsTokens = false;
    state.copiesWords = true;
    // 合言葉は「届いた範囲に書いてあれば写せる」ように振る舞う
    const { tuning, notice } = await measure();
    expect(tuning.measuredChars as number).toBeGreaterThan(0);
    // **弱い測り方だと名乗る**（`contextHitCeiling` と同じ考え方）
    expect(tuning.contextMeasuredBy).toBe("words");
    expect(notice).toContain("入力トークン数を返さない");
  });

  test("キャッシュが効いた回は、トークン数を使わない", async () => {
    // 入力トークン数が実際より小さく出るので、伸びが止まって見える
    state.cachedInputTokens = 1_000;
    state.copiesWords = true;
    const { tuning } = await measure();
    expect(tuning.contextMeasuredBy).toBe("words");
  });

  test("字/トークンは、トークン数を使えなかったときは書かない", async () => {
    state.reportsTokens = false;
    state.copiesWords = true;
    const { tuning } = await measure();
    expect(tuning.charsPerToken).toBeUndefined();
  });
});
