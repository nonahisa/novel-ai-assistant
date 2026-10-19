/**
 * WebView の「Enter で送る・実行する欄」で、**日本語の変換を確定する Enter を
 * 送信として扱わない**ための小さな部品（設計書6.4.10・6.25）。
 *
 * ここが返すのは **WebView の中へ埋める JavaScript の文字列**（`<script>` の中で
 * 使う関数の定義）。`visibleWidthScript.ts` と同じ置き方。呼び側は
 *
 *   const isImeEnter = watchImeEnter(inputEl);
 *   inputEl.addEventListener("keydown", function (event) {
 *     if (event.key !== "Enter") return;
 *     if (isImeEnter(event)) return;
 *     ...送る...
 *   });
 *
 * と書く。この文字列の中にはバッククォートも `${` も置かない（呼び側の
 * テンプレートリテラルを壊す）。
 *
 * ## なぜ isComposing と keyCode 229 だけでは足りないか
 *
 * プロットモードの相談欄で、変換の確定の Enter を1回押しただけで AI へ送られた
 * （作者の実機、2026-10-19。Windows・拡張機能開発ホスト）。欄の防ぎは
 * `isComposing || keyCode === 229` だった。Windows の日本語入力では
 * **compositionend が先に起き、確定の打鍵の知らせがあとから来る**組み合わせがある
 * （原稿エディターの本文でも、確定ぶんの input が compositionend のあとに届くのを
 * 見ている。`manuscriptEditorHtml.ts` の compositionend の扱い）。その順で届いた
 * keydown は、もう変換中ではないので isComposing が false、keyCode も 13 になる。
 *
 * ## 判定の決まり（どれか1つでも当たれば「確定の Enter」として送らない）
 *
 * 1. `isComposing` が真
 * 2. `keyCode` が 229（変換中の打鍵を表す古い印。Safari などは確定の keydown を
 *    compositionend のあとに isComposing=false・229 で出す）
 * 3. 自前の印が立っている（compositionstart で立て、compositionend で下ろす）。
 *    isComposing を持たない古い環境のため
 * 4. **compositionend の直後**：compositionend のあと、Enter の keyup を見るまで、
 *    ただし最長 `IME_COMMIT_ENTER_WINDOW_MS`。上の Windows の並びを塞ぐ
 *
 * 4 を「keyup まで」だけにしないのは、候補をマウスで選んで確定したときなど、
 * keyup が来ない確定があるから（印が残り、次のふつうの Enter を1回食う）。
 * 時間だけにしないのは、確定してすぐ送りたい人の2度目の Enter を食わないため
 * （確定の Enter を離せば、その場で窓を閉じる）。**迷ったら塞ぐ側へ倒す**——
 * ふつうの Enter を1回食っても押し直せば済むが、確定の Enter を通すと有料の
 * AI 呼び出しが走る。
 *
 * ## 印が立ったまま戻らないとき
 *
 * 窓の切り替えなどで compositionend が落ちると、3 の印が立ちっぱなしになり、
 * Enter が二度と効かなくなる（送るボタンは効くので気づきにくい）。原稿エディターの
 * 本文と同じ考え（設計書6.25.9）で、**input が「変換中ではない」と言ったら**
 * （`isComposing === false`）印を下ろす。焦点が外れたときも下ろす。
 */

/**
 * 確定の打鍵の keydown が compositionend のあとに遅れて届くときの、待つ長さの上限（ms）。
 * 遅れて届く keydown は同じ打鍵の知らせで、同じ処理の束の中で届く（数十 ms より短い）。
 * 確定の Enter の keyup が来ればその場で窓を閉じるので、この長さが効くのは keyup の
 * 来ない確定（マウスで候補を選んだ等）のあとだけ。そのあと 0.5 秒以内に押した
 * ふつうの Enter は1回食うが、押し直せば送れる。
 */
export const IME_COMMIT_ENTER_WINDOW_MS = 500;

export const IME_ENTER_GUARD_SOURCE = `
function watchImeEnter(input, now) {
  const clock = typeof now === 'function'
    ? now
    : function () { return performance.now(); };
  let composing = false;
  let endedAt = null;
  input.addEventListener('compositionstart', function () {
    composing = true;
    endedAt = null;
  });
  input.addEventListener('compositionend', function () {
    composing = false;
    endedAt = clock();
  });
  input.addEventListener('keyup', function (event) {
    if (event.key === 'Enter' && event.keyCode !== 229) endedAt = null;
  });
  input.addEventListener('input', function (event) {
    if (composing && event.isComposing === false) composing = false;
  });
  input.addEventListener('blur', function () {
    composing = false;
    endedAt = null;
  });
  return function isImeEnter(event) {
    if (event.isComposing) return true;
    if (event.keyCode === 229) return true;
    if (composing) return true;
    if (endedAt !== null) {
      if (clock() - endedAt <= ${IME_COMMIT_ENTER_WINDOW_MS}) return true;
      endedAt = null;
    }
    return false;
  };
}
`;
