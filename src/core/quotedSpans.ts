/**
 * 台詞（「」『』）の範囲を見分ける（2026-09-25、人称のよじれの2回目。設計書6.9.2）。
 *
 * **入れ子を数える。** それまで3か所（語り手の名前のよじれ・語尾単調・一人称の
 * 数え方）が同じ正規表現 `[「『][^」』]*[」』]` を持っていて、台詞の中の
 * 『死の谷』の』で台詞が閉じたと見ていた。後ろの「…イントは体調が戻るまで」が
 * 地の文に数えられ、作者の作品で語り手の名前のよじれを誤って拾った
 * （教科書チート18話）。3か所が別々に直ると、また黙って食い違うので、
 * 見分け方をここ1か所に置く。
 *
 * 決まり：
 *
 * - 「と『は開き、」と』は閉じる。**開いた括弧に対応する閉じ括弧で閉じる**
 *   （「…『…』…」の中の』では外の「」は閉じない）
 * - 対応しない閉じ括弧（「…』の書き違い）は、いちばん内側を閉じる。
 *   開いていないのに現れた閉じ括弧（台詞の途中から切り出した本文の頭など）は見ない
 * - **閉じ忘れの立て直し**：「が開いたまま次の「が現れたら、前の台詞はその手前で
 *   終わったと見る（『だけの台詞も同じ）。昔の書き方の「段落ごとに開いて最後だけ
 *   閉じる」長い台詞もこの形になる。入れ子を数えるだけだと、1つの閉じ忘れが
 *   本文の終わりまでを台詞にしてしまう
 * - 最後まで閉じない台詞は、`unclosedToEnd` が真なら本文の終わりまでを台詞と見る
 *   （チャンクの切れ目で台詞が切れた形。**拾わない側へ倒す**）。偽なら台詞と見ない
 *   （作品全体の一人称を数えるとき、末尾の1つの閉じ忘れで数が痩せないように）
 *
 * 位置は UTF-16 の添字（`String.prototype.slice` と同じ）で返す。
 */

export interface QuotedSpan {
  /** 開き括弧の位置 */
  start: number;
  /** 閉じ括弧の次の位置（閉じていなければ、次の台詞の手前か本文の終わり） */
  end: number;
}

const OPEN_TO_CLOSE: Record<string, string> = { "「": "」", "『": "』" };
const CLOSERS = new Set(["」", "』"]);

export function quotedSpans(
  text: string,
  options: { unclosedToEnd?: boolean } = {}
): QuotedSpan[] {
  const unclosedToEnd = options.unclosedToEnd ?? true;
  const spans: QuotedSpan[] = [];
  // 開いている括弧（外側から順）
  const stack: string[] = [];
  let start = -1;

  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    const closer = OPEN_TO_CLOSE[char];
    if (closer) {
      // **閉じ忘れの立て直し**：いちばん外側と同じ括弧がまた開いたら、
      // 前の台詞はその手前で終わっていたと見る
      if (stack.length > 0 && stack[0] === char) {
        spans.push({ start, end: index });
        stack.length = 0;
      }
      if (stack.length === 0) start = index;
      stack.push(char);
      continue;
    }
    if (!CLOSERS.has(char) || stack.length === 0) continue;
    // 対応する開き括弧まで戻る。無ければいちばん内側を閉じる（書き違い）
    let depth = stack.length - 1;
    while (depth >= 0 && OPEN_TO_CLOSE[stack[depth]] !== char) depth--;
    stack.length = depth >= 0 ? depth : stack.length - 1;
    if (stack.length === 0) spans.push({ start, end: index + 1 });
  }
  if (stack.length > 0 && unclosedToEnd) {
    spans.push({ start, end: text.length });
  }
  return spans;
}

/**
 * 台詞を、**同じ長さの `fill` へ置き換える**（改行は残す）。
 *
 * 位置と行番号を保ったまま「台詞は無いことにする」ために使う。
 * 1文字ずつ（UTF-16 の単位で）置き換えるので、代用対（サロゲートペア）も
 * 2つの `fill` になり、長さ＝位置が狂わない。
 */
export function maskQuoted(
  text: string,
  fill: string,
  options: { unclosedToEnd?: boolean } = {}
): string {
  const spans = quotedSpans(text, options);
  if (spans.length === 0) return text;
  let out = "";
  let cursor = 0;
  for (const span of spans) {
    out += text.slice(cursor, span.start);
    out += text.slice(span.start, span.end).replace(/[^\n]/g, fill);
    cursor = span.end;
  }
  return out + text.slice(cursor);
}

/** 台詞を取り除く（位置は変わる。数えるだけのとき用） */
export function removeQuoted(
  text: string,
  options: { unclosedToEnd?: boolean } = {}
): string {
  const spans = quotedSpans(text, options);
  if (spans.length === 0) return text;
  let out = "";
  let cursor = 0;
  for (const span of spans) {
    out += text.slice(cursor, span.start);
    cursor = span.end;
  }
  return out + text.slice(cursor);
}
