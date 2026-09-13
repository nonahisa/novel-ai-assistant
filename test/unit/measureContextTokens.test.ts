import { beforeEach, describe, expect, test, vi } from "vitest";
import { window, workspace } from "./support/vscodeStub";
import type { AIRegistry } from "../../src/ai/registry";
import { AIError } from "../../src/ai/types";
import type { GenerateParams, GenerateResult } from "../../src/ai/types";
import { resolveTimeoutSeconds } from "../../src/core/modelTuning";

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
  /**
   * この字数を超えたら時間切れにする。**遅いモデルの真似である**——
   * 本当は読めるのに、待ち時間のうちに返ってこないという回を作る。
   */
  timeoutAboveChars: undefined as number | undefined,
  /** 時間切れを何回起こしてよいか。これを超えたら素直に返す */
  timeoutTimes: Number.POSITIVE_INFINITY,
  /** その回に効いていた待ち時間（秒）。延ばしたぶんが届いたかを見る */
  timeoutSecondsSeen: [] as number[],
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
        /*
          **その回に効いていた待ち時間を控える。** 台帳へ書いた値が
          読む側（`tunedTimeoutSeconds`）の線で挟まれていないかは、
          ここでしか確かめられない——書けているのに効かない、という
          壊れ方をするので（CLAUDE.mdの失敗6「通ったことを確認したら、
          次に何を確認したことになるのかを問う」）。
        */
        state.timeoutSecondsSeen.push(
          resolveTimeoutSeconds("ollama", "gemma4:12b")
        );
        if (
          state.timeoutAboveChars !== undefined &&
          promptChars > state.timeoutAboveChars &&
          state.timeoutTimes > 0
        ) {
          state.timeoutTimes -= 1;
          throw new AIError("時間切れです。", "timeout");
        }
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
async function measure(options?: {
  /**
   * 測る前から台帳に入っている値。
   *
   * **前回の測定の印が残っている状態を作るために要る。** 差分で書く台帳
   * では、書かなかった欄は消えずに残る（これが穴だった）。
   */
  before?: Record<string, unknown>;
  /** 作者が確認ダイアログで押すもの。既定は反映する */
  answer?: string;
}): Promise<{
  tuning: Record<string, unknown>;
  notice: string;
}> {
  const values: Record<string, unknown> = options?.before
    ? { modelTuning: { "ollama/gemma4:12b": { ...options.before } } }
    : {};
  installSettings(values);
  const showInformationMessage = vi.fn(
    async () => options?.answer ?? "設定に反映"
  );
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
  state.timeoutAboveChars = undefined;
  state.timeoutTimes = Number.POSITIVE_INFINITY;
  state.timeoutSecondsSeen = [];
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
    // **`undefined` ではなく `false`。** 届かなかったことも毎回書くように
    // した（前回の印が残り続けるのを止めるため。下の「天井の印を、毎回
    // 書き直す」に理由がある）
    expect(tuning.contextHitCeiling).toBe(false);
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

/**
 * **天井の印は、毎回書き直す**（作者の指摘、2026-09-13）。
 *
 * 台帳は**差分で書く**ので、書かなかった欄は消えずに残る。天井へ届かな
 * かったときに項目ごと省いていたため、**前回の測定で立った印が残り続けた。**
 *
 * 実機の gemma4:12b：前回 183,234字で天井に届き `contextHitCeiling: true`。
 * 0.60.1 で天井が 362,191字へ広がったあと測り直すと 194,288字——天井には
 * まるで届いていないのに、一覧には「これ以上は試していません」と出た。
 * **強い測定が、弱い印を着たままになる。**
 */
describe("天井の印を、毎回書き直す", () => {
  test("**天井に届かなければ、前回の印を消す**（実機の再現）", async () => {
    // 前回は天井に届いていた。今回は届かない（読めるのは30,000字まで）
    const { tuning } = await measure({
      before: { measuredChars: 183_234, contextHitCeiling: true },
    });

    expect(tuning.measuredChars as number).toBeLessThanOrEqual(30_000);
    // **`undefined` ではなく `false`。** 消えたのではなく、
    // 「測ったが届かなかった」と書き直されている
    expect(tuning.contextHitCeiling).toBe(false);
  });

  test("天井まで届いたときは、これまでどおり印が立つ", async () => {
    // 天井（申告262,144トークンぶん）より長く読めるAIの真似
    state.limitChars = 1_000_000;
    const { tuning } = await measure();

    expect(tuning.contextHitCeiling).toBe(true);
  });
});

/**
 * **時間切れを「入らなかった」と数えない**（作者の依頼、2026-09-13）。
 *
 * 時間切れが言っているのは「待っているあいだに返らなかった」であって、
 * 「入らなかった」ではない——**遅いのか長すぎるのかが区別できていない。**
 * 実機の gemma4:12b は4回の時間切れを「入らない」と数えられ、実効の上限が
 * 194,288字で止まった（天井は 362,191字）。
 *
 * **「測れなかった」を「読めなかった」と言い換えない。** ここがいちばん
 * 大事なので、台帳だけでなく**作者が読む文面**まで見る。
 */
describe("時間切れの扱い", () => {
  test("**打ち切ったことと理由が、文面に出る**", async () => {
    // 20,000字を超えると返ってこない。延ばして測り直しても同じ
    state.limitChars = 1_000_000;
    state.timeoutAboveChars = 20_000;
    const { notice } = await measure();

    expect(notice).toContain("時間切れになりました");
    expect(notice).toContain("測れていません");
    expect(notice).toContain("もっと読める可能性があります");
  });

  test("「入らないものとして数えました」とは言わない", async () => {
    state.limitChars = 1_000_000;
    state.timeoutAboveChars = 20_000;
    const { notice } = await measure();

    expect(notice).not.toContain("入らないものとして数えました");
  });

  test("そこまでの結果は捨てない（`low` を生かして終える）", async () => {
    state.limitChars = 1_000_000;
    state.timeoutAboveChars = 20_000;
    const { tuning } = await measure();

    // 時間切れの手前までは確かに測れている
    expect(tuning.measuredChars as number).toBeGreaterThan(0);
    expect(tuning.measuredChars as number).toBeLessThanOrEqual(20_000);
    // 打ち切ったのだから、天井には届いていない
    expect(tuning.contextHitCeiling).toBe(false);
  });
});

/**
 * **測定のあいだだけ、待ち時間の上限を別にする**（作者の依頼、2026-09-13）。
 *
 * `MAX_TIMEOUT_SECONDS`（600）は天井が半分だった頃の数字である。実機の
 * gemma4:12b は**台帳が既に600秒**だったので、ふだんの上限で挟むと1秒も
 * 延ばせず、時間切れがそのまま結果に化けていた。
 *
 * **ふだんの呼び出しへは持ち込まない。** 測定は1回きりで作者が結果を待って
 * いる場面、ふだんの呼び出しは何十回も走って止まると作業が詰まる場面である。
 */
describe("測定のあいだの待ち時間", () => {
  /** 台帳が既に600秒のモデル（実機の gemma4:12b と同じ状態） */
  const before = { timeoutSeconds: 600 };

  test("**600秒からでも延ばせて、その値が実際に効く**", async () => {
    state.limitChars = 1_000_000;
    state.timeoutAboveChars = 20_000;
    // 1回だけ時間切れ。延ばして測り直せば通る＝「遅かっただけ」のモデル
    state.timeoutTimes = 1;
    const { notice } = await measure({ before });

    // **書けただけでは足りない。** 読む側の線で挟まれていないことを見る
    expect(Math.max(...state.timeoutSecondsSeen)).toBe(1200);
    expect(notice).toContain("待ち時間を一時的に 1200 秒へ");
  });

  test("**台帳へ書く待ち時間は、600秒を超えない**", async () => {
    state.limitChars = 1_000_000;
    state.timeoutAboveChars = 20_000;
    state.timeoutTimes = 1;
    const { tuning } = await measure({ before });

    expect(tuning.timeoutSeconds as number).toBeLessThanOrEqual(600);
  });

  test("反映しなければ、延ばした待ち時間は元へ戻る", async () => {
    state.limitChars = 1_000_000;
    state.timeoutAboveChars = 20_000;
    state.timeoutTimes = 1;
    const { tuning } = await measure({
      before,
      answer: "そのままにする",
    });

    expect(tuning.timeoutSeconds).toBe(600);
  });

  test("**測定が終われば、ふだんの上限（600秒）に戻る**", async () => {
    state.limitChars = 1_000_000;
    state.timeoutAboveChars = 20_000;
    state.timeoutTimes = 1;
    await measure({ before });

    // 測ったあとに1,200秒が台帳に居座っても、ふだんの呼び出しは600秒で挟む
    installSettings({
      modelTuning: { "ollama/gemma4:12b": { timeoutSeconds: 1200 } },
    });
    expect(resolveTimeoutSeconds("ollama", "gemma4:12b")).toBe(600);
  });
});
