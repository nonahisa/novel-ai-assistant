import {
  resolveTokensPerChar,
  type CharsPerTokenMeasurement,
} from "../core/sizeBudget";
import { AIError } from "./types";

/**
 * 送るものがモデルの上限に入るかを、送る直前に確かめる（設計書6.27.10）。
 *
 * ## なぜ「送る直前」なのか
 *
 * チャンクの大きさも、指示の量も、参照資料の量も可変である。どれも
 * 見込みで決めており、見込みは外れる。**外れたときに何が起きるかが
 * プロバイダごとに違う**のが厄介で、Ollama は超えた入力を黙って捨て、
 * クラウドはエラーを返す。黙って捨てられると「AIが本文の後半を読んで
 * いない」という形でしか現れず、実データを見るまで誰も気づかない。
 *
 * 見込みを増やして凌ぐ道（固定費を7,000→12,000字にした）は、以前
 * 通ったところである。固定である限り必ず追い越されるので、今度は
 * **組み上がった文字列そのものを測る**。
 *
 * ## VS Code に依存させない
 *
 * ここは純粋な計算だけを持つ。判断を単体テストで固定できるようにする
 * ためで、実際に呼ぶのは `ai/meteredProvider.ts` の1か所だけである。
 */

/**
 * 応答に見込むトークン数の既定。
 *
 * 呼び出し側が `maxOutputTokens` を渡してこないとき、出力の量は
 * 誰にも分からない。**分からないものを小さく見積もると応答が途中で切れる**
 * ので、固定で多めに確保する。
 *
 * **この値の置き場所は1つ。** 以前は `ollamaProvider.ts` の中にあり、
 * 関所がそれと違う値で判断すると「関所は通ったのに num_ctx が足りない」
 * という、いちばん追いにくい形の食い違いになる。
 */
export const OUTPUT_RESERVE_TOKENS = 8192;

/**
 * 関所を通さない、ただ1つの呼び出し（`GenerateMeta.feature`）。
 *
 * **例外はこれだけである。** ここを増やすと「入らないものを黙って送る」
 * 経路が復活し、この関所を置いた意味が無くなる。増やしたくなったら、
 * その機能が本当に上限を測っているのかを先に疑うこと。
 *
 * ## なぜこれだけは通すのか
 *
 * 読める長さの測定（設計書6.27.11）は、**申告値が本当かを確かめる**
 * ためのものである。申告値で止めてしまうと、申告どおりの長さまでしか
 * 試せず、「申告以上に読めるか」が永久に分からない。さくらのAI Engine
 * の申告値は、作者が設定に書いた当て推量にすぎない。
 *
 * **通しても黙って切り捨てられることはない。** 上限を超えたとき、
 * クラウドはエラーを返し（＝入らない）、手元のAIは切り捨てた結果として
 * 合言葉が欠けて返る（＝入らない）。測定はどちらも「入らない」と数える
 * ので、切り捨てが見えないまま通り過ぎる経路にはならない。
 */
export const CONTEXT_GUARD_EXEMPT_FEATURE = "context_probe";

/** その呼び出しが関所を素通りしてよいか */
export function skipsContextGuard(feature: string | undefined): boolean {
  return feature === CONTEXT_GUARD_EXEMPT_FEATURE;
}

export interface ContextFitInput {
  /** system プロンプトの実測字数 */
  systemChars: number;
  /** user プロンプトの実測字数 */
  userChars: number;
  /** 応答に見込むトークン数 */
  outputTokens: number;
  /**
   * モデルが扱える上限。**分からなければ undefined。**
   *
   * 取れないことは普通にある（`/api/show` が失敗した、一覧に無いモデルを
   * 指定した、など）。そのときは通す——**分からないものを止めない**。
   * 止めると、モデル情報の取得が一時的にこけただけで作品全体が処理
   * できなくなる。
   */
  contextWindow: number | undefined;
  /**
   * 字/トークンの実測（`core/modelTuning.ts` の台帳）。
   *
   * **チャンクを決めた係数と同じものを渡す。** 関所だけが当て推量の
   * ままだと、実測にもとづいて組んだプロンプトを関所が「入らない」と
   * 断ることになる（この関所が見ているのは同じ見積りである）。
   * 渡さなければ従来どおり 0.7 で見積もる。
   */
  measured?: CharsPerTokenMeasurement;
}

export interface ContextFitResult {
  /** この呼び出しに要ると見込むトークン数 */
  needTokens: number;
  /** 上限に入るか。上限が分からないときも true（通す） */
  fits: boolean;
}

/** 指示と本文が要ると見込むトークン数（出力は含まない） */
function inputTokensOf(input: ContextFitInput): number {
  return Math.ceil(
    (input.systemChars + input.userChars) * resolveTokensPerChar(input.measured)
  );
}

/**
 * 関所が数える（そして実際に送る）出力トークン数（比べ 2026-09-25〜26）。
 *
 * **出力の見込みだけで読める長さに届くときは、残りを全部出力に回す。**
 * それ以外は、渡された見込みをそのまま返す。
 *
 * ## なぜ要るか
 *
 * さくらの llm-jp と Phi は4,096トークンしか読めないのに、誤字脱字検知は
 * 出力の上限 11,264 を送っていた。長さを正しく4,096と知っても、関所は
 * 「入らない」と断り、逃げ道（`features/chunkRetry.ts`）は本文を割り続ける
 * ——**出力の見込みだけで上限を超えているので、本文をいくら割っても入らない。**
 * 4,096しか読めないモデルは、どう頼んでも 11,264 は書けないので、縮めて
 * 失うものは無い。
 *
 * ## 見込みが上限に届かないときは縮めない
 *
 * 大きいモデルで「入力＋出力」が溢れたときは、これまでどおり本文を割る。
 * そちらは割れば入り、応答の上限を削らずに済む——削ると、抽出のJSONが
 * 途中で切れてチャンクが丸ごと捨てられる。**入力を割っても解決しない形の
 * ときだけ**出力を削る、という線引きである。
 *
 * ## 床を割るなら床で数える
 *
 * 残りが `minimumOutputTokens`（`ai/outputLimit.ts` の1,024）に満たないときは
 * 床の値を返す。関所はその値で「入らない」と断り、上限超えの数字
 * （`AIError.overflow`）も**床で数えたもの**になる。逃げ道はその数字から
 * 本文を削る量を決めるので、11,264 のまま数えると「1文字も送れない」と
 * 諦めてしまう。
 *
 * `minimumOutputTokens` を引数でもらうのは、この葉のモジュールを
 * VS Code に依存させないため（`outputLimit.ts` は設定を読む）。
 */
export function outputTokensWithinWindow(
  input: ContextFitInput,
  minimumOutputTokens: number
): number {
  const limit = input.contextWindow;
  if (limit === undefined || !Number.isFinite(limit) || limit <= 0) {
    return input.outputTokens;
  }
  if (input.outputTokens < limit) return input.outputTokens;
  return Math.max(minimumOutputTokens, limit - inputTokensOf(input));
}

/** 入るかどうかを見積もる。判断だけで、副作用は持たない */
export function checkContextFit(input: ContextFitInput): ContextFitResult {
  const needTokens = inputTokensOf(input) + input.outputTokens;

  const limit = input.contextWindow;
  if (limit === undefined || !Number.isFinite(limit) || limit <= 0) {
    return { needTokens, fits: true };
  }
  return { needTokens, fits: needTokens <= limit };
}

/**
 * 入らないときの失敗を作る。
 *
 * **数字を本文（message）に入れる。** 「入りません」だけでは、作者は
 * どれくらい減らせばよいのか分からない。内訳（detail）は、どこが膨らんで
 * いるか——本文なのか指示なのか——を切り分けるために残す。
 *
 * **同じ数字を、機械が読める形でも付ける**（`AIError.overflow`）。
 * 逃げ道（`features/chunkRetry.ts`）は「あと何字減らせば入るのか」を
 * 知らないと、本文が下限より小さいというだけで諦めてしまう
 * ——2026-09-19の実機で、1%（342トークン）超えた最後の1話が
 * まるごと失われた。
 */
export function contextOverflowError(
  input: ContextFitInput,
  need: number
): AIError {
  return new AIError(
    `本文と資料を合わせた量（約${need.toLocaleString("en-US")}トークン）が、` +
      `このモデルの上限（${(input.contextWindow ?? 0).toLocaleString(
        "en-US"
      )}トークン）を超えています。`,
    "context_overflow",
    `指示 ${input.systemChars.toLocaleString("en-US")}字 / ` +
      `本文と資料 ${input.userChars.toLocaleString("en-US")}字 / ` +
      `出力の見込み ${input.outputTokens.toLocaleString("en-US")}トークン`,
    // 待ち時間とHTTPの状態番号は、上限超えには無い
    undefined,
    undefined,
    {
      needTokens: need,
      limitTokens: input.contextWindow ?? 0,
      // **判断に使ったのと同じ換算を渡す**（`checkContextFit` と同じ式）。
      // 別の換算で字数へ戻すと、実測を入れた途端にずれる
      tokensPerChar: resolveTokensPerChar(input.measured),
    }
  );
}

/**
 * 関所そのもの。入らなければ `AIError` を返す（入るなら undefined）。
 *
 * **投げずに返す。** 呼び出し側（`meteredProvider`）は、投げる前に
 * 「送らなかったこと」を記録に残す必要がある。
 */
export function contextOverflow(input: ContextFitInput): AIError | undefined {
  const { needTokens, fits } = checkContextFit(input);
  if (fits) return undefined;
  return contextOverflowError(input, needTokens);
}
