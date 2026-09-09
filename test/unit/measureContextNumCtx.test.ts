import { beforeEach, describe, expect, test, vi } from "vitest";
import { window, workspace } from "./support/vscodeStub";
import type { AIRegistry } from "../../src/ai/registry";
import {
  AIError,
  type GenerateParams,
  type GenerateResult,
} from "../../src/ai/types";

/**
 * AIチューニングの `num_ctx` は、**その回に送る長さに合わせる**
 * （設計書6.53.2）。
 *
 * 0.29.2 では点滅を止めるために申告値へ固定したが、実機のログで害の
 * ほうが大きいと分かった（2026-08-31）。申告 262,144 の `gemma4:12b` を
 * 固定で載せると KVキャッシュだけで約4.9GB を確保し、モデル本体 3.6GB と
 * 合わせて8GBのVRAMに収まらない。しかも **Ollamaは「載らない」を失敗として
 * 返さず、黙ってCPUへ逃がす**ので、速度だけが10分の1になる——測定結果は
 * 「実効の上限 約17,000字」という、確保しすぎたメモリを測っただけの値に
 * なった。**多めに取っておけば安全、が成り立たない。**
 */

const state = vi.hoisted(() => ({
  /** これから何回、モデルの読み込みに失敗させるか */
  loadFailuresLeft: 0,
  /**
   * 何回目の呼び出しから、モデルの読み込みに失敗させるか（1始まり）。
   * **「下で通ってから載らなくなる」場面**を作るために要る
   */
  failLoadFromCall: undefined as number | undefined,
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
        if (
          state.failLoadFromCall !== undefined &&
          state.numCtxCalls.length >= state.failLoadFromCall
        ) {
          throw new AIError(
            "Ollamaがモデルを読み込めませんでした。",
            "model_load_failed",
            "error loading model: unable to allocate CUDA0 buffer"
          );
        }
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
  measureContext,
  numCtxForProbe,
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
  state.failLoadFromCall = undefined;
  state.numCtxCalls = [];
  state.declaredContextWindow = DECLARED;
  log.steps = [];
  log.failures = [];
  log.logFiles = [];
});

describe("その回の num_ctx の決め方", () => {
  test("送る長さに比例して増える（固定していた頃はどちらも申告値だった）", () => {
    const small = numCtxForProbe(4000, DECLARED) as number;
    const large = numCtxForProbe(32000, DECLARED) as number;
    expect(large).toBeGreaterThan(small);
    // **申告値を確保しない。** ここが 262,144 に戻ると、KVキャッシュが
    // VRAMから溢れて黙ってCPUへ落ちる（実機で確認、2026-08-31）
    expect(large).toBeLessThan(DECLARED);
  });

  test("申告値で頭打ちにする", () => {
    expect(numCtxForProbe(1_000_000, 32768)).toBe(32768);
  });

  test("4096の段に丸めるので、近い長さなら同じ値になる", () => {
    const value = numCtxForProbe(20000, DECLARED) as number;
    expect(value % 4096).toBe(0);
    expect(numCtxForProbe(20500, DECLARED)).toBe(value);
  });

  test("申告値を取れないなら渡さない（当て推量の値を入れない）", () => {
    expect(numCtxForProbe(4000, undefined)).toBeUndefined();
    expect(numCtxForProbe(4000, 0)).toBeUndefined();
    expect(numCtxForProbe(4000, Number.NaN)).toBeUndefined();
  });
});

describe("測定のあいだの num_ctx", () => {
  test("申告値を確保せず、その回の長さに合わせる", async () => {
    installSettings({});
    const { showInformationMessage } = answerWith("そのままにする");

    await measureContext(registry);

    // 申告どおり読めるモデルは**2回で終わる**（設計書6.59。小さく1回
    // 当ててから公称値へ跳ぶ）。ここが1回になると、跳ぶ前の確認が
    // 消えたことになる
    expect(state.numCtxCalls.length).toBeGreaterThanOrEqual(2);
    // **短い回で申告ぶんを確保しない。** 全部が 262,144 で埋まっていたのが
    // 0.29.2 の姿で、実機ではそれが原因でCPUへ落ちていた。
    // いちばん短い回（4,000字）は、申告値の1割にも満たないはずである
    expect(state.numCtxCalls[0]).toBeLessThan(DECLARED / 10);
    // 送る長さが違えば値も違う（1つに固まっていないこと）
    expect(new Set(state.numCtxCalls).size).toBeGreaterThan(1);
    // いちばん長い回だけは申告値に届いてよい——**そこを測るための回**であり、
    // 「その長さは無理」と分かること自体が測定の結果になる
    expect(Math.max(...state.numCtxCalls.map((value) => value ?? 0))).toBe(DECLARED);
    // 測る前に、どう決めるかを1行残す
    expect(
      log.steps.some((line) => line.includes("num_ctx は送る長さに合わせます"))
    ).toBe(true);
    // 結果にも、いくつまで使ったかを添える
    expect(allText(showInformationMessage)).toContain("num_ctx は送る長さに合わせました");
  });

  test("申告値を取れないときは渡さない（長さから決めるこれまでの動き）", async () => {
    state.declaredContextWindow = undefined;
    installSettings({});
    answerWith("そのままにする");

    await measureContext(registry);

    expect(state.numCtxCalls.length).toBeGreaterThan(0);
    expect(state.numCtxCalls.every((value) => value === undefined)).toBe(true);
    expect(log.steps.some((line) => line.includes("num_ctx は指定しません"))).toBe(true);
  });
});

describe("モデルが載らなかったとき", () => {
  test("一度も通っていないなら、モデルが大きすぎると伝えて中止する", async () => {
    // 1回目から載らない＝いちばん短い長さすら載らない
    state.loadFailuresLeft = 99;
    const values: Record<string, unknown> = {};
    installSettings(values);
    const { showErrorMessage, showInformationMessage } = answerWith("設定に反映");

    await measureContext(registry);

    // **長さを変えて粘らない。** 直し方は「別のモデルを選ぶ」しかない
    expect(state.numCtxCalls.length).toBe(1);
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

  test("下で通っているなら、その長さは「入らない」と数えて探索を続ける", async () => {
    // 1回目（いちばん短い長さ）は通り、2回目から載らない。
    // **`num_ctx` を長さに合わせた今、載らないのは長さのせいである**
    state.failLoadFromCall = 2;
    installSettings({});
    const { showInformationMessage, showErrorMessage } = answerWith("そのままにする");

    await measureContext(registry);

    // 止まらずに探索を続けている
    expect(state.numCtxCalls.length).toBeGreaterThan(2);
    // 「モデルが大きすぎる」ではなく、ふつうの結果として報告する
    expect(showErrorMessage).not.toHaveBeenCalled();
    const text = allText(showInformationMessage);
    expect(text).toContain("実効の上限");
    // **数え方を隠さない**（エラーを「入らない」と読み替えた件数を出す）
    expect(text).toContain("AIがエラーを返したため");
    expect(
      log.steps.some((line) => line.includes("「入らない」と数えます"))
    ).toBe(true);
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
