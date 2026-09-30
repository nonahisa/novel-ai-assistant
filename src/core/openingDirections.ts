import { normalizeForComparison } from "./groundedEvidence";
import { isNoAdviceFiller, verbatimIn } from "./praise";
import { READER_TYPES } from "./readerTarget";
import { READER_TYPE_IDS } from "./readerTypeNeighbors";

/**
 * 冒頭診断（P-24 1.2）の「読者に向けて直す方向」を確かめる。
 *
 * 作者の問い（2026-10-01）は「冒頭のフックを強くできないか」だった。
 * 1.1 までの総評は診断で止まり、どちらへ直せばよいかを示せなかった。
 * 作者の裁定：**読者タイプを踏まえて、直す方向を数件並べる。例文・書き直し案は
 * 出さないまま**（「サポートは書かない」——文を書くのは作者）。
 *
 * ## ここで落とすもの
 *
 * 1. **根拠の引用が本文に無いもの**（規則3）。ほめる欄と同じ物差し
 *    （`verbatimIn`。断片のすべてが本文に在ること）で照らす
 * 2. **例文・書き直した文を含むもの**。プロンプトで禁じても、AIは
 *    「たとえば「〜」のように」と文を差し出してくる。作者の冒頭を
 *    AIの文で押し流さないために、方向と理由の欄をコードで見る
 * 3. **指示の言葉がそのまま返ってきたもの**（CLAUDE.md の失敗3）。
 *    プロンプトに書いた欄の説明（`OPENING_DIRECTION_HINTS`）や
 *    「例文」「書き直し案」の語が入っていれば、中身の無い答えである
 *
 * ## 0件は普通の答え
 *
 * 冒頭がすでに読者へ届いていれば、方向は要らない（プロンプト設計書1.9、
 * 作者の言葉「無理してひねり出さなくても良いですよ」）。**件数を埋めさせない**
 * ので、0件を失敗として扱わない。
 *
 * VS Code API に依存しない（MCP の束からも使う）。
 */

/** 1件ぶん。どれも照合・検査を通ったもの */
export interface OpeningDirection {
  /** 方向の短い名前（「謎を先に見せる」など） */
  direction: string;
  /** 根拠になる本文の箇所。**本文に逐語で在るもの**だけが入る */
  quote: string;
  /** 想定読者にとって、なぜその方向が効くか */
  why: string;
}

export interface OpeningDirectionsRead {
  items: OpeningDirection[];
  /** 引用が本文に見つからず落とした数 */
  notFound: number;
  /** 例文・書き直した文・指示語のなぞりを含んでいて落とした数 */
  exampleLike: number;
  /** 上限（`OPENING_DIRECTIONS_MAX`）を超えて落とした数 */
  overLimit: number;
  /** 欄が空・埋め草だったので落とした数（画面には出さない。ログ用） */
  empty: number;
}

/**
 * 並べる方向の上限。**下限は持たない**（1.9。0件も普通の答え）。
 *
 * 5件以上になると、どれが効くのかが作者に見えなくなる。冒頭3,000字の
 * 引きを強める方向として、4つを超えて本当に別々のものが挙がることは少ない。
 */
export const OPENING_DIRECTIONS_MAX = 4;

/**
 * 方向の名前の上限。**短い名前**と頼んでいるので、これを超えるものは
 * 名前ではなく文——書き直した一文が名前の欄に入っていることが多い。
 */
export const OPENING_DIRECTION_NAME_MAX_CHARS = 20;

/**
 * プロンプトの欄の説明。**プロンプトとここが同じ文字列を見る**
 * （写すと、プロンプトだけ直して検査が古い言い方を見張り続ける）。
 */
export const OPENING_DIRECTION_HINTS = {
  direction: "何を強めるか・どこを変えるかを示す短い名前",
  quote: "その方向を言える根拠になる本文の箇所",
  why: "この読者にとって、なぜその方向が効くのか",
} as const;

/**
 * 答えに入っていたら、例文や書き直し案を差し出していると見る語。
 *
 * プロンプトの禁止の文（「例文・書き換えた文を書かないこと」）に
 * これらの語を書いて渡すので、**そのまま返ってくる前提で**見る。
 * 「書き直す」「書き換える」の動詞は入れない——「冒頭の一文を短く書き直す」は
 * 方向として正しい言い方で、文そのものを差し出してはいない。
 */
const EXAMPLE_WORDS = [
  "例文",
  "文例",
  "書き直し案",
  "書き換え案",
  "書き直し例",
  "書き換え例",
  "改善案",
  "修正案",
  "言い換え案",
  "書き換えた文",
  "書き直した文",
  "台詞の案",
  "セリフの案",
];

/** 「たとえば「〜」」「例：〜」のように、文を差し出す前置き */
const EXAMPLE_LEAD = /(例えば|たとえば|例として)[、,\s]*[「『"“]|(^|[\s、。（(])例\s*[:：]/u;

/**
 * 「〜という書き出し」「〜という台詞」。**直前が閉じ括弧でなければ**、
 * AIが自分で考えた文を書き出し・台詞として差し出している。
 * 閉じ括弧のときは、括弧の中身を本文と照らす（下の `unfoundBracket`）。
 */
const PROPOSED_LINE = /[^」』"”]という(一文|書き出し|台詞|セリフ|一行|文章|会話)/u;

/**
 * かぎ括弧の中身が本文に無いとき、例文と見る長さ。
 *
 * 短い語（「謎」「引き」「異常事態」）は概念を括っているだけのことが多いので
 * 見逃す。**6字以上、または文の終わりの記号を含むもの**（「逃げろ！」）は、
 * 作った台詞・文として落とす。
 */
const BRACKET_EXAMPLE_MIN_CHARS = 6;

/** 括弧で括ってよい語（本文に無くても例文ではない） */
const BRACKET_ALLOWED = new Set<string>([
  "いつ",
  "どこで",
  "誰が",
  "何を",
  "なぜ",
  "どのように",
  "意図的な保留",
  ...READER_TYPE_IDS.map((id) => READER_TYPES[id].label),
]);

/**
 * 答えの `directions` 欄を読み、照合と検査を通ったものだけを残す。
 *
 * @param value 応答の `directions` 欄の値
 * @param openingText AIへ送った冒頭本文（引用とかぎ括弧の照合に使う）
 */
export function readOpeningDirections(
  value: unknown,
  openingText: string
): OpeningDirectionsRead {
  const result: OpeningDirectionsRead = {
    items: [],
    notFound: 0,
    exampleLike: 0,
    overLimit: 0,
    empty: 0,
  };
  if (!Array.isArray(value)) return result;

  const locate = verbatimIn(openingText);
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      result.empty++;
      continue;
    }
    const record = entry as Record<string, unknown>;
    const direction = cleanLine(record.direction);
    const quote = cleanLine(record.quote);
    const why = cleanLine(record.why);
    if (
      !direction ||
      !quote ||
      !why ||
      isNoAdviceFiller(direction) ||
      isNoAdviceFiller(why)
    ) {
      result.empty++;
      continue;
    }
    // **例文の検査を引用の照合より先に行う。** 引用の欄に作った文を入れて
    // くるときは両方に当たるが、作者に伝える理由は「例文を含んでいた」のほうが正確
    if (
      directionNameTooLong(direction) ||
      looksLikeExample(direction, openingText) ||
      looksLikeExample(why, openingText)
    ) {
      result.exampleLike++;
      continue;
    }
    const shown = locate(quote);
    if (!shown) {
      result.notFound++;
      continue;
    }
    // 同じ方向を言い方だけ変えて2度出してくる。並べても作者に届く中身は増えない
    const key = normalizeForComparison(direction);
    if (seen.has(key)) continue;
    seen.add(key);
    // **上限は、検査を通ったものに掛ける。** 先に切ると、落ちる答えが
    // 枠を埋めて、通るはずの方向が見えなくなる
    if (result.items.length >= OPENING_DIRECTIONS_MAX) {
      result.overLimit++;
      continue;
    }
    result.items.push({ direction, quote: shown, why });
  }
  return result;
}

/**
 * 例文・書き直した文・指示語のなぞりを含むか。
 *
 * 方向の名前と理由の欄に使う（引用の欄は本文との照合が担う）。
 */
export function looksLikeExample(text: string, openingText: string): boolean {
  if (EXAMPLE_WORDS.some((word) => text.includes(word))) return true;
  if (echoesHint(text)) return true;
  if (EXAMPLE_LEAD.test(text)) return true;
  if (PROPOSED_LINE.test(text)) return true;
  return unfoundBracket(text, openingText);
}

/** 欄の説明をそのまま書いてきたか。**説明の文を丸ごと含むときだけ**落とす */
function echoesHint(text: string): boolean {
  const body = normalizeForComparison(text);
  return Object.values(OPENING_DIRECTION_HINTS).some((hint) =>
    body.includes(normalizeForComparison(hint))
  );
}

/**
 * 本文に無い文を、かぎ括弧で書いているか。
 *
 * 本文の台詞や地の文を括って指すのは正しい使い方なので、**本文に在れば通す**。
 */
function unfoundBracket(text: string, openingText: string): boolean {
  const haystack = normalizeForComparison(openingText);
  const pattern = /[「『“"]([^」』”"]*)[」』”"]/gu;
  for (const match of text.matchAll(pattern)) {
    const inner = match[1].trim();
    if (!inner || BRACKET_ALLOWED.has(inner)) continue;
    const normalized = normalizeForComparison(inner);
    if (haystack.includes(normalized)) continue;
    const sentenceLike = /[。！？!?…―]/u.test(inner);
    if (sentenceLike || [...normalized].length >= BRACKET_EXAMPLE_MIN_CHARS) {
      return true;
    }
  }
  return false;
}

function directionNameTooLong(direction: string): boolean {
  return [...direction].length > OPENING_DIRECTION_NAME_MAX_CHARS;
}

/** 改行を潰して前後を落とす。欄が文字列でなければ空 */
function cleanLine(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.trim().replace(/\s+/g, " ");
}
