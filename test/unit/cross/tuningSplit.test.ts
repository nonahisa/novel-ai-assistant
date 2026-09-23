import { beforeEach, describe, expect, test, vi } from "vitest";
import { window, workspace } from "./support/vscodeStub";
import type { AIRegistry } from "../../src/ai/registry";
import { AIError } from "../../src/ai/types";
import type {
  GenerateParams,
  GenerateResult,
  ProviderId,
} from "../../src/ai/types";
import { isCancelItem } from "../../src/views/dialogs";
import {
  measuresInput,
  measuresOutput,
  TUNING_SCOPE_CHOICES,
} from "../../src/core/tuningScope";

/**
 * AIチューニングを「読める長さ」と「書ける長さ」に分ける
 * （作者の依頼、2026-09-13。設計書6.27.11・6.61）。
 *
 * 実機では、読める長さが数分で終わるのに対し、書ける長さは1時間以上
 * かかった（qwen3.8:latest・qwen3:8b）。しかも**遅いモデルほど時間切れ**に
 * なり、その値は1回の応答の上限としては使わない。読める長さだけ知りたい
 * 作者が、毎回1時間付き合わされていた。
 *
 * ここで守るのは4点である。
 *
 * 1. 選ぶ画面に3つ並び、**どれも待ち時間の目安を言う**こと
 * 2. 「読める長さだけ」では書ける長さを測らず、その逆も同じこと
 * 3. 「両方」は**これまでと同じ順**で測ること
 * 4. **測らなかったほうの台帳の値が残る**こと
 */

/** 0001 から n 行ぶんの、正しい返事 */
function perfect(n: number): string {
  return Array.from({ length: n }, (_, i) =>
    String(i + 1).padStart(4, "0")
  ).join("\n");
}

const state = vi.hoisted(() => ({
  providerId: "ollama" as ProviderId,
  /** このAIが1回の応答で本当に書ける行数 */
  trueLimit: 9999,
  /** `generate` が受け取った引数を、送った順に残す */
  calls: [] as GenerateParams[],
  /**
   * 出力の測定で、次の1回だけ時間切れにする。
   *
   * 「時間切れの回が混じったら、測った値を上限には使わないと言う」
   * （`measureContext.ts` の `measureOutputLimit`）を確かめるために使う。
   */
  timeoutOnNextOutputCall: false,
}));

const log = vi.hoisted(() => ({
  steps: [] as string[],
}));

vi.mock("../../src/core/logger", () => ({
  logStep: vi.fn((message: string) => {
    log.steps.push(message);
  }),
  logLine: vi.fn((message: string) => {
    log.steps.push(message);
  }),
  logFailure: vi.fn(),
  showLog: vi.fn(),
  useLogFile: vi.fn(),
}));

vi.mock("../../src/ai/registry", () => ({
  ensureConfigured: vi.fn(async () => ({
    provider: {
      id: state.providerId,
      displayName: "検査用",
      isPaid: false,
      generate: async (params: GenerateParams): Promise<GenerateResult> => {
        state.calls.push(params);

        // 出力の測定：頼まれた行数まで（ただし本当に書ける量まで）返す
        const asked = /0001 から順に (\d+) 行/.exec(params.userPrompt)?.[1];
        if (asked !== undefined) {
          if (state.timeoutOnNextOutputCall) {
            state.timeoutOnNextOutputCall = false;
            throw new AIError("応答がタイムアウトしました。", "timeout");
          }
          const lines = Math.min(Number(asked), state.trueLimit);
          return {
            text: perfect(lines),
            usage: { inputTokens: 0, outputTokens: lines * 3 },
            truncated: lines < Number(asked),
            elapsedMs: 1,
          };
        }

        // 入力の測定：合言葉を書き写す
        const head = /ひとつ目の合言葉は『(.+?)』/.exec(params.userPrompt)?.[1] ?? "";
        const tail = /ふたつ目の合言葉は『(.+?)』/.exec(params.userPrompt)?.[1] ?? "";
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
  // 手元AIの判定（`ai/otherLocalAi.ts`）が同じ束に入るので、口だけ塞ぐ
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

import {
  askTuningScope,
  measureContext,
} from "../../src/features/measureContext";
import {
  tuningStoreContents,
  useMemoryTuningStore,
} from "./support/tuningStore";

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
  resolveModelInfo: async () => ({ contextWindow: 262144 }),
} as unknown as AIRegistry;

function answerWith(answer: string): ReturnType<typeof vi.fn> {
  const showInformationMessage = vi.fn(async () => answer);
  Object.assign(window, {
    showInformationMessage,
    showWarningMessage: vi.fn(async () => undefined),
    showErrorMessage: vi.fn(async () => undefined),
  });
  return showInformationMessage;
}

/** 通知に出た文（作者が実際に読むもの） */
function noticeText(showInformationMessage: ReturnType<typeof vi.fn>): string {
  return showInformationMessage.mock.calls
    .map((call) => call.map(String).join(" / "))
    .join("\n");
}

/** 出力の測定として送られた呼び出し */
function outputCalls(): GenerateParams[] {
  return state.calls.filter((call) => call.userPrompt.includes("4桁の数字"));
}

/** 入力の測定として送られた呼び出し */
function inputCalls(): GenerateParams[] {
  return state.calls.filter((call) => call.userPrompt.includes("合言葉"));
}

/**
 * その鍵の台帳（`<保管庫>/model-tuning.json`）。
 *
 * 0.66.5 までは設定 `novelai.modelTuning` だった（0.66.6 で移した）。
 */
function ledger(): Record<string, unknown> {
  return (tuningStoreContents()["ollama/gemma4:12b"] ?? {}) as Record<
    string,
    unknown
  >;
}

beforeEach(async () => {
  state.providerId = "ollama";
  state.trueLimit = 9999;
  state.calls = [];
  state.timeoutOnNextOutputCall = false;
  log.steps = [];
  // 台帳は 0.66.6 で保管庫のファイルへ移った。**毎回、空から始める**
  await useMemoryTuningStore({});
});

describe("何を測るかを選ぶ", () => {
  test("3つ並び、どれも待ち時間の目安を言う", () => {
    expect(TUNING_SCOPE_CHOICES.map((choice) => choice.scope)).toEqual([
      "input",
      "output",
      "both",
    ]);
    for (const choice of TUNING_SCOPE_CHOICES) {
      // **選ぶのに要るのは、まず「どれだけ待つか」である**
      // （今回の困りごとがそこだった）
      expect(choice.detail).toMatch(/分|時間/);
      expect(choice.label.length).toBeGreaterThan(0);
    }
    // 書ける長さのほうは、長くかかることと手元のAIだけであることを言う
    const output = TUNING_SCOPE_CHOICES[1];
    expect(output.detail).toContain("1時間");
    expect(output.detail).toContain("手元のAI");
    // 読める長さのほうは、数分で終わると言う
    expect(TUNING_SCOPE_CHOICES[0].detail).toContain("数分");
    // 両方は「これまでと同じ」であることを言う
    expect(TUNING_SCOPE_CHOICES[2].detail).toContain("これまでと同じ");
  });

  test("画面に出す言葉にMarkdownの記号を混ぜない", () => {
    // VS Codeの選択画面はプレーンテキストなので、記号がそのまま出る
    for (const choice of TUNING_SCOPE_CHOICES) {
      for (const text of [choice.label, choice.detail]) {
        expect(text).not.toContain("**");
        expect(text.trimStart().startsWith("#")).toBe(false);
      }
    }
  });

  test("「取りやめる」が末尾にあり、選ぶと何も測らない", async () => {
    let items: unknown[] = [];
    const showQuickPick = vi.fn(async (given: unknown[]) => {
      items = given;
      // 取りやめを選んだ体にする
      return given[given.length - 1];
    });
    Object.assign(window, { showQuickPick });

    expect(await askTuningScope()).toBeUndefined();
    expect(items).toHaveLength(TUNING_SCOPE_CHOICES.length + 1);
    expect(isCancelItem(items[items.length - 1])).toBe(true);
  });

  test("選んだものが、そのまま範囲として返る", async () => {
    const showQuickPick = vi.fn(async (given: unknown[]) => given[1]);
    Object.assign(window, { showQuickPick });

    expect(await askTuningScope()).toBe("output");
  });

  test("どちらを走らせるかの判断", () => {
    expect(measuresInput("input")).toBe(true);
    expect(measuresOutput("input")).toBe(false);
    expect(measuresInput("output")).toBe(false);
    expect(measuresOutput("output")).toBe(true);
    expect(measuresInput("both")).toBe(true);
    expect(measuresOutput("both")).toBe(true);
  });
});

describe("読める長さだけ測る", () => {
  test("書ける長さは測らない", async () => {
    installSettings({});
    const showInformationMessage = answerWith("そのままにする");

    await measureContext(registry, "default", undefined, "input");

    expect(inputCalls().length).toBeGreaterThan(0);
    // **1回も頼まない。** ここが今回の目的である
    expect(outputCalls()).toEqual([]);
    const text = noticeText(showInformationMessage);
    expect(text).toContain("実効の上限");
    // 測っていないものの数字を混ぜない
    expect(text).not.toContain("書けたのは");
    expect(text).not.toContain("まとめ送信の上限");
  });

  test("前に測った書ける長さは、台帳に残る", async () => {
    installSettings({});
    await useMemoryTuningStore({
      "ollama/gemma4:12b": {
        measuredOutputTokens: 4321,
        outputTokensPerSecond: 12.5,
        speedSource: "tuning",
      },
    });
    answerWith("設定に反映");

    await measureContext(registry, "default", undefined, "input");

    const tuning = ledger();
    // 読める長さの結果は入る
    expect(tuning.measuredChars).toBeGreaterThan(0);
    expect(tuning.timeoutSeconds).toBeGreaterThan(0);
    // **測っていない欄は、そのまま残る**（黙って消さない）
    expect(tuning.measuredOutputTokens).toBe(4321);
    expect(tuning.outputTokensPerSecond).toBe(12.5);
    expect(tuning.speedSource).toBe("tuning");
  });
});

describe("書ける長さだけ測る", () => {
  test("読める長さは測らず、その確認も出さない", async () => {
    installSettings({});
    const showInformationMessage = answerWith("そのままにする");

    await measureContext(registry, "default", undefined, "output");

    expect(outputCalls().length).toBeGreaterThan(0);
    // **合言葉は1回も送らない**
    expect(inputCalls()).toEqual([]);
    const text = noticeText(showInformationMessage);
    expect(text).toContain("書けたのは");
    // 読める長さの確認（「設定に反映」を訊くダイアログ）は出さない
    expect(text).not.toContain("設定に反映");
    expect(text).not.toContain("待ち時間");
    expect(text).not.toContain("実効の上限");
  });

  test("前に測った読める長さは、台帳に残る", async () => {
    installSettings({});
    await useMemoryTuningStore({
      "ollama/gemma4:12b": {
        measuredChars: 123456,
        timeoutSeconds: 240,
      },
    });
    answerWith("そのままにする");

    await measureContext(registry, "default", undefined, "output");

    const tuning = ledger();
    expect(tuning.measuredOutputTokens).toBeGreaterThan(0);
    // **測っていない欄は、そのまま残る**
    expect(tuning.measuredChars).toBe(123456);
    expect(tuning.timeoutSeconds).toBe(240);
  });

  test("クラウドAIでは測らず、その理由を言う", async () => {
    // 申告値がAPIから取れるうえ、出力トークンは単価が高い（設計書6.61）
    state.providerId = "gemini";
    installSettings({});
    const showInformationMessage = answerWith("そのままにする");

    await measureContext(registry, "default", undefined, "output");

    expect(state.calls).toEqual([]);
    expect(noticeText(showInformationMessage)).toContain("手元のAI");
  });
});

/**
 * 時間切れの回が混じった実測は、上限として送ってはいけない
 * （`ai/outputLimit.ts` の `resolveOutputLimitForSend`）。**遅いだけの
 * モデルでは、実際には書けるのに小さい実測が出る**ためで、その値を
 * ハード上限にすると「測っただけで以後すべての応答が切られる」。
 *
 * 分岐に入る条件（時間切れが混じった）と入らない条件（一度も無い）の
 * 両方を見る——片方だけでは「常にこの文言が出る／出ない」実装でも
 * 満点になってしまう。
 */
describe("書ける長さの時間切れ", () => {
  test("時間切れが混じったら、その値を上限には使わないと言う", async () => {
    installSettings({});
    state.timeoutOnNextOutputCall = true;
    const showInformationMessage = answerWith("そのままにする");

    await measureContext(registry, "default", undefined, "output");

    // 時間切れの回があっても、探索そのものは続いて結果が出る
    expect(outputCalls().length).toBeGreaterThan(1);
    const text = noticeText(showInformationMessage);
    expect(text).toContain("書けたのは");
    expect(text).toContain("上限としては使いません");
  });

  test("時間切れが一度も無ければ、上限に使わないとは言わない", async () => {
    installSettings({});
    const showInformationMessage = answerWith("そのままにする");

    await measureContext(registry, "default", undefined, "output");

    expect(outputCalls().length).toBeGreaterThan(0);
    const text = noticeText(showInformationMessage);
    expect(text).toContain("書けたのは");
    expect(text).not.toContain("上限としては使いません");
  });
});

describe("測定の呼び出しは、思考モードを切る", () => {
  /*
    **渡し忘れると、測定そのものが壊れる**（実機、2026-09-13。qwen3:8b）。

    思考を切らずに出力を絞ると、考えごとで枠を使い切って答えが空になり、
    製品はそれを「この長さは入らなかった」と数える。二分探索が下へ降りて
    いくので、**素で投げれば30,000字まで読めるモデルが2,750字と判定される。**
    切れば出力9トークンで両方正解する。CLAUDE.md 規則6そのものの話なので、
    ここで固定して再発しない形にする。
  */
  test("読める長さの検査も、書ける長さの検査も think を切っている", async () => {
    installSettings({});
    answerWith("そのままにする");

    await measureContext(registry, "default", undefined, "both");

    expect(inputCalls().length).toBeGreaterThan(0);
    expect(outputCalls().length).toBeGreaterThan(0);
    for (const call of [...inputCalls(), ...outputCalls()]) {
      expect(call.disableThinking).toBe(true);
    }
  });

  test("片方だけ測るときも切る", async () => {
    installSettings({});
    answerWith("そのままにする");
    await measureContext(registry, "default", undefined, "input");
    expect(inputCalls().every((call) => call.disableThinking === true)).toBe(
      true
    );

    state.calls = [];
    await measureContext(registry, "default", undefined, "output");
    expect(outputCalls().every((call) => call.disableThinking === true)).toBe(
      true
    );
  });
});

describe("両方まとめて測る", () => {
  test("これまでどおり、読める長さのあとに書ける長さを測る", async () => {
    installSettings({});
    const showInformationMessage = answerWith("そのままにする");

    await measureContext(registry, "default", undefined, "both");

    expect(inputCalls().length).toBeGreaterThan(0);
    expect(outputCalls().length).toBeGreaterThan(0);
    // 順番も変えない（先に合言葉、あとから数字）
    //
    // 合言葉は何度も投げるので、**後ろから探して最後の1回**を見る。
    // `Array.findLastIndex` は ES2023 の追加で、この製品の `lib`（ES2022）には
    // 無いため、後ろへ向かう素直な繰り返しで書いている
    const lastIndexOfPrompt = (needle: string): number => {
      for (let i = state.calls.length - 1; i >= 0; i--) {
        if (state.calls[i].userPrompt.includes(needle)) return i;
      }
      return -1;
    };
    const lastInput = lastIndexOfPrompt("合言葉");
    const firstOutput = state.calls.findIndex((call) =>
      call.userPrompt.includes("4桁の数字")
    );
    expect(firstOutput).toBeGreaterThan(lastInput);

    // 2つの結果が1つの通知に並ぶ（従来どおり）
    const text = noticeText(showInformationMessage);
    expect(text).toContain("実効の上限");
    expect(text).toContain("書けたのは");
  });

  test("省略したときも「両方」として動く（従来の呼び出しを変えない）", async () => {
    installSettings({});
    answerWith("そのままにする");

    await measureContext(registry);

    expect(inputCalls().length).toBeGreaterThan(0);
    expect(outputCalls().length).toBeGreaterThan(0);
  });
});
