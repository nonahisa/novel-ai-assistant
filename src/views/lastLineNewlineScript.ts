/**
 * 原稿エディターで、最後の行から「次の行へ進むキー」を押したときに改行を1つ足す判定の部品
 * （作者の依頼、2026-11-15「最終行で下ボタンを押した場合、改行を自動で入れて欲しい。
 * ただし空行2行でストップで」。設計書6.25）。
 *
 * ここが返すのは **WebView の中へ埋める JavaScript の文字列**（`imeEnterGuardScript.ts` と同じ置き方）。
 * 純粋な判定（行の数え方・最後の行か・足すか）だけをこの中に置き、DOM に触る所
 * （カーソルの位置の読み取りと改行の差し込み）は `manuscriptEditorHtml.ts` に残す。
 * こうしておくと、判定を作り物の値で単体テストできる。
 *
 * この文字列の中にはバッククォートも `${` も置かない（呼び側のテンプレートリテラルを壊す）。
 *
 * ## 決めたこと
 *
 * - 「空行」は、字の無い行。**末尾の空行が2行になったら、それ以上は足さない**。
 *   最後の行に字があるときに押すと空行が1行（改行1つ）増える
 * - 次の行へ進むキーは、横書きでは ↓、縦書きでは ←（縦書きは次の行が左にある。作者の答え
 *   2026-11-15「縦書きは←キー」。本物の Mac でも ← が次の行へ進む）。**替えるのは下の1か所だけ**
 * - 足すのは、**カーソルが文書の末尾（後ろに字が無い所）にあるときだけ**（1.0.11）。最後の行の途中や、
 *   折り返した最後の段落の途中の行で押したときは何もせず、ふつうの動きに任せる。末尾は必ず最後の
 *   見えている行にあるので、見えている行を測る判定（1.0.8〜1.0.10 の lastLineSameRow）は要らなくなった
 */

/** 末尾の空行がこの数に達したら、もう足さない */
export const LAST_LINE_NEWLINE_MAX_BLANK = 2;

/** 次の行へ進むキー（横書き）。縦書きは下の LAST_LINE_NEWLINE_KEY_VERTICAL */
export const LAST_LINE_NEWLINE_KEY_HORIZONTAL = "ArrowDown";

/**
 * 次の行へ進むキー（縦書き）。**作者にまだ確かめていない**（縦書きは行が右から左へ並ぶので
 * 次の行は左、と置いた）。違えばここだけ替える
 */
export const LAST_LINE_NEWLINE_KEY_VERTICAL = "ArrowLeft";

/*
  1.0.9 で「Mac の縦書きだけ ↓」に分けたが、本物の Mac で作者が押すと ← が次の行へ進み（Windows と同じ）、
  ↓ は同じ列の1字先へ進んだ（2026-11-15）。画面を出さない Edge で Mac の届け方を真似た見込みが外れていたので、
  1.0.11 で分けるのをやめた
*/

export const LAST_LINE_NEWLINE_SOURCE = `
var LAST_LINE_NEWLINE_MAX_BLANK = ${LAST_LINE_NEWLINE_MAX_BLANK};
var LAST_LINE_NEWLINE_KEY_HORIZONTAL = ${JSON.stringify(LAST_LINE_NEWLINE_KEY_HORIZONTAL)};
var LAST_LINE_NEWLINE_KEY_VERTICAL = ${JSON.stringify(LAST_LINE_NEWLINE_KEY_VERTICAL)};

/** 次の行へ進むキーの名前（event.key）。縦書きかどうかで替わる */
function lastLineNewlineKey(vertical) {
  return vertical ? LAST_LINE_NEWLINE_KEY_VERTICAL : LAST_LINE_NEWLINE_KEY_HORIZONTAL;
}

/** 本文の末尾に並ぶ空行（字の無い行）の数。LF の本文を渡す。空の本文は空行1行と数える */
function lastLineBlankCount(text) {
  var lines = String(text).split("\\n");
  var count = 0;
  for (var i = lines.length - 1; i >= 0 && lines[i] === ""; i--) count++;
  return count;
}

/**
 * 改行を足してよいか。**カーソルが文書の末尾（後ろに字が1つも無い所）にあるときだけ**足す。
 * 最後の行の途中で押したときに足すと、カーソルの位置で行を割り、後ろの字を次の行へ押し出す
 * （1.0.8〜1.0.10。作者が本物の Mac で、最後の行の「。」の手前で押して「。」が次の行へ移り、
 * 「この動作は求めていたものではありません」。2026-11-15）。末尾なら足す場所も末尾なので、字は動かない。
 * 選んだ範囲があれば足さない。末尾の空行がすでに上限なら足さない
 */
function lastLineNewlineAllowed(text, start, end) {
  if (typeof start !== "number" || typeof end !== "number") return false;
  if (start !== end) return false;
  var value = String(text);
  if (start !== value.length) return false;
  return lastLineBlankCount(value) < LAST_LINE_NEWLINE_MAX_BLANK;
}
`;
