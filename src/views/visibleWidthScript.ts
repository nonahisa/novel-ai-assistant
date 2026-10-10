/**
 * WebView の中で「窓の中で実際に見えている幅」を測る小さな部品（設計書6.11.7・6.25）。
 *
 * 実機確認リスト 4544（作者の裁定 2026-10-09）：窓を狭くすると、提案パネルの文も、
 * 原稿エディターの下の段の文も、右端で切れていた。パネルの組み方のせいではない。
 * VS Code の編集の列には最小の幅（220px）があり、左の列・サイドバーと足して窓に
 * 収まらないと、**右の列の端が窓の外へ出て切り落とされる**。WebView の中からは
 * 自分の幅が220pxに見えるので、折り返しが起きない。
 *
 * 最上位の窓に対する交差を返す IntersectionObserver（root を渡さない）は、窓の端と
 * 途中の切り落としを含めた幅を返す。**切れているときだけ**、その幅を知らせる
 * （広いとき・切れていないときは 0 を知らせる＝何も詰めない）ので、見た目は変わらない。
 * 見える幅が0のとき（タブを切り替えて面が隠れたとき）も 0 を知らせる。詰めると
 * 戻ってきたときに幅0の面が一瞬見える。
 *
 * ここが返すのは **WebView の中へ埋める JavaScript の文字列**（`<script>` の中で
 * 使う関数の定義）。呼び側は `observeVisibleWidth(function (clippedWidth) { ... })`
 * と書く。この文字列の中にはバッククォートも `${` も置かない（呼び側のテンプレート
 * リテラルを壊す）。
 */
export const OBSERVE_VISIBLE_WIDTH_SOURCE = `
function observeVisibleWidth(onChange) {
  if (typeof IntersectionObserver !== 'function') return;
  const probe = document.createElement('div');
  probe.setAttribute('aria-hidden', 'true');
  probe.style.position = 'fixed';
  probe.style.left = '0';
  probe.style.right = '0';
  probe.style.top = '0';
  probe.style.height = '1px';
  probe.style.opacity = '0';
  probe.style.pointerEvents = 'none';
  document.body.appendChild(probe);
  const steps = [];
  for (let i = 0; i <= 100; i++) steps.push(i / 100);
  function apply(entry) {
    const seen = entry.intersectionRect.width;
    const whole = entry.boundingClientRect.width;
    // 2px までのずれは切れていないとみなす。拡大率が端数（125%・150%）の機械では、
    // 窓の中に収まっている列でも、見えている幅が要素の幅より1px足らず狭く測られる
    // （150% で 1242.67 と 1243.33。2026-10-10、ノートPCの VS Code 1.141.0）。
    // 切り捨ててから比べていた頃は、広い窓でも下の段・本文の面へ幅を書き込んでいた。
    // 本当に切れるときは列の最小幅のせいで十数px以上外へ出るので、2px で取りこぼさない
    const clipped = seen >= 1 && seen < whole - 2;
    onChange(clipped ? Math.floor(seen) : 0);
  }
  const observer = new IntersectionObserver(function (entries) {
    apply(entries[entries.length - 1]);
  }, { threshold: steps });
  observer.observe(probe);
  // 窓の幅だけが変わって見える割合の段を跨がないと知らせが来ないので、測り直す
  window.addEventListener('resize', function () {
    observer.unobserve(probe);
    observer.observe(probe);
  });
}
`;
