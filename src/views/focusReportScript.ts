/**
 * WebView のパネルが**押さずに焦点を受けた**ことを、拡張機能へ知らせる小さな部品
 * （2026-11-14。0.152.1 で原稿エディターだけに入れた知らせを、ほかのパネルへ広げた）。
 *
 * ここが返すのは **WebView の中へ埋める JavaScript の文字列**（`<script>` の中で
 * 使う関数の定義）。`imeEnterGuardScript.ts` と同じ置き方。呼び側は
 *
 *   reportFocusWithoutPointer(window, function () {
 *     vscode.postMessage({ type: "focusWithoutPointer" });
 *   });
 *
 * と書く。送り方を引数で受けるのは、パネルごとに `acquireVsCodeApi()` の
 * 受け取り方（変数名・const/var）が違うため。この文字列の中にはバッククォートも
 * `${` も置かない（呼び側のテンプレートリテラルを壊す）。
 *
 * ## なぜ知らせるのか
 *
 * 窓（範囲の窓・作品を選ぶ窓など）が閉じると、VS Code 本体は焦点を元の画面へ戻す。
 * WebView へは 50ms 遅らせて「focus」の便を中へ送る。便の処理が遅れると、続けて
 * 出た確認の窓（外をクリックしても閉じない）から焦点を取ってしまい、Enter が窓へ
 * 届かない。拡張機能は、窓が出ている間にこの知らせを受けたら窓へ焦点を戻す
 * （`pickerFocus.ts` の `reclaimPickerFocus`）。
 *
 * ## 作者が押して移した焦点は知らせない
 *
 * 押している間（pointerdown から pointerup の直後まで）に受けた焦点は作者のもの。
 * 時間で分けないのは、遅い機械ほど間合いが延びて外れるため（原稿エディターと同じ考え）。
 * 原稿エディターには同じ処理の写しが残っている（`manuscriptEditorHtml.ts`。
 * 別の担当が触っている間は寄せない）。
 */
export const FOCUS_WITHOUT_POINTER_MESSAGE = "focusWithoutPointer";

export const REPORT_FOCUS_WITHOUT_POINTER_SOURCE = `
function reportFocusWithoutPointer(win, send, later) {
  const afterNow = typeof later === 'function'
    ? later
    : function (callback) { setTimeout(callback, 0); };
  let pointerPressing = false;
  win.addEventListener(
    'pointerdown',
    function () {
      pointerPressing = true;
    },
    true
  );
  win.addEventListener(
    'pointerup',
    function () {
      // 押し終わりの直後に届く焦点（クリックで受けるもの）も作者のものにする
      afterNow(function () {
        pointerPressing = false;
      });
    },
    true
  );
  win.addEventListener('focus', function (event) {
    // 中の欄が受けた焦点（target が欄）は数えない。窓そのものが受けたときだけ
    if (event.target !== win || pointerPressing) return;
    send();
  });
}
`;

/**
 * パネルの `<script>` へそのまま置く形（定義と呼び出し）。`vscodeApi` は
 * そのパネルで `acquireVsCodeApi()` を受けた変数の名前
 */
export function reportFocusWithoutPointerScript(vscodeApi: string): string {
  return (
    REPORT_FOCUS_WITHOUT_POINTER_SOURCE +
    `reportFocusWithoutPointer(window, function () {\n` +
    `  ${vscodeApi}.postMessage({ type: "${FOCUS_WITHOUT_POINTER_MESSAGE}" });\n` +
    `});\n`
  );
}
