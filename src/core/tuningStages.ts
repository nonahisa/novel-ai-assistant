/**
 * AIチューニングの「仕事に近い形の測定」を、**段の並び**として持つ
 * （設計書6.49.9。作者の判断、2026-09-26）。
 *
 * ## 段を並べる作りにした理由
 *
 * 読める長さの測定（`features/measureContext.ts`）は、1本の長い関数が
 * 送る・数える・結果を出すを全部抱えている。測るものを足すたびに、その
 * 関数へ分岐が増えてきた。ここからは**1つの段＝1つの測りもの**にして、
 * 段の一覧（`TUNING_STAGES`）に並べる。足すときは一覧へ1行と、
 * `features/tuningStageRunners.ts` の走らせ方を1つ足すだけで、
 * 回数の見込み（有料AIの確認に出す）も、進み具合の表示も、結果の文面も
 * 一覧から組まれる。
 *
 * このファイルは**判断だけ**を持つ（段の一覧・回数・測った値の読み方）。
 * 送るのは `features/` の側である。VS Code API に依存しない。
 */

import { CHUNK_TIME_LADDER } from "./chunkTimeFit";
// 見込みの式は時間の見積もりの側に1つだけ置く（輪を作らないため。理由は向こう）
import { predictWorkSeconds, type WorkRate } from "./etaEstimate";
export { predictWorkSeconds, type WorkRate };

/**
 * 仕事に近い形の測定で送るときの機能名（`meta.feature`）。
 *
 * **関所（`ai/contextGuard.ts`）は素通りさせない**——製品と同じ検査を通して
 * 測る（CLAUDE.md「実接続の測定は、製品と同じ検証を通す」）。そのために
 * 読める長さの測定（`context_probe`）とは別の名前にしてある。
 *
 * **機能ごとの出力量の台帳には残さない**（`ai/meteredProvider.ts` の
 * `recordFeatureOutput`）。同梱の短い文への答えの量は、どの機能の普段の
 * 量でもない。速さと字/トークンは、製品の道を通った本物の応答なので
 * ふつうに採る。
 */
export const TUNING_WORK_FEATURE = "ai_tuning_work";

/** 段の名前。**並べる順は `TUNING_STAGES` が決める** */
export type TuningStageId = "thinking" | "work" | "declaredLimit";

/** どのAIを測るか（段が「このAIで走るか」「何回送るか」を決める材料） */
export interface TuningStageTarget {
  readonly providerId: string;
  /** 手元のAI（Ollama・LM Studio）か */
  readonly local: boolean;
}

/** 段の決まりごと。走らせ方は `features/tuningStageRunners.ts` にある */
export interface TuningStageSpec {
  readonly id: TuningStageId;
  /** 進み具合と結果の文面に出す名前 */
  readonly label: string;
  /** このAIで走らせるか */
  appliesTo(target: TuningStageTarget): boolean;
  /**
   * いちばん多く送る回数。**有料AIの確認にそのまま出す**ので、少なく
   * 見せる側へは倒さない（途中で決まれば、これより少なく済む）。
   */
  maxCalls(target: TuningStageTarget): number;
}

/**
 * 読める長さを、断られた文から読める相手（設計書6.22.1①）。
 *
 * **申告が当て推量のプロバイダだけ**——さくら・ChatGPT は、作者が設定に
 * 書いた値か製品の既定しか持っていない。Ollama・Gemini・Claude・LM Studio は
 * APIが長さを教えるので、断らせて読む必要が無い（規則6「APIが教えて
 * くれる値はAPIを優先」）。`features/measureContext.ts` の
 * `GUESSED_CONTEXT_PROVIDERS` と同じ顔ぶれである。
 */
const DECLARED_LIMIT_PROVIDERS: ReadonlySet<string> = new Set([
  "sakura",
  "openai",
]);

/**
 * 段の一覧。**上から順に走らせる。**
 *
 * 1. **思考の見分け**を先に置く。手元のAIでは、ここで最初にモデルが
 *    読み込まれる（読み込みの時間は、時間の測定に混ぜない）
 * 2. **仕事に近い時間**。誤字脱字と同じ形で、短い文と長い文を1回ずつ送る。
 *    手元のAIでは、その前に測る形の1回を入れる（数えない）
 * 3. **読める長さの申告**。断られた文から読み、収まる要求が通ることで
 *    確かめる（さくら・ChatGPT だけ）
 */
export const TUNING_STAGES: readonly TuningStageSpec[] = [
  {
    id: "thinking",
    label: "考えるモデルかの見分け",
    appliesTo: () => true,
    // 思考を止める指定を「送らない回」と「送る回」
    maxCalls: () => 2,
  },
  {
    id: "work",
    label: "仕事に近い形の時間",
    appliesTo: () => true,
    /*
      短い文と長い文で2回。**手元のAIは、測る形で読み込ませる1回を足す**
      ——前の段の送り方（出力の上限の広さ）が違うと、Ollama は文脈の長さが
      変わってモデルを読み込み直す。その時間が最初の1回に丸ごと乗ると、
      1回ごとの固定の時間が数十秒ずれる（実接続 2026-09-26、gemma4:e4b）。
    */
    maxCalls: (target) => (target.local ? 3 : 2),
  },
  {
    id: "declaredLimit",
    label: "読める長さの申告",
    appliesTo: (target) => DECLARED_LIMIT_PROVIDERS.has(target.providerId),
    // 断らせる1回と、その長さに収まる要求が通るかを確かめる1回
    maxCalls: () => 2,
  },
];

/** そのAIで走る段（並びの順のまま） */
export function plannedStages(
  target: TuningStageTarget,
  stages: readonly TuningStageSpec[] = TUNING_STAGES
): TuningStageSpec[] {
  return stages.filter((stage) => stage.appliesTo(target));
}

/** そのAIで、いちばん多く送る回数の合計 */
export function plannedCallCount(
  target: TuningStageTarget,
  stages: readonly TuningStageSpec[] = TUNING_STAGES
): number {
  return plannedStages(target, stages).reduce(
    (total, stage) => total + stage.maxCalls(target),
    0
  );
}

/**
 * 有料AIの確認に出す、回数の内訳（作者の決まり「確認は処理量とコストを
 * 示してから」）。
 *
 * **段ごとの回数と合計の両方を出す。** 合計だけだと、どこで何回使うのかが
 * 読めない。
 */
export function describeStagePlan(
  target: TuningStageTarget,
  stages: readonly TuningStageSpec[] = TUNING_STAGES
): string {
  const planned = plannedStages(target, stages);
  const parts = planned.map(
    (stage) => `${stage.label} ${stage.maxCalls(target)}回`
  );
  return (
    `${parts.join("・")}——合わせて最大 ${plannedCallCount(target, stages)} 回送ります` +
    "（途中で決まれば、これより少なく済みます）。"
  );
}

/* ── 思考の見分け ─────────────────────────────────── */

/** 1回の応答で見えたこと（`features/tuningStageRunners.ts` が組む） */
export interface ThinkingObservation {
  /** 思考の欄（Ollama の `thinking`、さくらの `reasoning`）に返った字数 */
  readonly thinkingChars: number;
  /** 答えの欄の字数 */
  readonly answerChars: number;
  /** AIが申告した出力トークン数。申告しないAIでは undefined */
  readonly outputTokens?: number;
}

/**
 * 思考の欄が無いAIで、**出力トークン数が答えの字数に比べて多すぎる**と
 * 見る倍率とゆとり。
 *
 * 日本語のJSONは1字1トークンを超えることがまず無い（実測の字/トークンは
 * どのモデルも1を超えている）。答えの字数の1.5倍に256トークンを足しても
 * 超えるなら、答えの外で何かを書いている——思考を別の欄に返さない
 * サーバー（ChatGPT の思考する型など）で見分けるための線である。
 * **当て推量なので、弱い証拠として扱う**：思考の欄が見えたときは
 * こちらを見ない。
 */
const HIDDEN_THINKING_RATIO = 1.5;
const HIDDEN_THINKING_SLACK_TOKENS = 256;

/** その応答で、思考が出ていたか */
export function sawThinking(observation: ThinkingObservation): boolean {
  if (observation.thinkingChars > 0) return true;
  if (observation.outputTokens === undefined) return false;
  return (
    observation.outputTokens >
    observation.answerChars * HIDDEN_THINKING_RATIO + HIDDEN_THINKING_SLACK_TOKENS
  );
}

/**
 * その応答で、思考に使ったと見るトークン数。
 *
 * 出力トークン数が分かれば、そこから答えの字数を引く。答えは1字1トークンを
 * 超えないので、答えのトークン数を多めに引いたぶん**思考は少なめに出る**
 * ——それを下の余白（`THINKING_OVERHEAD_MARGIN`）で補う。出力トークン数が
 * 分からなければ、思考の字数をそのままトークンとみなす。
 */
function thinkingTokensOf(observation: ThinkingObservation): number {
  if (observation.outputTokens !== undefined) {
    return Math.max(0, observation.outputTokens - observation.answerChars);
  }
  return observation.thinkingChars;
}

/**
 * 思考の分の見込みに掛ける余白と刻み。
 *
 * **思考の長さは入力の長さで伸びる。** 測るのは数百字の短い文なので、
 * 実際の数千字のチャンクではもっと考える。1.5倍してから256刻みに
 * 切り上げる（機能ごとの出力の見込みが1.25倍・1024刻みなのと同じ考え方で、
 * 伸びるぶんを多めに見た）。
 */
const THINKING_OVERHEAD_MARGIN = 1.5;
const THINKING_OVERHEAD_STEP = 256;

/** 見分けた結果。**分からない欄は持たない** */
export interface ThinkingVerdict {
  /** 思考を止める指定を送らないとき、思考が出たか */
  readonly thinkingSeen?: boolean;
  /** 思考を止める指定が効いたか（考えるモデルのときだけ意味がある） */
  readonly thinkingOffWorks?: boolean;
  /** 止められないモデルが、1回ごとに思考へ使うと見るトークン数 */
  readonly thinkingOverheadTokens?: number;
}

/**
 * 「止める指定なし」と「止める指定あり」の2回から見分ける。
 * どちらの回も返らなかったら undefined（**分からないことを覚えない**）。
 *
 * **覚えるのは、返ってきた応答で見えたことだけ**（規則5「失敗から
 * 学習しない」）。止める指定を送った回が失敗しても、「効かない」とは
 * 決めない——失敗の原因は別（残高・上限）かもしれない。
 */
export function judgeThinking(
  on: ThinkingObservation | undefined,
  off: ThinkingObservation | undefined
): ThinkingVerdict | undefined {
  const offSaw = off !== undefined ? sawThinking(off) : undefined;
  const overhead =
    off !== undefined && offSaw === true
      ? Math.ceil(
          (thinkingTokensOf(off) * THINKING_OVERHEAD_MARGIN) /
            THINKING_OVERHEAD_STEP
        ) * THINKING_OVERHEAD_STEP
      : undefined;

  if (on === undefined) {
    // 止めたのに出た——止める指定が効かないことだけは言える
    if (offSaw === true) {
      return {
        thinkingSeen: true,
        thinkingOffWorks: false,
        thinkingOverheadTokens: overhead,
      };
    }
    return undefined;
  }

  const onSaw = sawThinking(on);
  if (!onSaw) {
    // 指定なしでも考えなかった。止めたほうで出たなら、それは止まらない印
    if (offSaw === true) {
      return {
        thinkingSeen: true,
        thinkingOffWorks: false,
        thinkingOverheadTokens: overhead,
      };
    }
    return { thinkingSeen: false };
  }
  if (off === undefined) return { thinkingSeen: true };
  if (offSaw === true) {
    return {
      thinkingSeen: true,
      thinkingOffWorks: false,
      thinkingOverheadTokens: overhead,
    };
  }
  return { thinkingSeen: true, thinkingOffWorks: true };
}

/* ── 仕事に近い時間 ───────────────────────────────── */

/** 1回ぶんの時間の実測 */
export interface WorkSample {
  /** 送った本文の字数（指示を含まない） */
  readonly bodyChars: number;
  /** 送ってから返るまでの秒数 */
  readonly seconds: number;
}

/**
 * 短い回と長い回から、見込みの式を決める。決められなければ undefined。
 *
 * **2点から傾きを出す。** 傾きが正でない（長い回のほうが速かった）か、
 * 切片が負になる（傾きが急すぎる）ときは、測りの揺れが差を上回っている。
 * そのときは**長い回の時間をすべて字数のせいにする**——固定のぶんを0、
 * 1000字あたりを「長い回の秒数 ÷ 長い回の千字数」にする。見込みは
 * 長めに出る側へ倒れる（待ち時間が足りなくて切れるより、長く待つほうがよい）。
 */
export function fitWorkRate(samples: readonly WorkSample[]): WorkRate | undefined {
  const usable = samples.filter(
    (sample) =>
      Number.isFinite(sample.bodyChars) &&
      sample.bodyChars > 0 &&
      Number.isFinite(sample.seconds) &&
      sample.seconds > 0
  );
  if (usable.length < 2) return undefined;
  const sorted = [...usable].sort((a, b) => a.bodyChars - b.bodyChars);
  const short = sorted[0];
  const long = sorted[sorted.length - 1];
  if (long.bodyChars === short.bodyChars) return undefined;

  const perChar = (long.seconds - short.seconds) / (long.bodyChars - short.bodyChars);
  const fixed = short.seconds - perChar * short.bodyChars;
  if (perChar <= 0 || fixed < 0) {
    return {
      fixedSeconds: 0,
      secondsPer1000Chars: round1((long.seconds / long.bodyChars) * 1000),
    };
  }
  return {
    fixedSeconds: round1(fixed),
    secondsPer1000Chars: round1(perChar * 1000),
  };
}

/**
 * 待ち時間を見立てるときの、1回に送る本文の字数。
 *
 * **自動で決めるチャンクのいちばん大きい段**（`core/chunkTimeFit.ts` の
 * `CHUNK_TIME_LADDER` の先頭＝20,000字）。写しを作らず段の一覧から引く
 * ——段を変えたら、ここも一緒に動く。どの機能のどのチャンクでも、
 * これより長い本文は1回では送らない。
 */
export const WORK_REFERENCE_CHARS: number = CHUNK_TIME_LADDER[0];

/**
 * 待ち時間の見立てに掛ける余白。
 *
 * 合言葉で測っていた頃は×3だった（答えがほぼ空なので、実際の出力のぶんを
 * 丸ごと見込む必要があった）。いまは実際と同じ種類の答えを書かせて
 * いるので、そこまでは要らない。**残る揺れは2つ**——実際の原稿は同梱の文と
 * 誤りの密度が違う（答えの長さが変わる）ことと、数百字から20,000字へ
 * 延ばすときの伸び方のずれ（長い入力ほど1字あたりが重くなる機械がある）。
 * それを1.5倍で見る。
 */
export const WORK_TIME_MARGIN = 1.5;

/* ── 読める長さの申告 ─────────────────────────────── */

/**
 * サーバーが**自分の読める長さを述べる**定型の言い回し（設計書6.22.1①）。
 *
 * どれも実測で見た本文である。
 *
 * - vLLM（さくら llm-jp、2026-09-26）
 *   「This model's maximum context length is 4096 tokens and your request has …」
 * - vLLM（さくら Phi、2026-09-26）
 *   「max_tokens=11264 cannot be greater than max_model_len=max_total_tokens=4096.」
 * - vLLM（さくら gpt-oss-120b、2026-08-30）
 *   「Input length (170068) exceeds model's maximum context length (131072).」
 *
 * **規則5（エラー文から原因を当てにいかない）との折り合い**：ここで読むのは
 * 「どの指定が悪いか」ではなく、**上限超えのときにしか出ない定型の語に続く
 * 数字**である（6.22.1①が `max_model_len` を上限超えの印に足したのと同じ
 * 考え方）。そのうえで、**読んだ値をすぐには覚えない**——その長さに収まる
 * 要求をもう1回送り、**通ったときだけ**覚える（規則5「覚えるのは通った
 * ときだけ」）。読み違えても、確かめの1回が通らなければ何も変わらない。
 */
const DECLARED_LIMIT_PATTERNS: readonly RegExp[] = [
  /maximum context length is\s*(\d+)\s*tokens/i,
  /maximum context length\s*\((\d+)\)/i,
  // 「max_model_len=max_total_tokens=4096」のように、名前が続くことがある
  /max_model_len\s*=\s*(?:[a-z_]+\s*=\s*)*(\d+)/i,
];

/** これより小さい・大きい数字は、読める長さとして信じない */
const MIN_DECLARED_TOKENS = 1024;
const MAX_DECLARED_TOKENS = 16 * 1024 * 1024;

/**
 * 断られた文から、サーバーが述べた読める長さ（トークン）を読む。
 * 読めなければ undefined。
 */
export function parseDeclaredContextLimit(text: string): number | undefined {
  for (const pattern of DECLARED_LIMIT_PATTERNS) {
    const match = pattern.exec(text);
    if (!match) continue;
    const value = Number(match[1]);
    if (
      Number.isInteger(value) &&
      value >= MIN_DECLARED_TOKENS &&
      value <= MAX_DECLARED_TOKENS
    ) {
      return value;
    }
  }
  return undefined;
}

/**
 * 断らせるために頼む、出力の上限（トークン）。
 *
 * **長い入力を送らずに、大きな出力を頼む。** vLLM 系のサーバーは
 * 「入力＋頼んだ出力」が読める長さを超えると、生成する前に400で断り、
 * 本文に自分の長さを書く（llm-jp の文がまさにそれだった）。長い入力で
 * 断らせると、**断らなかったモデル（長く読めるモデル）ではその入力ぶんの
 * 料金がかかる**。出力の上限なら、断られなかったときも答えは「はい」の
 * 数トークンで終わる。どのモデルの読める長さよりも大きい値にしてある。
 */
export const DECLARED_LIMIT_PROBE_OUTPUT_TOKENS = 2_000_000;

/**
 * 確かめの1回で、読んだ長さから差し引くトークン数。
 *
 * 確かめの要求は「入力（数十トークン）＋出力の上限」が読める長さに
 * 収まっていなければならない。入力の見積りは要らない——短い問いなので、
 * 余白に収まる。
 */
export const DECLARED_LIMIT_CONFIRM_MARGIN = 256;

/** 1桁に丸める（台帳に書く秒数を、読める桁にそろえる） */
function round1(value: number): number {
  return Math.round(value * 10) / 10;
}
