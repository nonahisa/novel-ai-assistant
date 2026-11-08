import {
  NOTATION_RULES,
  tokenizeLine,
  type NotationMode,
} from "./manuscriptRender";
import { MEMO_LINE_PATTERN, isMemoLine } from "./sceneMemo";
import type { ReadingSpan } from "./readingDictionary";
import { quotedSpans } from "./quotedSpans";
import { episodeReadableRanges, type TextRange } from "./metadataParser";

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
  /**
   * 地の文か台詞か（設計書6.42.3）。**文の頭が台詞の括弧の内側なら台詞。**
   * 人物の声で読むとき、地の文は語り手の声、台詞は話者の声に分ける
   */
  kind: ReadingSentenceKind;
  /**
   * 台詞なら、その話の中で何番目の台詞か（0始まり。`voiceDialogueSpans` の添字）。
   * 台詞ごとの話者と感情の推定（6.42.3）を、この番号で引く
   */
  dialogue?: number;
}

export type ReadingSentenceKind = "narration" | "dialogue";

/** 計画の作り方の選択 */
export interface ReadingPlanOptions {
  /**
   * 台詞と地の文の境目でも文を切る（設計書6.42.3。人物の声で読むとき）。
   *
   * **OSの声では切らない**（既定）。`「はい」と彼は頷いた。` を2つの声の単位に
   * 割ると、OSの声は単位の間で毎回途切れる。人物の声は拡張機能の側で先に
   * 作って続けて鳴らすので、割っても途切れない
   */
  splitDialogue?: boolean;
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
 * @param readings 読みの辞書から求めた、読みを差し替える範囲（元の本文の位置。
 *   設計書6.42.1）。**声へ渡す写しだけを差し替える**——本文は1字も変えない。
 *   作者のルビ・傍点の記法に掛かる範囲は使わない（作者のルビが勝つ）
 */
export function buildReadingPlan(
  text: string,
  notation: NotationMode,
  readings: readonly ReadingSpan[] = [],
  options: ReadingPlanOptions = {}
): ReadingSentence[] {
  const plan: ReadingSentence[] = [];
  const lines = text.split("\n");
  const dialogues = voiceDialogueSpans(text);
  let lineStart = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // **シーンメモは読まない**（設計書6.40.2）。作者の覚え書きであって
    // 本文ではないので、声に出すと原稿の流れが切れる
    if (!isMemoLine(line)) {
      const inNotation = notationMask(line, notation);
      const lineSpans = spansInLine(
        readings,
        lineStart,
        lineStart + line.length,
        inNotation
      );
      const cuts = options.splitDialogue
        ? dialogueCuts(line, lineStart, dialogues, inNotation)
        : [];
      for (const piece of splitSentences(line, inNotation, cuts)) {
        const sentence = makeSentence(
          text,
          lineStart + piece.start,
          lineStart + piece.end,
          i + 1,
          notation,
          lineSpans,
          dialogues,
          options.splitDialogue === true
        );
        // 記号と空白しか無かった文は捨てる（声に渡すものが無い）
        if (sentence) plan.push(sentence);
      }
    }
    // 改行1文字ぶんを足して、次の行の頭へ
    lineStart += line.length + 1;
  }
  return keepReadable(plan, readingRangesOf(text));
}

/**
 * 読む範囲（題と本文）。**null は全部を読む**（頭の欄の無い原稿・合本）。
 *
 * 画面はこの範囲で「カーソルが飛ばす欄の中か」を見て、中なら題から読み始める
 * （2026-11-08 作者の答え）。決まりそのものは `metadataParser.ts` が持つ——字数や本の
 * 組版と同じ見分け方にしないと、字数に数えない欄を読み上げることになる。
 */
export function readingRangesOf(text: string): TextRange[] | null {
  return episodeReadableRanges(text);
}

/**
 * 範囲の外の文を落とす（設計書6.42・6.42.4）。
 *
 * **字を切り取ってから文に分けない。** 切り取ると位置が縮み、読んでいる文と光る場所が
 * ずれる。分けたあとで落とせば、残った文の `start`/`end`/`line` は画面の字のままである。
 * 文は行をまたがず、欄の境目は行の境目なので、文の頭が範囲に入るかだけを見ればよい。
 *
 * 台詞の番号（`dialogue`）は振り直さない。全文の `voiceDialogueSpans` の添字で、
 * 台詞ごとの話者の推定がその番号で引くため。
 */
function keepReadable(
  plan: ReadingSentence[],
  ranges: readonly TextRange[] | null
): ReadingSentence[] {
  if (!ranges) return plan;
  return plan.filter((sentence) =>
    ranges.some((range) => sentence.start >= range.start && sentence.start < range.end)
  );
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
function splitSentences(
  line: string,
  inNotation: readonly boolean[],
  cuts: readonly number[] = []
): Piece[] {
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
  for (const piece of splitAtCuts(pieces, cuts)) {
    split.push(...splitLongPiece(line, piece, inNotation));
  }
  return split;
}

/** 切れ目（行の中の位置）で、さらに割る。切れ目は記法の外のものだけが来る */
function splitAtCuts(pieces: readonly Piece[], cuts: readonly number[]): Piece[] {
  if (cuts.length === 0) return [...pieces];
  const out: Piece[] = [];
  for (const piece of pieces) {
    let start = piece.start;
    for (const cut of cuts) {
      if (cut <= start || cut >= piece.end) continue;
      out.push({ start, end: cut });
      start = cut;
    }
    out.push({ start, end: piece.end });
  }
  return out;
}

/**
 * 台詞の境目（行の中の位置）。台詞の開き括弧の手前と、閉じ括弧の後ろ。
 *
 * **閉じ括弧のすぐ後ろの句読点は台詞の側に含める**——`「行こう」。` の `。` を
 * 地の文へ回すと、句点だけの文ができる（声に渡すものが無いのに1単位を使う）。
 * 記法の内側（ルビの親文字の中の括弧）では切らない。
 */
function dialogueCuts(
  line: string,
  lineStart: number,
  dialogues: readonly DialogueSpan[],
  inNotation: readonly boolean[]
): number[] {
  const lineEnd = lineStart + line.length;
  const cuts = new Set<number>();
  for (const span of dialogues) {
    if (span.end <= lineStart || span.start >= lineEnd) continue;
    const head = span.start - lineStart;
    if (head > 0 && !inNotation[head]) cuts.add(head);
    let tail = span.end - lineStart;
    if (tail <= 0 || tail >= line.length) continue;
    while (
      tail < line.length &&
      !inNotation[tail] &&
      (SENTENCE_END.indexOf(line[tail]) >= 0 || line[tail] === "、")
    ) {
      tail++;
    }
    if (tail < line.length && !inNotation[tail] && !inNotation[tail - 1]) {
      cuts.add(tail);
    }
  }
  return [...cuts].sort((a, b) => a - b);
}

/** 台詞の範囲（元の本文の位置） */
export interface DialogueSpan {
  start: number;
  end: number;
}

/**
 * 人物の声で読むときに「台詞」と見る範囲（設計書6.42.3）。
 *
 * - 見分け方は `core/quotedSpans.ts` の1つだけ（入れ子・閉じ忘れの立て直しを写さない）
 * - **「」は台詞。『』は行頭で開くときだけ台詞**——地の文の『死の谷』（書名・
 *   呼び名）を台詞の声で読むと、語りの途中で声が変わる。電話や心の声の『』は
 *   行頭に置かれることが多いので、そちらは台詞にする
 * - 最後まで閉じない台詞は台詞と見ない（話の残り全部が台詞の声になるより、
 *   語り手の声のほうがまだ聞ける）
 * - シーンメモの行の中の括弧は数えない（読まない行である）
 */
export function voiceDialogueSpans(text: string): DialogueSpan[] {
  const masked = text
    .split("\n")
    .map((line) => (isMemoLine(line) ? " ".repeat(line.length) : line))
    .join("\n");
  // **行頭の連なりだけを台詞にする**（作者の裁定、2026-11-05）。地の文の途中で
  // 語に付けた括弧（`空気を指す「風」は…`）まで台詞にすると、語りの途中で声が
  // 切り替わる。台詞は行頭（字下げのあと）から始まるものと、それに空白だけを
  // 挟んで続くもの（`「はい」「いいえ」` の2つ目）に限る。
  //
  // **行頭に人物名を置く書き方（`教頭先生「…」「…」`）も台詞にする**（作者の答え、
  // 2026-11-05 朝）。見分けは「行頭から、空白・句読点・括弧を含まない短い語（1〜12字。
  // 後ろに：を付けてもよい）のすぐあとに括弧が開き、その台詞（と空白だけを挟んで続く
  // 台詞）で行が終わる」。地の文の語の括弧（`空気を指す「風」は…`・`彼は「行こう」と
  // 言った。`）は、閉じたあとに地の文が続くので台詞にならない
  const spans = foldNestedOpeners(masked, quotedSpans(masked, { unclosedToEnd: false }));
  const blank = (from: number, to: number) => /^[ \t　]*$/.test(masked.slice(from, to));
  const out: DialogueSpan[] = [];
  let prevEnd = -1;
  for (let i = 0; i < spans.length; i++) {
    const span = spans[i];
    // **文の頭も行頭と同じに扱う**（作者の答え「B」、2026-11-05 朝）。地の文と台詞を
    // 1行に続けて書く作品（`…難問はあった。教頭先生「…」`・`…ことである。「貴方は…」`）の
    // 会話を拾うため。同じ行の、この括弧より前の最後の文の区切り（。！？）の直後を頭とする
    const lineHead = sentenceHeadBefore(
      masked,
      masked.lastIndexOf("\n", span.start - 1) + 1,
      span.start
    );
    const atHead = blank(lineHead, span.start);
    const chained = prevEnd >= lineHead && blank(prevEnd, span.start);
    if (atHead || chained) {
      out.push(span);
      prevEnd = span.end;
      continue;
    }
    if (!NAME_BEFORE_DIALOGUE.test(masked.slice(lineHead, span.start))) continue;
    // 同じ行で空白だけを挟んで続く台詞をまとめ、そのあと行が終わるかを見る
    let last = i;
    while (
      last + 1 < spans.length &&
      spans[last + 1].start > spans[last].end - 1 &&
      !masked.slice(spans[last].end, spans[last + 1].start).includes("\n") &&
      blank(spans[last].end, spans[last + 1].start)
    ) {
      last++;
    }
    const lineEndAt = masked.indexOf("\n", spans[last].end);
    const lineEnd = lineEndAt < 0 ? masked.length : lineEndAt;
    if (!blank(spans[last].end, lineEnd)) continue;
    for (let k = i; k <= last; k++) out.push(spans[k]);
    prevEnd = spans[last].end;
    i = last;
  }
  return out;
}

/**
 * 同じ行の `at` より前で、最後の文の区切り（。！？）の直後の位置。無ければ行頭。
 * 括弧の中の区切り（`「はい。」`）も区切りに数える——閉じたあとに続く台詞は
 * どのみち「空白だけを挟んで続く台詞」として拾われ、地の文が挟まれば区切りの
 * あとから数え直すのが、文の頭の見方として自然なため
 */
function sentenceHeadBefore(text: string, lineHead: number, at: number): number {
  for (let i = at - 1; i >= lineHead; i--) {
    if ("。！？!?".includes(text[i])) return i + 1;
  }
  return lineHead;
}

/**
 * 行頭に置いた人物名（字下げのあと、漢字・カタカナ・英数字の1〜12字。後ろの：は可）。
 * `教頭先生「…」`・`ジャック「…」` の名前に当たる。
 *
 * **ひらがなを含む語は名前と見ない**——`前の行は「地の文」` の「前の行は」のように、
 * 助詞（の・は・を）の入った地の文の頭と見分けられないため。ひらがなの名前
 * （`まどか「…」`）は地の文の声になるが、取り違えて地の文を台詞の声で読むより
 * 害が小さい。地の文の語と見分ける残りは、呼び出し側が「その台詞で行が終わるか」を見る
 */
const NAME_BEFORE_DIALOGUE =
  /^[ \t　]*[\p{Script=Han}\p{Script=Katakana}ー々〆A-Za-zＡ-Ｚａ-ｚ0-9０-９]{1,12}[：:]?$/u;

/**
 * 括弧を重ねた台詞（「「はぁい」」、「「「…」」」」）を1つの台詞に畳む。
 *
 * `quotedSpans` の「閉じ忘れの立て直し」は、2つ目の開き括弧で前の台詞を1字で
 * 閉じてしまう。ここから開き括弧1字だけの偽の台詞が出て、台詞の番号とAIへの
 * 質問が増え、声のエンジンへ1字の文が渡っていた。`quotedSpans` は他の機能も
 * 使うので触らず、人物の声の読みだけで畳む。
 *
 * - 開き括弧1字だけの範囲に、同じ種類の開き括弧で始まる範囲が隙間なく続くとき、
 *   それらと、台詞の後ろに余った閉じ括弧の連なりを1つにする
 * - 畳めなかった開き括弧1字だけの範囲（中身の無い台詞）は台詞にしない
 */
function foldNestedOpeners(
  text: string,
  spans: readonly DialogueSpan[]
): DialogueSpan[] {
  const out: DialogueSpan[] = [];
  for (let i = 0; i < spans.length; i++) {
    const first = spans[i];
    if (first.end - first.start !== 1) {
      out.push(first);
      continue;
    }
    const opener = text[first.start];
    let tail = first.end;
    let closedByReal = false;
    let j = i + 1;
    // 1字の開き括弧が隙間なく続くあいだ飲み込み、本物の台詞に当たったら終える
    while (j < spans.length && spans[j].start === tail && text[tail] === opener) {
      const next = spans[j];
      tail = next.end;
      j++;
      if (next.end - next.start !== 1) {
        closedByReal = true;
        break;
      }
    }
    i = j - 1;
    // 閉じる台詞に行き着かなかった開き括弧だけの並びは、中身の無い台詞
    if (!closedByReal) continue;
    const closer = opener === "「" ? "」" : "』";
    let end = tail;
    while (text[end] === closer) end++;
    out.push({ start: first.start, end });
  }
  return out;
}

/** その位置を含む台詞の添字（無ければ -1） */
function dialogueAt(dialogues: readonly DialogueSpan[], offset: number): number {
  for (let i = 0; i < dialogues.length; i++) {
    if (dialogues[i].start > offset) break;
    if (offset < dialogues[i].end) return i;
  }
  return -1;
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
  notation: NotationMode,
  spans: readonly ReadingSpan[],
  dialogues: readonly DialogueSpan[],
  dropBracketOnly: boolean
): ReadingSentence | undefined {
  let start = rawStart;
  let end = rawEnd;
  while (start < end && isEdgeSpace(text[start])) start++;
  while (end > start && isEdgeSpace(text[end - 1])) end--;
  if (start >= end) return undefined;

  const speech = toSpeech(
    withReadings(text.slice(start, end), start, spans),
    notation
  );
  if (speech === "") return undefined;
  // 人物の声の計画だけ：括弧しか無い文（台詞の余った閉じ括弧など）は声に渡さない。
  // OS の声の読み上げは従来のまま（動きを変えない）
  if (dropBracketOnly && /^[「」『』]+$/.test(speech)) return undefined;
  const dialogue = dialogueAt(dialogues, start);
  return dialogue < 0
    ? { start, end, line, speech, kind: "narration" }
    : { start, end, line, speech, kind: "dialogue", dialogue };
}

/**
 * その行に当てる読みの範囲。**行の中に収まり、記法に掛からないものだけ。**
 *
 * 記法の内側（ルビの親文字・傍点の中）は作者が読ませ方を決めている所なので、
 * 辞書の読みで上書きしない（作者のルビが勝つ。設計書6.42.1）。
 */
function spansInLine(
  spans: readonly ReadingSpan[],
  lineStart: number,
  lineEnd: number,
  inNotation: readonly boolean[]
): ReadingSpan[] {
  const out: ReadingSpan[] = [];
  for (const span of spans) {
    if (span.start < lineStart || span.end > lineEnd) continue;
    let touches = false;
    for (let at = span.start; at < span.end; at++) {
      if (inNotation[at - lineStart]) {
        touches = true;
        break;
      }
    }
    if (!touches) out.push(span);
  }
  return out;
}

/**
 * 文の写しの中で、辞書の範囲を読みへ差し替える。
 *
 * **後ろから差し替える**——前から差し替えると、読みと語の字数の違いで
 * 後ろの範囲の位置がずれる。範囲は記法に掛からないものだけが来るうえ、
 * 読みはひらがなだけなので、差し替えたあとで記法の読み方が変わることはない。
 */
function withReadings(
  source: string,
  sourceStart: number,
  spans: readonly ReadingSpan[]
): string {
  const sourceEnd = sourceStart + source.length;
  const inside = spans
    .filter((span) => span.start >= sourceStart && span.end <= sourceEnd)
    .sort((a, b) => b.start - a.start);
  let out = source;
  for (const span of inside) {
    out =
      out.slice(0, span.start - sourceStart) +
      span.reading +
      out.slice(span.end - sourceStart);
  }
  return out;
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

const MEMO_MARK_RE = new RegExp(MEMO_LINE_PATTERN);

/**
 * その1行が「引っかかった」で置いたメモか（設計書6.42）。
 *
 * **同じ文の上に2つ挿さないための見分け**（不具合、2026-10-17）。止めて
 * ［▶ 続ける］で読み直すと［⚑］がまた押せるようになり、同じ文でもう一度
 * 押すと、直前に同じ行がもう1つ入っていた。直前の行がこれなら挿さない。
 *
 * 印の書き方（`//`・`／／`・字下げ・印のあとの空白）は付箋の決まり
 * （`core/sceneMemo.ts`）にそろえる。作者が手で直した行でも同じ印と読むため。
 * **中身が違えば別の付箋**——作者が書いたメモの上へは、これまでどおり挿す。
 */
export function isReadingMemoLine(line: string): boolean {
  if (!isMemoLine(line)) return false;
  const body = line.replace(MEMO_MARK_RE, "").replace(/^[\s　]+|[\s　]+$/g, "");
  return body === READ_ALOUD_MEMO_TEXT;
}
