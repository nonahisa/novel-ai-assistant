import { beforeEach, describe, expect, test, vi } from "vitest";
import { window, workspace } from "./support/vscodeStub";
import type { AIRegistry } from "../../src/ai/registry";
import {
  AIError,
  type GenerateParams,
  type GenerateResult,
} from "../../src/ai/types";

/**
 * AIチューニングのあいだ、`num_ctx` を1つに固定する（設計書6.52）。
 *
 * Ollama は `num_ctx` が変わるとモデルを読み込み直し、内部の runner を
 * 起こす——作者の報告「AIチューニングで画面が点滅しています」
 * （2026-08-31）はこれである。**この機能の仕事は送る長さを倍々に
 * 変えることそのもの**なので、4096の段に丸めるだけでは吸収できない。
 *
 * ただし申告値がそのまま載るとは限らない（`gemma4:12b` は8GB、この機械の
 * VRAMも8GBで、申告は262144）。**載らないと測定そのものができない**ので、
 * 半分ずつ下げて逃げ道を作り、下げたことは必ず作者へ伝える。
 */

const state = vi.hoisted(() => ({
  /** これから何回、モデルの読み込みに失敗させるか */
  loadFailuresLeft: 0,
  /** 各回の `generate` が受け取った `num_ctx` */
  numCtxCalls: [] as Array<number | undefined>,
  /** 申告値。undefined なら「申告値を取れない」場面 */
  declaredContextWindow: undefined as number | undefined,
}));

const log = vi.hoisted(() => ({
  steps: [] as string[],
  failures: [] as Array<[string, Record<string, unknown>]>,
  logFiles: [] as string[],
}));

// **ログを覗く。** 「下げた」ことが作者へ伝わっているかは、
// 通知だけでなくログにも残っていなければ後から追えない
vi.mock("../../src/core/logger", () => ({
  logStep: vi.fn((message: string) => {
    log.steps.push(message);
  }),
  logLine: vi.fn((message: string) => {
    log.steps.push(message);
  }),
  logFailure: vi.fn((context: string, detail: Record<string, unknown>) => {
    log.failures.push([context, detail]);
  }),
  showLog: vi.fn(),
  useLogFile: vi.fn((folderPath: string) => {
    log.logFiles.push(folderPath);
  }),
}));

vi.mock("../../src/ai/registry", () => ({
  ensureConfigured: vi.fn(async () => ({
    provider: {
      id: "ollama",
      displayName: "Ollama",
      isPaid: false,
      generate: async (params: GenerateParams): Promise<GenerateResult> => {
        state.numCtxCalls.push(params.numCtx);
        if (state.loadFailuresLeft > 0) {
          state.loadFailuresLeft -= 1;
          throw new AIError(
            "Ollamaがモデルを読み込めませんでした。",
            "model_load_failed",
            "error loading model: unable to allocate CUDA0 buffer"
          );
        }
        // 送られた指示から合言葉を読み取って書き写す（実際のAIと同じ振る舞い）
        const head = /最初の合言葉は『(.+?)』/.exec(params.userPrompt)?.[1] ?? "";
        const tail = /最後の合言葉は『(.+?)』/.exec(params.userPrompt)?.[1] ?? "";
        return {
          text: `${head} ${tail}`,
          usage: { inputTokens: 0, outputTokens: 0 },
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

import {
  halvedNumCtx,
  measureContext,
  MIN_FIXED_NUM_CTX,
} from "../../src/features/measureContext";

/** 申告値。8GBのVRAMには載らない大きさ（作者の機械の実例） */
const DECLARED = 262144;

/** `novelai.*` の設定を持つ入れ物 */
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

const registry = {
  resolveModelInfo: async () =>
    state.declaredContextWindow === undefined
      ? undefined
      : { contextWindow: state.declaredContextWindow },
} as unknown as AIRegistry;

function answerWith(answer: string): {
  showInformationMessage: ReturnType<typeof vi.fn>;
  showErrorMessage: ReturnType<typeof vi.fn>;
} {
  const showInformationMessage = vi.fn(async () => answer);
  const showErrorMessage = vi.fn(async () => undefined);
  Object.assign(window, {
    showInformationMessage,
    showWarningMessage: vi.fn(async () => undefined),
    showErrorMessage,
  });
  return { showInformationMessage, showErrorMessage };
}

/** 通知とログに出た文をまとめて1本にする（どちらに出ていても拾える） */
function allText(showInformationMessage: ReturnType<typeof vi.fn>): string {
  return [
    ...log.steps,
    ...showInformationMessage.mock.calls.map((call) => String(call[0])),
  ].join("\n");
}

beforeEach(() => {
  state.loadFailuresLeft = 0;
  state.numCtxCalls = [];
  state.declaredContextWindow = DECLARED;
  log.steps = [];
  log.failures = [];
  log.logFiles = [];
});

describe("下げる段の決め方", () => {
  test("半分にする", () => {
    expect(halvedNumCtx(262144)).toBe(131072);
    expect(halvedNumCtx(32768)).toBe(16384);
  });

  test("半分が下限を割るなら、下限そのものを一度だけ試す", () => {
    // 申告 10,000 で「半分の 5,000 は下限未満だから諦める」とすると、
    // まだ試していない 8,192 を飛ばして中止することになる
    expect(halvedNumCtx(10000)).toBe(MIN_FIXED_NUM_CTX);
    expect(halvedNumCtx(16384)).toBe(MIN_FIXED_NUM_CTX);
  });

  test("下限そのものが載らなければ、もう下げない", () => {
    expect(halvedNumCtx(MIN_FIXED_NUM_CTX)).toBeUndefined();
    expect(halvedNumCtx(4096)).toBeUndefined();
  });

  test("申告値が無ければ下げようが無い", () => {
    expect(halvedNumCtx(undefined)).toBeUndefined();
    expect(halvedNumCtx(0)).toBeUndefined();
    expect(halvedNumCtx(Number.NaN)).toBeUndefined();
  });
});

describe("測定のあいだの num_ctx", () => {
  test("全部の呼び出しで同じ値（申告値）を渡す", async () => {
    installSettings({});
    const { showInformationMessage } = answerWith("そのままにする");

    await measureContext(registry);

    // 何回送ったかは探索の都合で変わる。**変わらないことが要点**である
    expect(state.numCtxCalls.length).toBeGreaterThan(2);
    expect(new Set(state.numCtxCalls)).toEqual(new Set([DECLARED]));
    // 固定したことを、測る前に1行残す
    expect(log.steps.some((line) => line.includes(`num_ctx を ${DECLARED} に固定`))).toBe(
      true
    );
    // 結果にも、どの値で測ったかを添える
    expect(allText(showInformationMessage)).toContain("num_ctx は 262,144 に固定して測りました");
  });

  test("申告値を取れないときは渡さない（長さから決めるこれまでの動き）", async () => {
    state.declaredContextWindow = undefined;
    installSettings({});
    answerWith("そのままにする");

    await measureContext(registry);

    expect(state.numCtxCalls.length).toBeGreaterThan(0);
    expect(state.numCtxCalls.every((value) => value === undefined)).toBe(true);
    expect(log.steps.some((line) => line.includes("num_ctx は固定しません"))).toBe(true);
  });
});

describe("モデルが載らなかったとき", () => {
  test("半分にして測り直し、以後もその値で通す", async () => {
    state.loadFailuresLeft = 1;
    installSettings({});
    const { showInformationMessage } = answerWith("そのままにする");

    await measureContext(registry);

    // 1回目＝申告値で失敗、2回目以降＝半分
    expect(state.numCtxCalls[0]).toBe(DECLARED);
    expect(state.numCtxCalls.length).toBeGreaterThan(2);
    expect(new Set(state.numCtxCalls.slice(1))).toEqual(new Set([DECLARED / 2]));

    // **下げたことを隠さない。** ログと結果の両方に出す
    expect(
      log.steps.some(
        (line) =>
          line.includes("読み込めません") && line.includes(`${DECLARED / 2} へ下げて`)
      )
    ).toBe(true);
    expect(allText(showInformationMessage)).toContain(
      "申告の 262,144 では読み込めなかったため、num_ctx を 131,072 に下げて測りました"
    );
  });

  test("下限まで下げても載らなければ、理由を伝えて中止する", async () => {
    state.loadFailuresLeft = 99;
    const values: Record<string, unknown> = {};
    installSettings(values);
    const { showErrorMessage, showInformationMessage } = answerWith("設定に反映");

    await measureContext(registry);

    // 262144 → 131072 → … → 8192 まで試して打ち切る
    expect(state.numCtxCalls).toEqual([
      262144, 131072, 65536, 32768, 16384, MIN_FIXED_NUM_CTX,
    ]);
    // **「入らない」と数えて0字と報告しない。** 測れなかったことを言う
    expect(showInformationMessage).not.toHaveBeenCalled();
    const message = String(showErrorMessage.mock.calls[0]?.[0] ?? "");
    expect(message).toContain("モデルを読み込めませんでした");
    expect(message).toContain("より小さいモデルをお試しください");
    // AIが返した理由をそのまま添える（直し方の手がかりは向こうにしかない）
    expect(message).toContain("unable to allocate");
    // 測れていないのだから、台帳へは何も書かない
    expect(values.modelTuning).toBeUndefined();
    expect(log.failures.length).toBe(1);
  });
});

describe("ログの置き場所", () => {
  test("作品が分かるなら、その作品のログにも残す", async () => {
    installSettings({});
    answerWith("そのままにする");

    await measureContext(registry, "default", "C:/works/sample");

    expect(log.logFiles).toEqual(["C:/works/sample"]);
  });

  test("作品が分からなければ、出力パネルだけに残す", async () => {
    installSettings({});
    answerWith("そのままにする");

    await measureContext(registry);

    expect(log.logFiles).toEqual([]);
  });
});
