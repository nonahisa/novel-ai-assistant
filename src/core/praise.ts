import { evidenceSegments, normalizeForComparison } from "./groundedEvidence";
import { isPlaceholderText } from "./placeholderText";

/**
 * 助言・講評の「ほめる欄」と「助言0件」の扱い（プロンプト設計書1.9）。
 *
 * 作者の方針（2026-09-24）：「作品が高い水準でバランスをとっているとき、
 * 無理に助言を言わなくてもいいです。あと、ほめることができる場所は、
 * 省略せずきちんとほめてください。」
 *
 * ここに置くのは、助言系の機能（冒頭診断 P-24・単話プロットの検査 P-27 など）が
 * **同じ物差しで**ほめ言葉を確かめるための部品である。機能ごとに写すと、
 * 照合の甘さが機能ごとにずれ、片方だけが作り物の引用を通す。
 *
 * VS Code API に依存しない。
 */

/** ほめる欄の1件。本文のどこが（引用）・なぜ効いているか */
export interface PraiseItem {
  /** 本文からの引用。**照合を通ったもの**だけが入る */
  quote: string;
  /** なぜ効いているか */
  why: string;
}

export interface PraiseReadResult {
  items: PraiseItem[];
  /** 引用が本文に見つからなかったので落とした件数。**黙って減らさない** */
  notFound: number;
  /** 引用か理由が空・埋め草だったので落とした件数 */
  empty: number;
}

/**
 * ほめる欄を受け取る上限。
 *
 * **件数で良い所を切らない**（1.9の2）。ただし壊れた応答が同じ項目を
 * 何百も並べることはあるので、画面が埋まらない程度の歯止めだけは持つ。
 * 3,000字の冒頭や1話ぶんの箇条書きで、30を超えるほめ所が本当に
 * 挙がることはまず無い。
 */
export const PRAISE_MAX_ITEMS = 30;

/**
 * 引用が本文に**逐語で**あるか。
 *
 * `readerTargetValidation.ts` の `quoteAppearsIn` は「句読点で割った断片の
 * **どれか1つ**が在れば通す」形で、根拠の点数を捨てるかどうかの判定には
 * それで足りる。だがほめる欄の引用は**そのまま作者の目に出る**——
 * 前半だけ本物で後半が作文の引用を通すと、作者は自分が書いていない文を
 * ほめられることになる。そこで**断片のすべて**が本文に在ることを求める。
 * 表記の揺れの落とし方（空白・バイト表記）は `groundedEvidence.ts` と同じ
 * 物差しを使う（写しを作らない）。
 */
export function praiseQuoteIsVerbatim(quote: string, source: string): boolean {
  const haystack = normalizeForComparison(source);
  if (!haystack) return false;
  const segments = evidenceSegments(quote);
  if (segments.length > 0) {
    return segments.every((segment) => haystack.includes(segment));
  }
  // 句読点で割れない短い引用（「どこで」の一語など）は、そのまま探す。
  // 1字だけの引用はどこにでも当たるので、ほめる根拠として認めない
  const whole = normalizeForComparison(stripQuoteMarks(quote));
  return whole.length >= 2 && haystack.includes(whole);
}

/**
 * 応答のほめる欄（配列）を読み、引用を照合して残す。
 *
 * @param value 応答の `strengths` 欄の値
 * @param locate 引用を本文に照らし、**画面に出す形**を返す。見つからなければ
 *   `undefined`。既定は `source` との逐語照合で、引用をそのまま返す。
 *   単話プロットのように「実在の行そのもの」を出したい機能は差し替える
 * @param keys 欄の名前（既定は quote / why）
 */
export function readGroundedPraise(
  value: unknown,
  locate: (quote: string) => string | undefined,
  keys: { quote: string; why: string } = { quote: "quote", why: "why" }
): PraiseReadResult {
  const result: PraiseReadResult = { items: [], notFound: 0, empty: 0 };
  if (!Array.isArray(value)) return result;

  const seen = new Set<string>();
  for (const entry of value) {
    if (result.items.length >= PRAISE_MAX_ITEMS) break;
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      result.empty++;
      continue;
    }
    const record = entry as Record<string, unknown>;
    const quote = cleanLine(record[keys.quote]);
    const why = cleanLine(record[keys.why]);
    if (!quote || !why || isNoAdviceFiller(quote) || isNoAdviceFiller(why)) {
      result.empty++;
      continue;
    }
    const shown = locate(quote);
    if (!shown) {
      result.notFound++;
      continue;
    }
    // 同じ箇所を2度ほめてくる。並べても作者に届く中身は増えない
    const key = normalizeForComparison(shown);
    if (seen.has(key)) continue;
    seen.add(key);
    result.items.push({ quote: shown, why });
  }
  return result;
}

/** 既定の照らし方：本文に逐語で在れば、引用をそのまま出す */
export function verbatimIn(source: string): (quote: string) => string | undefined {
  return (quote) => {
    const bare = stripQuoteMarks(quote);
    return praiseQuoteIsVerbatim(bare, source) ? bare : undefined;
  };
}

/**
 * 「助言が無い」ことを、助言の中身として書いてきたものか。
 *
 * **指示の言葉は、そのまま答えとして返ってくる**（CLAUDE.md の失敗3）。
 * 「直すべき所が見当たらなければ、そう書いてよい」と頼めば、
 * 「特になし」「直すべき所は見当たりません」が**助言の1件として**返る。
 * これを項目として並べると、「助言：特になし」という中身の無い行が
 * 助言の欄を占める。**助言0件として扱う**（1.9の5）。
 *
 * 見るのは**短い言い切りだけ**である。「直すべき所は見当たりませんが、
 * 第3話の引きは弱めです」のように続きがあるものは本物の助言なので、
 * 30字を超えたら埋め草とは見なさない。
 */
const NO_ADVICE_MAX_CHARS = 30;

const NO_ADVICE_PATTERN =
  /^(特に|とくに)?(直す|直すべき|改善|修正|指摘|助言|問題|気になる)?(べき)?(所|ところ|点|箇所|こと)?(は|が)?(特に|とくに)?(ない|無い|なし|無し|ありません|見当たらない|見当たりません|ございません|見つかりません|見つからない)(です)?$/u;

export function isNoAdviceFiller(text: string): boolean {
  const body = stripQuoteMarks(text).replace(/[\s　]/gu, "");
  if (!body) return true;
  if (isPlaceholderText(body, true)) return true;
  if ([...body].length > NO_ADVICE_MAX_CHARS) return false;
  return NO_ADVICE_PATTERN.test(body.replace(/[。．.！!]+$/u, ""));
}

/** 改行を潰して前後を落とす。欄が文字列でなければ空 */
function cleanLine(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.trim().replace(/\s+/g, " ");
}

/** 前後の括弧・引用符を落とす。引用を「」で包んで返すモデルがある */
function stripQuoteMarks(text: string): string {
  return text
    .trim()
    .replace(/^[「『"'“”‘’]+|[」』"'“”‘’]+$/gu, "")
    .trim();
}
