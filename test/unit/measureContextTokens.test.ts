import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
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

  /*
    **長さと関係の無い失敗を作る口**（作者の依頼、2026-09-13）。

    実機の Gemini は、ある長さから先で無料枠の分あたりの上限に当たり続けた。
    「この字数を超えたらこの種別で落ちる」という形にしておけば、
    残高切れ・鍵の失効も同じ仕掛けで作れる。
  */
  /** この種別で落とす。undefined なら落とさない */
  failKind: undefined as
    | "rate_limited"
    | "insufficient_credit"
    | "model_not_found"
    | undefined,
  /** この字数を超えた回から落とす */
  failAboveChars: undefined as number | undefined,
  /** あと何回落とすか。使い切ったら素直に返す */
  failTimes: Number.POSITIVE_INFINITY,
  /** 実際に落とした回数。**6回積み上がっていないこと**を見るために要る */
  failCount: 0,

  /** 作者が中止を押したか。待っている途中で押せるかを見る */
  cancelled: false,
  /** 待ちの刻みが何回回ったか。丸ごと60秒待っていないかを見る */
  waitTicks: 0,
  /** この刻み数まで待ったら、作者が中止を押したことにする */
  cancelAtTick: undefined as number | undefined,
  /** 進捗に出した文。待っている理由が作者に見えているかを見る */
  progress: [] as string[],
  /**
   * このモデルが申告する文脈長。
   *
   * **実機の Gemini は 1,024k トークンを申告していた。** 申告が大きいほど
   * 天井も遠くなるので、「窓に当たって止まった字数」と「天井」を
   * はっきり分けたい場面で要る。
   */
  declaredTokens: 262_144,
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
          resolveTimeoutSeconds("ollama", "gemma4:e4b")
        );
        if (
          state.timeoutAboveChars !== undefined &&
          promptChars > state.timeoutAboveChars &&
          state.timeoutTimes > 0
        ) {
          state.timeoutTimes -= 1;
          throw new AIError("時間切れです。", "timeout");
        }
        // **長さと関係の無い失敗。** 長さで引き金を引いているのは、
        // 実機がそう見えた（ある長さから先で必ず当たる）ためであって、
        // 失敗そのものが長さのせいだという意味ではない
        if (
          state.failKind !== undefined &&
          state.failAboveChars !== undefined &&
          promptChars > state.failAboveChars &&
          state.failTimes > 0
        ) {
          state.failTimes -= 1;
          state.failCount += 1;
          throw new AIError(
            state.failKind === "rate_limited"
              ? "レート上限です。"
              : "残高が足りません。",
            state.failKind,
            state.failKind === "rate_limited"
              ? "429 RESOURCE_EXHAUSTED"
              : "credit balance is too low"
          );
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
    /*
      **同梱の初期値（`core/bundledTuning.ts`）が無いモデルを使う**（0.64.0）。

      ここで見たいのは**測り方そのもの**——天井へ跳ぶ・降りる・打ち切る、の
      道筋である。同梱の字/トークンがあるモデルにすると、天井の換算が
      変わって刻み幅ごと動くので、測り方を直していないのに期待値が動く。

      なお、**換算が良くなると天井は広がる**。分あたりの上限に当たり続ける
      相手では、決められた回数（`MAX_RATE_LIMIT_DESCENTS`）の降下で
      通る長さまで届かないことがありうる——同梱したクラウドのモデルは
      どれも上限に当たっていないので、いまは実害が無い（引継ぎ書に記録）。
    */
    model: "gemma4:e4b",
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
        {
          report: (value: unknown) => {
            state.progress.push(String((value as { message?: string }).message));
          },
        },
        {
          // **押した瞬間に立つ旗として持つ。** 固定の false だと、
          // 「待っている途中で中止できるか」を確かめる術が無くなる
          get isCancellationRequested(): boolean {
            return state.cancelled;
          },
          onCancellationRequested: () => {},
        }
      )
  ),
}));

import { measureContext } from "../../src/features/measureContext";

const registry = {
  resolveModelInfo: async () => ({ contextWindow: state.declaredTokens }),
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
    "ollama/gemma4:e4b"
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
  /** 作者が読んだ「失敗しました」の文。出ていなければ空 */
  error: string;
}> {
  const values: Record<string, unknown> = options?.before
    ? { modelTuning: { "ollama/gemma4:e4b": { ...options.before } } }
    : {};
  installSettings(values);
  const showInformationMessage = vi.fn(
    async () => options?.answer ?? "設定に反映"
  );
  // **失敗として報せたかも見る。** 「結果は出せたのに失敗と言った」
  // 「失敗なのに結果らしきものを見せた」のどちらも起こしてはいけない
  const showErrorMessage = vi.fn(async () => undefined);
  Object.assign(window, {
    showInformationMessage,
    showWarningMessage: vi.fn(async () => undefined),
    showErrorMessage,
  });

  // 「読める長さだけ」を選んだ道。書ける長さは別の話なので巻き込まない
  await measureContext(registry, "default", undefined, "input");

  return {
    tuning: ledger(values),
    notice: showInformationMessage.mock.calls
      .map((call) => call.map(String).join(" / "))
      .join("\n"),
    error: showErrorMessage.mock.calls.map((call) => String(call[0])).join("\n"),
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
  state.failKind = undefined;
  state.failAboveChars = undefined;
  state.failTimes = Number.POSITIVE_INFINITY;
  state.failCount = 0;
  state.cancelled = false;
  state.waitTicks = 0;
  state.cancelAtTick = undefined;
  state.progress = [];
  state.declaredTokens = 262_144;

  /*
    **待ちは刻みの回数で見る。** 分あたりの上限に当たったあとの60秒を
    本当に待つと、検査が1回につき1分かかる。眠りの中身は測る対象では
    ないので、刻みが回ったことだけを数えて素通りさせる。

    ここで数えているおかげで、**丸ごと待っていないこと**（＝中止が
    途中で効くこと）も確かめられる。
  */
  vi.stubGlobal("setTimeout", ((handler: () => void): number => {
    state.waitTicks += 1;
    if (
      state.cancelAtTick !== undefined &&
      state.waitTicks >= state.cancelAtTick
    ) {
      // 作者が待っている途中で中止を押した、という場面を作る
      state.cancelled = true;
    }
    handler();
    return 0;
  }) as unknown as typeof setTimeout);
});

afterEach(() => {
  vi.unstubAllGlobals();
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
 * 実機の gemma4:e4b：前回 183,234字で天井に届き `contextHitCeiling: true`。
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
 * 実機の gemma4:e4b は4回の時間切れを「入らない」と数えられ、実効の上限が
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
 * gemma4:e4b は**台帳が既に600秒**だったので、ふだんの上限で挟むと1秒も
 * 延ばせず、時間切れがそのまま結果に化けていた。
 *
 * **ふだんの呼び出しへは持ち込まない。** 測定は1回きりで作者が結果を待って
 * いる場面、ふだんの呼び出しは何十回も走って止まると作業が詰まる場面である。
 */
describe("測定のあいだの待ち時間", () => {
  /** 台帳が既に600秒のモデル（実機の gemma4:e4b と同じ状態） */
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
      modelTuning: { "ollama/gemma4:e4b": { timeoutSeconds: 1200 } },
    });
    expect(resolveTimeoutSeconds("ollama", "gemma4:e4b")).toBe(600);
  });
});

/**
 * **分あたりの上限（`rate_limited`）の扱い**（実機、2026-09-13夜）。
 *
 * `gemini/gemini-flash-lite-latest` は「途中で**6回**、AIがエラーを返した
 * ため、その長さは入らないものとして数えました」と報告し、1,024k トークンを
 * 申告しているのに実効の上限が 186,434字（約135,000トークン）で止まった。
 * **測っていたのはモデルの長さではなく、無料枠の分あたりの窓である。**
 *
 * 直し方は2つ。**数えない**ことと、**待って1回だけ測り直す**ことである。
 */
describe("分あたりの上限に当たったとき", () => {
  /** 実機と同じ字数。ここを超えると無料枠の窓に当たる、という筋 */
  const GEMINI_WALL = 186_434;

  test("待てば通るなら、1回測り直して測定は続く", async () => {
    state.limitChars = 1_000_000;
    state.failKind = "rate_limited";
    state.failAboveChars = 20_000;
    // 1回だけ当たる＝待てば抜ける窓。ここで打ち切ってはいけない
    state.failTimes = 1;

    const { tuning, notice } = await measure();

    // 測り直しが通ったのだから、打ち切りの文は出ない
    expect(notice).not.toContain("分あたりの上限");
    // 20,000字の壁を越えて先まで測れている
    expect(tuning.measuredChars as number).toBeGreaterThan(20_000);
    // **「入らない」とは数えない**（ここが化けの元だった）
    expect(notice).not.toContain("入らないものとして数えました");
  });

  test("待つあいだ、何をしているかを進捗に出す", async () => {
    state.limitChars = 1_000_000;
    state.failKind = "rate_limited";
    state.failAboveChars = 20_000;
    state.failTimes = 1;

    await measure();

    // 1分止まって見えるので、理由を言わないと「固まった」と受け取られる
    expect(state.progress.join("\n")).toContain(
      "分あたりの上限に当たりました。60秒待って測り直します"
    );
  });

  /*
    **測り直してもまた上限なら、その長さは「送れなかった」として降りる**
    （作者の裁定、2026-09-13夜）。

    0.61.1 はここで探索を打ち切っていた。断り方は正しかったが、2回目は
    いきなり天井へ跳ぶ作りなので（設計書6.59）、**天井で当たると1回目の
    4,000字 しか残らない。** 降りて探索を続け、降りたことを印で言う。
  */
  test("**測り直してもまた上限なら、そこは送れないものとして降りる**", async () => {
    state.limitChars = 1_000_000;
    state.failKind = "rate_limited";
    state.failAboveChars = 20_000;
    // 何度当たっても抜けない（無料枠を使い切っている場面）
    state.failTimes = Number.POSITIVE_INFINITY;

    const { tuning, notice, error } = await measure();

    // **打ち切りの文は出ない。** 測れなかったのではなく、降りて測り切った
    expect(notice).not.toContain("これより長い長さは測れていません");
    // **降りたことは必ず言う**（この結果は窓の広さで決まっているかもしれない）
    expect(notice).toContain("AIの分あたりの上限に当たりました");
    expect(notice).toContain("1分のあいだに送れる量");
    expect(notice).toContain("しばらく待ってから測り直す");
    // 窓の手前まで詰めた値が出る。**4,000字で終わらない**
    expect(tuning.measuredChars as number).toBeGreaterThan(4_000);
    expect(tuning.measuredChars as number).toBeLessThanOrEqual(20_000);
    // 結果は出せるのだから、丸ごと失敗にはしない
    expect(error).toBe("");
    // **「入らない」とは数えない**（理由の違う2つを混ぜない）
    expect(notice).not.toContain("入らないものとして数えました");
  });

  test("降りた測定には、台帳に印が残る", async () => {
    state.limitChars = 1_000_000;
    state.failKind = "rate_limited";
    state.failAboveChars = 20_000;
    state.failTimes = Number.POSITIVE_INFINITY;

    const { tuning } = await measure();

    expect(tuning.contextLimitedByRate).toBe(true);
  });

  test("**一度も降りていなければ、印は `false` に書き直される**", async () => {
    // 前回は上限に当たって降りた。今回はどこにも当たらない
    const { tuning, notice } = await measure({
      before: { measuredChars: 4_000, contextLimitedByRate: true },
    });

    /*
      **`undefined` ではなく `false`。** 差分で書く台帳では、省いた欄は
      消えずに前回の印が残る——**上限に当たらなかった強い測定が、弱い印を
      着たまま一覧に並ぶ**（0.61.0 で天井の印を省いて踏んだ穴と同じ）。
    */
    expect(tuning.contextLimitedByRate).toBe(false);
    // 当たっていないのだから、件数の文も出ない
    expect(notice).not.toContain("AIの分あたりの上限に当たりました");
  });

  test("同じ長さでは2回までしか粘らない（窓が分単位とは限らない）", async () => {
    state.limitChars = 1_000_000;
    state.failKind = "rate_limited";
    state.failAboveChars = 20_000;
    state.failTimes = Number.POSITIVE_INFINITY;

    await measure();

    /*
      **長さごとに数える。** 降りるようにしたので、上限に当たる回自体は
      探索の回数ぶん積み上がる。守るべきなのは「**同じ長さ**へ3回目を
      送らない」ことである——3回目は測定ではなく粘りであり、有料AIでは
      そのぶん払うことになる（合言葉は毎回違うが、長さが同じなら
      プロンプト全体の字数も同じになる）。
    */
    const sent = new Map<number, number>();
    for (const call of state.calls) {
      const chars = call.systemPrompt.length + call.userPrompt.length;
      sent.set(chars, (sent.get(chars) ?? 0) + 1);
    }
    expect(Math.max(...sent.values())).toBeLessThanOrEqual(2);
  });

  test("**実機の再現：天井で当たっても、4,000字では終わらない**", async () => {
    /*
      実機（2026-09-13夜、`gemini/gemini-flash-lite-latest`）の再現。

      申告は 1,024k トークンなので、天井は 1,449,826字（約2.9MB）になる。
      無料枠が1分の枠内でこれを受け取れるはずがなく、60秒待って測り直しても
      同じだった。0.61.1 はそこで打ち切ったので、**通っていたのは1回目の
      4,000字 だけ**——「実効の上限は約4,000字」という使いものにならない
      結果が出た。いまは降りて、窓の手前まで詰める。
    */
    state.declaredTokens = 1_024 * 1_024;
    state.limitChars = 10_000_000;
    state.failKind = "rate_limited";
    state.failAboveChars = GEMINI_WALL;
    state.failTimes = Number.POSITIVE_INFINITY;

    const { tuning, notice } = await measure();

    // **ここが今回の眼目。** 1回目の 4,000字 で終わらない
    expect(tuning.measuredChars as number).toBeGreaterThan(100_000);
    expect(tuning.measuredChars as number).toBeLessThanOrEqual(GEMINI_WALL);
    // **窓の広さを「このモデルの実力」として黙って名乗らない**
    expect(notice).toContain("AIの分あたりの上限に当たりました");
    expect(notice).toContain("1分のあいだに送れる量");
    expect(tuning.contextLimitedByRate).toBe(true);
    // **「入らない」とは数えない**（理由の違う2つを混ぜない）
    expect(notice).not.toContain("入らないものとして数えました");
    // 天井まで測れていないのだから、天井の印は立たない
    expect(tuning.contextHitCeiling).toBe(false);
  });

  test("降りた回数が、そのまま文面に出る", async () => {
    state.declaredTokens = 1_024 * 1_024;
    state.limitChars = 10_000_000;
    state.failKind = "rate_limited";
    state.failAboveChars = GEMINI_WALL;
    state.failTimes = Number.POSITIVE_INFINITY;

    const { notice } = await measure();

    /*
      **数えた回数を隠さない。** 何回当たったかは「この結果がどれだけ
      窓に削られているか」の目安になる。1回と8回では、測り直す価値が違う。
      当たった回は1回ずつ測り直しているので、送った回数の半分が降りた回数。
    */
    expect(notice).toContain(`途中で ${state.failCount / 2} 回、`);
  });

  test("待っている途中で中止できる", async () => {
    state.limitChars = 1_000_000;
    state.failKind = "rate_limited";
    state.failAboveChars = 20_000;
    state.failTimes = Number.POSITIVE_INFINITY;
    // 待ちの刻みが3つ回ったところで、作者が中止を押す
    state.cancelAtTick = 3;

    await measure();

    // **60秒を丸ごと待たない。** まとめて待つ作りだと、押しても
    // 1分間なにも起きないように見える（刻みは0.5秒なので満了は120）
    expect(state.waitTicks).toBeLessThan(120);
    expect(state.waitTicks).toBeGreaterThan(0);
    // 中止したのだから、測り直しは送られていない
    expect(state.failCount).toBe(1);
  });
});

/**
 * **残高切れ・鍵の失効は、長さについて何も言っていない**
 * （作者の依頼、2026-09-13）。
 *
 * 0.61.0 までは `aborted` と `timeout` 以外を全部「入らなかった」と
 * 数えていたので、**残高が尽きた瞬間の字数が「実効の上限」になった。**
 * いまは探索を打ち切り、そこまでの `low` を生かして、止まった理由を言う。
 */
describe("待っても直らない失敗に当たったとき", () => {
  test("実効の上限を切り下げず、そこまでの結果を残す", async () => {
    state.limitChars = 1_000_000;
    state.failKind = "insufficient_credit";
    state.failAboveChars = 20_000;

    const { tuning, notice, error } = await measure();

    // **測れたぶんは捨てない**（短い長さでは確かに通っている）
    expect(tuning.measuredChars as number).toBeGreaterThan(0);
    expect(tuning.measuredChars as number).toBeLessThanOrEqual(20_000);
    // 結果を出せるのだから、丸ごと失敗にはしない
    expect(error).toBe("");
    // **「入らない」とは数えない**——残高と長さは無関係である
    expect(notice).not.toContain("入らないものとして数えました");
  });

  test("止まった理由を、AIの本文のまま見せる", async () => {
    state.limitChars = 1_000_000;
    state.failKind = "insufficient_credit";
    state.failAboveChars = 20_000;

    const { notice } = await measure();

    // 直し方の手がかりは向こうの言葉にしかない（CLAUDE.md 規則5）
    expect(notice).toContain("credit balance is too low");
    expect(notice).toContain("そこで測定を止めました");
    expect(notice).toContain("これより長い長さは測れていません");
  });

  test("**「読めない」とは言わない**（分かったのは測れなかったことだけ）", async () => {
    state.limitChars = 1_000_000;
    state.failKind = "insufficient_credit";
    state.failAboveChars = 20_000;

    const { notice } = await measure();

    expect(notice).not.toContain("読めません");
    expect(notice).not.toContain("読めなかった");
  });

  test("一度も通っていなければ、素直に失敗として報せる", async () => {
    // いちばん短い回から落ちる＝出せる結果が無い。
    // ここで「実効の上限は0字です」と言うのがいちばん悪い
    state.failKind = "insufficient_credit";
    state.failAboveChars = 0;

    const { notice, error } = await measure();

    expect(error).toContain("残高が足りません");
    expect(notice).toBe("");
  });

  /*
    **モデルが消えたときも、測れたぶんは捨てない。**

    `model_not_found` は `isFatalProviderFailure` に入っていないので、
    打ち切りの分岐へ明示的に足してある。足さないと `reportFailure` へ落ち、
    **短い長さで確かに通っていた結果まで消える**——測定の途中でモデルが
    外れるのは稀だが、起きたときに失うものが大きい。
  */
  test("モデルが消えても、そこまでの結果を残す", async () => {
    state.limitChars = 1_000_000;
    state.failKind = "model_not_found";
    state.failAboveChars = 20_000;

    const { tuning, notice, error } = await measure();

    expect(tuning.measuredChars as number).toBeGreaterThan(0);
    expect(tuning.measuredChars as number).toBeLessThanOrEqual(20_000);
    expect(error).toBe("");
    expect(notice).not.toContain("入らないものとして数えました");
    expect(notice).toContain("これより長い長さは測れていません");
  });
});

/**
 * **打ち切った測定の結果で、台帳を下書きしない**（作者の裁定、2026-09-13夜）。
 *
 * 実機（Gemini、無料枠）では天井の回で分あたりの上限に当たって打ち切り、
 * **通っていたのは1回目の 4,000字 だけ**だった。それでも確認ダイアログは
 * その 4,000字 を勧めてきた——**押すと台帳の 186,435字 が 4,000字 に化ける。**
 *
 * 打ち切った測定の `low` は「**そこまでは通った**」でしかなく、
 * 「そこまでしか通らない」ではない。上限の情報としては、前回**最後まで
 * 測り切った**値のほうが強い。
 *
 * **歯止めを掛けすぎない。** モデルを別の量子化へ差し替えれば、本当に
 * 短くなることはある。掛けるのは**打ち切ったときだけ**である。
 */
describe("打ち切った測定が、台帳より小さいとき", () => {
  /** 前に測り切ってあった値（実機と同じ字数） */
  const before = { measuredChars: 186_435 };

  /** 時間切れで打ち切らせる。天井の回が返ってこない、という筋 */
  function stopByTimeout(): void {
    state.limitChars = 10_000_000;
    state.timeoutAboveChars = 20_000;
    // 延ばして測り直しても切れる＝打ち切りになる
    state.timeoutTimes = Number.POSITIVE_INFINITY;
  }

  test("**「設定に反映」を出さない**", async () => {
    stopByTimeout();
    const { notice } = await measure({ before });

    // 選択肢そのものを出さない。押せる形で見せた時点で、事故は起こりうる
    expect(notice).not.toContain("設定に反映");
    expect(notice).not.toContain("そのままにする");
  });

  test("**いまの記録のほうが大きいことを言って終える**", async () => {
    stopByTimeout();
    const { notice } = await measure({ before });

    expect(notice).toContain(
      "いまの記録（186,435字）のほうが大きいので、置き換えません"
    );
    // 測れたところまでは、これまでどおり見せる（黙って終えない）
    expect(notice).toContain("実効の上限");
  });

  test("**台帳の値は、そのまま残る**", async () => {
    stopByTimeout();
    const { tuning } = await measure({ before });

    expect(tuning.measuredChars).toBe(186_435);
  });

  test("打ち切った結果のほうが大きければ、これまでどおり反映を訊く", async () => {
    // 前に測ってあったのは 1,000字 だけ。今回のほうが確かに大きい
    stopByTimeout();
    const { notice, tuning } = await measure({
      before: { measuredChars: 1_000 },
    });

    expect(notice).toContain("設定に反映");
    expect(tuning.measuredChars as number).toBeGreaterThan(1_000);
  });

  test("**最後まで測り切ったなら、小さくても反映を訊く**", async () => {
    /*
      **歯止めを掛けすぎない。** モデルを別の量子化へ差し替えたときのように、
      本当に短くなることはある。そのときに小さい値で上書きできなければ、
      台帳は古い値のまま永久に直せない。
    */
    // 打ち切らずに測り切る。読めるのは 30,000字 まで（前回より短い）
    const { notice, tuning } = await measure({ before });

    expect(notice).toContain("設定に反映");
    expect(tuning.measuredChars as number).toBeLessThanOrEqual(30_000);
    expect(notice).not.toContain("置き換えません");
  });

  test("**分あたりの上限で降りた測定にも掛からない**（打ち切りではない）", async () => {
    /*
      降りた測定は最後まで測り切っている——「そこまでしか通らない」を
      二分探索で詰めた値である。打ち切りと同じ歯止めを掛けると、
      **無料枠のAIでは台帳が永久に直せなくなる。**

      **蓋（`MAX_RATE_LIMIT_DESCENTS`）に届かない筋にしてある。** 届くと
      それは打ち切りであり、歯止めが掛かるのが正しい（次のテストで見る）。
      壁を天井の近くへ置けば、降りるのは1〜2段で済む。
    */
    state.limitChars = 10_000_000;
    state.declaredTokens = 40_960;
    state.failKind = "rate_limited";
    state.failAboveChars = 20_000;
    state.failTimes = Number.POSITIVE_INFINITY;

    const { notice } = await measure({ before });

    expect(notice).toContain("設定に反映");
    expect(notice).not.toContain("置き換えません");
  });

  /*
    **蓋に届いたら、それは打ち切りである**（作者の裁定、2026-09-13夜）。

    1段ごとに60秒待つので、降りる段が増えるほど作者の待ち時間が積み上がる。
    蓋で止めたときの `low` は「そこまでは通った」でしかないので、
    台帳に大きい値があるならそちらを残す。
  */
  test("蓋まで降りきったときは、台帳を守る", async () => {
    state.limitChars = 10_000_000;
    state.declaredTokens = 262_144;
    state.failKind = "rate_limited";
    state.failAboveChars = 20_000;
    state.failTimes = Number.POSITIVE_INFINITY;

    const { notice } = await measure({ before });

    expect(notice).toContain("これ以上は待たずに");
    expect(notice).toContain("置き換えません");
    expect(notice).not.toContain("設定に反映");
  });

  test("台帳が空なら、これまでどおり反映を訊く（比べる相手が無い）", async () => {
    stopByTimeout();
    const { notice } = await measure();

    expect(notice).toContain("設定に反映");
  });
});
