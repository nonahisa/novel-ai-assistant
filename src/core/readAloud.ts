import {
  NOTATION_RULES,
  tokenizeLine,
  type NotationMode,
} from "./manuscriptRender";
import { isMemoLine } from "./sceneMemo";

/**
 * 読み上げ（音読推敲。設計書6.42）。
 *
 * 書いた文章を**耳で聞く**と、目で読んでいるときには気づかないものが出る
 * ——リズムの悪さ、同じ語尾の続き、読点の位置、誤字。原稿エディタの
 * 「読み上げ」は、読んでいる文を光らせながら声に出し、引っかかった場所へ
 * その場でシーンメモの印を置けるようにする。
 *
 * ## ここは vscode に触らない
 *
 * 声を出すのは画面側（Web Speech API の `speechSynthesis`）だが、
 * **どこで文を切り、何と読ませるか**は原稿の読み方そのものである。
 * 画面の中に置くと確かめようがないので、純粋な文字列処理として外へ出す。
 *
 * ## 声に渡すのは、原文の「写し」である
 *
 * この計画は**本文を1文字も書き換えない**。`speech` は声へ渡すためだけの
 * 文字列で、原稿には戻らない。だからこそ、ルビは読み仮名に置き換えるし、
 * ダッシュは読点へ潰してよい（本文でそれをやったら改竄である）。
 *
 * ## 位置は「元の本文の」オフセットで持つ
 *
 * `start`/`end` は `buildReadingPlan` に渡した本文そのものの位置で、
 * `text.slice(start, end)` を取れば**記法つきの原文**が戻る。読んでいる文を
 * 光らせるのは画面側の仕事なので、画面が持っている本文の位置と揃っていないと
 * 別の場所が光る。**加工後の文字列の位置を返さない。**
 */

/** 声に渡す1文 */
export interface ReadingSentence {
  /** 元の本文の開始位置（この位置から `end` までが記法つきの原文） */
  start: number;
  /** 元の本文の終了位置（含まない） */
  end: number;
  /** 1始まりの行番号（シーンメモの印を置く先） */
  line: number;
  /** 声へ渡す文字列（原文の写し。本文には戻らない） */
  speech: string;
}

/**
 * 文の終わりになる字。
 *
 * `！？` のように続けて置かれることがあるので、**連なりは1つの切れ目**と
 * して数える（「えっ！」「？」と割ると、声が2度途切れる）。
 */
const SENTENCE_END = "。！？!?";

/**
 * 終わりの字のあとに続いたら、**前の文に含める**閉じの字。
 *
 * 「……行こう。」の `」` を次の文の頭に回すと、閉じ括弧だけの文ができる。
 */
const SENTENCE_CLOSERS = "」』）】〟";

/**
 * 1つの声の単位に許す長さ。
 *
 * **Chromium は長すぎる文の途中で黙る**という癖がある（読み上げが止まった
 * ように見えて、そのまま次へ進まない）。句点まで待たずに、読点でも切る。
 */
const SPEECH_MAX = 200;

/**
 * ダッシュと三点リーダの連なり。
 *
 * 声は `―` を「ダッシュ」と読み上げたり、逆に何も言わずに詰めたりする。
 * **どちらも音読の邪魔になる**ので、間（ま）だけを残して読点1つへ潰す。
 *
 * **見た目のよく似た別の字が4つ並んでいる。** 中身は順に U+2014 EM DASH、
 * U+2015 HORIZONTAL BAR（この2つは並べても人の目では見分けが付かない）、
 * U+2026 三点リーダ、U+2025 二点リーダである。字を足すときは、
 * どの符号を足したのかをここへ書き足すこと。
 */
const DASH_RUN = /[—―…‥]+/g;

/**
 * 記法の残骸。
 *
 * ルビ・傍点として読めた部分は `tokenizeLine` が畳んでくれるが、
 * **書きかけの記法**（`{漢字|` まで打ったところ）は平文として残る。
 * 声に「なみかっこ」と読ませても仕方がないので落とす。
 */
const NOTATION_LEFTOVER = /[|｜{}《》]/g;

/** 前後の空白（全角を含む） */
const EDGE_SPACE = /^[\s　]+|[\s　]+$/g;

/**
 * 本文から、声に渡す文の並びを作る。
 *
 * @param text 原稿エディタが持っている本文（**LF区切り**。`core/eolSpace.ts`）
 * @param notation その原稿の記法（`.md` は curly、`.txt` は site）
 */
export function buildReadingPlan(
  text: string,
  notation: NotationMode
): ReadingSentence[] {
  const plan: ReadingSentence[] = [];
  const lines = text.split("\n");
  let lineStart = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // **シーンメモは読まない**（設計書6.40.2）。作者の覚え書きであって
    // 本文ではないので、声に出すと原稿の流れが切れる
    if (!isMemoLine(line)) {
      for (const piece of splitSentences(line, notation)) {
        const sentence = makeSentence(
          text,
          lineStart + piece.start,
          lineStart + piece.end,
          i + 1,
          notation
        );
        // 記号と空白しか無かった文は捨てる（声に渡すものが無い）
        if (sentence) plan.push(sentence);
      }
    }
    // 改行1文字ぶんを足して、次の行の頭へ
    lineStart += line.length + 1;
  }
  return plan;
}

/*
  **「その位置を含む文の添字」は、ここには置かない**（レビュー指摘、
  2026-08-29）。

  かつて `findSentenceAt` を置いていたが、同じ探索が画面側にもあった
  （`aloudIndexAt`）。**読み上げ中に本文を押した「ここから」は、往復を
  待たずにその場で飛ぶ必要がある**ので、画面側の探索は消せない。
  写しを2つ残さないために、こちらを消して画面側の1つに寄せてある。

  文の**分け方**（どこで切るか）は、これまでどおりこちらが唯一の持ち主で、
  画面側は届いた並びを引くだけである。
*/

/** 行の中の切れ目（行の先頭からの位置） */
interface Piece {
  start: number;
  end: number;
}

/**
 * その位置が、ルビ・傍点の記法の**内側**か（行の各文字について1つ）。
 *
 * ## なぜ要るか（レビュー指摘、2026-08-29）
 *
 * ルビの親文字や傍点の中に `。！？` が入っていることがある
 * （`それは{{嘘だ。}}と思った。`）。そこで切ると1つの記法が2つの文に割れ、
 * **光る範囲が記法の途中で途切れる**うえ、前半だけでは `tokenizeLine` が
 * 記法として読めないので、声が波括弧を読み上げる。
 *
 * ## なぜ `tokenizeLine` の結果を使わないか
 *
 * あちらは**元の記法の長さを返さない**（読み仮名が空の `{漢字|}` は
 * 親文字だけの平文になる）ので、行の中の位置を数え直せない。
 * ここが使うのは**同じ1つの規則**（`NOTATION_RULES`）の当たり位置だけで、
 * 写しは置かない。
 */
function notationMask(line: string, notation: NotationMode): boolean[] {
  const mask = new Array<boolean>(line.length).fill(false);
  const pattern = new RegExp(NOTATION_RULES[notation].pattern, "g");
  for (const match of line.matchAll(pattern)) {
    const start = match.index ?? 0;
    for (let i = start; i < start + match[0].length && i < mask.length; i++) {
      mask[i] = true;
    }
  }
  return mask;
}

/**
 * 1行を文へ割る。
 *
 * 切るのは2か所である。
 *
 * 1. 終わりの字（`。！？!?`）の連なりの直後。続く閉じ括弧は前の文に含める
 * 2. 長くなりすぎた文の、読点の直後（`SPEECH_MAX`）
 *
 * **どちらも、記法の内側では切らない**（`notationMask`）。
 *
 * 行末も切れ目になる——**行が変われば文も変わる**という前提で書かれた原稿
 * （句点を打たない地の文、台詞だけの行）が多い。
 */
function splitSentences(line: string, notation: NotationMode): Piece[] {
  const inNotation = notationMask(line, notation);
  const pieces: Piece[] = [];
  let start = 0;
  for (let i = 0; i < line.length; i++) {
    if (inNotation[i]) continue;
    if (SENTENCE_END.indexOf(line[i]) < 0) continue;
    let at = i;
    while (
      at < line.length &&
      !inNotation[at] &&
      SENTENCE_END.indexOf(line[at]) >= 0
    ) {
      at++;
    }
    while (
      at < line.length &&
      !inNotation[at] &&
      SENTENCE_CLOSERS.indexOf(line[at]) >= 0
    ) {
      at++;
    }
    pieces.push({ start, end: at });
    start = at;
    i = at - 1;
  }
  if (start < line.length) pieces.push({ start, end: line.length });

  const split: Piece[] = [];
  for (const piece of pieces) {
    split.push(...splitLongPiece(line, piece, inNotation));
  }
  return split;
}

/**
 * 長い文を、読点の直後で割る。
 *
 * **上限を超えてから最初の読点**で切る（超える前に切ると、短い文が
 * いくつも並んで、かえって読みが途切れる）。読点が無ければ割らない
 * ——句読点の無い長文を字数で切ると、語の途中で息継ぎが入る。
 */
function splitLongPiece(
  line: string,
  piece: Piece,
  inNotation: readonly boolean[]
): Piece[] {
  if (piece.end - piece.start <= SPEECH_MAX) return [piece];
  const pieces: Piece[] = [];
  let start = piece.start;
  for (let i = piece.start; i < piece.end; i++) {
    if (line[i] !== "、" || inNotation[i]) continue;
    if (i + 1 - start < SPEECH_MAX) continue;
    pieces.push({ start, end: i + 1 });
    start = i + 1;
  }
  if (start < piece.end) pieces.push({ start, end: piece.end });
  return pieces;
}

/**
 * 切り出した範囲を1文にする。声に渡すものが無ければ undefined。
 *
 * **範囲は前後の空白を落としてから確定する。** 段落の字下げ（全角空白）まで
 * 光らせると、文の頭が1文字ずれて見える。
 */
function makeSentence(
  text: string,
  rawStart: number,
  rawEnd: number,
  line: number,
  notation: NotationMode
): ReadingSentence | undefined {
  let start = rawStart;
  let end = rawEnd;
  while (start < end && isEdgeSpace(text[start])) start++;
  while (end > start && isEdgeSpace(text[end - 1])) end--;
  if (start >= end) return undefined;

  const speech = toSpeech(text.slice(start, end), notation);
  if (speech === "") return undefined;
  return { start, end, line, speech };
}

function isEdgeSpace(char: string): boolean {
  return char === " " || char === "\t" || char === "　";
}

/**
 * 記法つきの原文を、声へ渡す文字列にする。
 *
 * **記法の切り分けは `core/manuscriptRender.ts` の `tokenizeLine` を使う**
 * （写しを置かない）。ルビ・傍点の書き方は原稿の種類で違い、ここへ写すと
 * 「組んで書く面では組まれるのに、声だけ記号を読む」日が来る。
 */
function toSpeech(source: string, notation: NotationMode): string {
  let out = "";
  for (const token of tokenizeLine(source, notation)) {
    // **ルビは読み仮名で読む。** 親文字を読ませると、読み方を指定した意味が
    // 消える（作者が読み仮名を振るのは、そう読ませたいからである）
    if (token.kind === "ruby") out += token.reading;
    // 傍点は強調の印であって音ではない。中身だけを読む
    else if (token.kind === "emphasis") out += token.text;
    else out += token.text;
  }
  return out
    .replace(DASH_RUN, "、")
    .replace(NOTATION_LEFTOVER, "")
    .replace(EDGE_SPACE, "");
}

/**
 * 「引っかかった」で置くシーンメモの中身（設計書6.42）。
 *
 * **`core/sceneMemo.ts` の印（`// `）に続けて書く。** 印そのものは
 * あちらが持っているので、ここが持つのは中身だけである。
 * 中身まで持つと、印の書き方が変わったときにここが取り残される。
 */
export const READ_ALOUD_MEMO_TEXT = "音読：ここで引っかかった";
