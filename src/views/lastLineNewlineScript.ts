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
 * - 次の行へ進むキーは、横書きでは ↓、縦書きでは ←（縦書きは次の行が左にある）。
 *   縦書きのキーは作者にまだ確かめていない。**替えるのは下の1か所だけ**
 * - 「最後の行」は、**見えている行**（折り返した行を別々に数える）で決める。折り返した
 *   最後の段落の1行目で ↓ を押したときは、ふつうに2行目へ動かすため
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

/**
 * 次の行へ進むキー（縦書き・Mac）。**Mac では、縦書きの ← は本文の流れで1字前へ戻り、↓ が次の行へ動く**
 * （1.0.9。Mac は矢印に編集の命令〔moveLeft など〕を添えて届け、Chromium はそれを縦書きでも横書きと
 * 同じ向きで解く。画面を出さない Edge で、Mac と同じ届け方を試して確かめた。1.0.7 からの動き）。
 * Mac で ← のまま置くと、最後の行の末尾で「1字戻る」つもりの ← が改行を足してしまう
 */
export const LAST_LINE_NEWLINE_KEY_VERTICAL_MAC = "ArrowDown";

export const LAST_LINE_NEWLINE_SOURCE = `
var LAST_LINE_NEWLINE_MAX_BLANK = ${LAST_LINE_NEWLINE_MAX_BLANK};
var LAST_LINE_NEWLINE_KEY_HORIZONTAL = ${JSON.stringify(LAST_LINE_NEWLINE_KEY_HORIZONTAL)};
var LAST_LINE_NEWLINE_KEY_VERTICAL = ${JSON.stringify(LAST_LINE_NEWLINE_KEY_VERTICAL)};
var LAST_LINE_NEWLINE_KEY_VERTICAL_MAC = ${JSON.stringify(LAST_LINE_NEWLINE_KEY_VERTICAL_MAC)};

/** 次の行へ進むキーの名前（event.key）。縦書きかどうか・Mac かどうかで替わる */
function lastLineNewlineKey(vertical, mac) {
  if (!vertical) return LAST_LINE_NEWLINE_KEY_HORIZONTAL;
  return mac ? LAST_LINE_NEWLINE_KEY_VERTICAL_MAC : LAST_LINE_NEWLINE_KEY_VERTICAL;
}

/** 動いている機械が Mac か（WebView の中の navigator で見る） */
function lastLineNewlineOnMac() {
  var nav = typeof navigator === "undefined" ? null : navigator;
  if (!nav) return false;
  var platform = String(nav.platform || (nav.userAgentData && nav.userAgentData.platform) || "");
  return /mac/i.test(platform);
}

/** 本文の末尾に並ぶ空行（字の無い行）の数。LF の本文を渡す。空の本文は空行1行と数える */
function lastLineBlankCount(text) {
  var lines = String(text).split("\\n");
  var count = 0;
  for (var i = lines.length - 1; i >= 0 && lines[i] === ""; i--) count++;
  return count;
}

/**
 * 改行を足してよいか（見えている行のことは含まない。呼び側が最後の見えている行かを別に確かめる）。
 * 選んだ範囲があれば足さない。カーソルより後ろに改行があれば（最後の論理行でなければ）足さない。
 * 末尾の空行がすでに上限なら足さない
 */
function lastLineNewlineAllowed(text, start, end) {
  if (typeof start !== "number" || typeof end !== "number") return false;
  if (start !== end) return false;
  var value = String(text);
  if (start < 0 || start > value.length) return false;
  if (value.indexOf("\\n", start) !== -1) return false;
  return lastLineBlankCount(value) < LAST_LINE_NEWLINE_MAX_BLANK;
}

/**
 * 2つの箱（{ left, right, top, bottom }）が同じ見えている行にあるか。
 * 横書きは上下の真ん中、縦書きは左右の真ん中が、字の高さ（幅）の半分以内なら同じ行。
 * 測れなかった（null）ときは false（足さずに、ふつうの動きへ任せる）
 */
function lastLineSameRow(a, b, vertical) {
  if (!a || !b) return false;
  var ca = vertical ? (a.left + a.right) / 2 : (a.top + a.bottom) / 2;
  var cb = vertical ? (b.left + b.right) / 2 : (b.top + b.bottom) / 2;
  var sa = vertical ? a.right - a.left : a.bottom - a.top;
  var sb = vertical ? b.right - b.left : b.bottom - b.top;
  var size = Math.max(sa, sb, 1);
  return Math.abs(ca - cb) <= size / 2;
}
`;
