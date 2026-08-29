import { TOKENS_PER_CHAR } from "../core/chunker";
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
}

export interface ContextFitResult {
  /** この呼び出しに要ると見込むトークン数 */
  needTokens: number;
  /** 上限に入るか。上限が分からないときも true（通す） */
  fits: boolean;
}

/** 入るかどうかを見積もる。判断だけで、副作用は持たない */
export function checkContextFit(input: ContextFitInput): ContextFitResult {
  const needTokens =
    Math.ceil((input.systemChars + input.userChars) * TOKENS_PER_CHAR) +
    input.outputTokens;

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
      `出力の見込み ${input.outputTokens.toLocaleString("en-US")}トークン`
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
