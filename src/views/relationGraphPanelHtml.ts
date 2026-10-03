import { TERM_COLORS } from "../core/termColors";
import { ZOOM_LIMITS } from "../core/relationGraphViewport";

/**
 * 人物相関図の画面（設計書6.38.4）。
 *
 * 外部ライブラリを使わず、自前のSVGで描く（執筆量パネル・名前の点検と
 * 同じ判断）。WebView は既定で外部への通信を禁じており、描画ライブラリを
 * 同梱してCSPを緩めるほどの絵は要らない。
 *
 * 値はすべて postMessage で渡し、HTMLへ文字列として埋め込まない
 * （人物名の引用符で画面が壊れるのを防ぐ）。
 *
 * 計算はしない。図の組み立て（`core/relationGraph.ts`）も配置
 * （`core/relationGraphLayout.ts`）も拡張機能側で済ませてある。ここが描く
 * のは受け取った座標だけで、押したことは拡張機能へ返す。
 *
 * この画面は関係・呼称・所属を書き換えない（設計書6.38.5）。
 */

/**
 * 用語の色を、CSSの変数として差し込む。
 *
 * 人物のノードは人物の色、所属の帯は組織の色（設計書6.38.2）。16進は
 * `core/termColors.ts` にしか無い——ここへ写すと、本文の色を変えた日に
 * 図だけが古い色のまま残る（`test/unit/core/termColors.test.ts` が見張る）。
 *
 * 明るいほうを既定に置き、暗いテーマだけを上書きする。VS Code が body へ
 * class を付けない場面でも色が消えないようにするため（設定資料パネルと
 * 同じ受け方）。
 */
function termColorVariables(): string {
  const light = Object.entries(TERM_COLORS)
    .map(([kind, color]) => `  --novelai-${kind}: ${color.light};`)
    .join("\n");
  const dark = Object.entries(TERM_COLORS)
    .map(([kind, color]) => `  --novelai-${kind}: ${color.dark};`)
    .join("\n");
  return `:root {
${light}
}
body.vscode-dark, body.vscode-high-contrast {
${dark}
}`;
}

export function buildRelationGraphPanelHtml(
  nonce: string,
  cspSource: string
): string {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src ${cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>人物相関図</title>
<style nonce="${nonce}">
${termColorVariables()}
* { box-sizing: border-box; }
body {
  margin: 0;
  height: 100vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size);
  color: var(--vscode-foreground);
  background: var(--vscode-editor-background);
}
header {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  padding: 10px 16px;
  border-bottom: 1px solid var(--vscode-panel-border);
}
h1 { font-size: 1.15em; margin: 0; flex: 1; }
button {
  background: var(--vscode-button-secondaryBackground);
  color: var(--vscode-button-secondaryForeground);
  border: none;
  border-radius: 2px;
  padding: 4px 12px;
  cursor: pointer;
  font-size: inherit;
  font-family: inherit;
}
button:hover:enabled { background: var(--vscode-button-secondaryHoverBackground); }
button:disabled { opacity: 0.45; cursor: default; }
button.on {
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
}
/* min-height: 0 が無いと、図の高さに引きずられて縮まなくなる */
#layout { display: flex; flex: 1; min-height: 0; }
#filters {
  width: 210px;
  min-width: 170px;
  padding: 12px;
  overflow-y: auto;
  border-right: 1px solid var(--vscode-panel-border);
}
/* 図は欄いっぱいに広げ、見せる範囲は viewBox で決める（拡大・縮小と移動。
   設計書6.38.2）。欄そのものはスクロールさせない——スクロールと図の移動が
   2つあると、どちらで動いているのか作者に分からなくなる。
   材料が無いときの案内（.empty）は margin:auto で真ん中へ置く */
#canvas { flex: 1; min-width: 0; overflow: hidden; position: relative; display: flex; }
#side {
  width: 280px;
  min-width: 220px;
  padding: 12px;
  overflow-y: auto;
  border-left: 1px solid var(--vscode-panel-border);
}
.filter { margin-bottom: 16px; }
.filter-title {
  display: block;
  font-size: 12px;
  color: var(--vscode-descriptionForeground);
  margin-bottom: 4px;
}
.filter label { display: block; font-size: 12px; margin: 2px 0; cursor: pointer; }
.filter input[type="range"] { width: 100%; }
.filter input[type="search"] {
  width: 100%;
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border, transparent);
  border-radius: 2px;
  padding: 3px 6px;
  font-family: inherit;
  font-size: inherit;
}
.sub { font-size: 11px; color: var(--vscode-descriptionForeground); margin-top: 4px; line-height: 1.5; }
.empty {
  margin: auto;
  padding: 32px 16px;
  color: var(--vscode-descriptionForeground);
  line-height: 1.8;
  max-width: 34em;
}
h2 { font-size: 1em; margin: 0 0 8px; }
h3 {
  font-size: 12px;
  color: var(--vscode-descriptionForeground);
  margin: 14px 0 4px;
  font-weight: normal;
}
.pair { line-height: 1.7; }
.pair .who { font-weight: 600; }
.side-row { padding: 3px 0; line-height: 1.6; }
.person-link {
  background: none;
  border: none;
  color: var(--vscode-textLink-foreground);
  padding: 0;
  text-align: left;
  cursor: pointer;
  font-family: inherit;
  font-size: inherit;
}
.person-link:hover { text-decoration: underline; }
footer {
  padding: 6px 16px;
  border-top: 1px solid var(--vscode-panel-border);
  font-size: 12px;
  color: var(--vscode-descriptionForeground);
  min-height: 26px;
}
/* 欄いっぱいに広げる（設計書6.38.4）。図の大きさは viewBox が決めるので、
   最小の幅・高さも、幅・高さの属性も持たない（以前は最小280画素と
   欄のスクロールで小ささをしのいでいたが、拡大できるようになって要らなくなった）。
   viewBox の縦横比は欄に揃えるので、preserveAspectRatio は保険として残す。
   touch-action: none は、タッチやペンで引いたときにブラウザのスクロールへ
   取られないため */
svg {
  position: absolute;
  inset: 0;
  display: block;
  width: 100%;
  height: 100%;
  max-width: 100%;
  max-height: 100%;
  touch-action: none;
  cursor: grab;
  user-select: none;
}
svg.dragging { cursor: grabbing; }
/* 拡大・縮小のボタン。図の右下の隅に重ねる */
#zoom {
  position: absolute;
  right: 10px;
  bottom: 10px;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px;
  border: 1px solid var(--vscode-panel-border);
  border-radius: 4px;
  background: var(--vscode-editor-background);
}
#zoom button { padding: 2px 10px; }
#zoomValue {
  min-width: 3.6em;
  text-align: center;
  font-size: 12px;
  color: var(--vscode-descriptionForeground);
}
/* 図の中の見た目。書き出したSVGにも同じ規則を写すので、
   目印として class の頭を g- で揃えてある（script の svgCss を参照） */
.g-node-circle { fill: var(--novelai-character); }
.g-node-circle.g-provisional {
  fill: var(--vscode-editor-background);
  stroke: var(--novelai-character);
  stroke-width: 1.5;
  stroke-dasharray: 3 3;
}
.g-node-circle.g-center { stroke: var(--vscode-focusBorder); stroke-width: 2.5; }
.g-node-label { fill: var(--vscode-foreground); font-size: 12px; }
.g-node-label.g-provisional { fill: var(--vscode-descriptionForeground); font-style: italic; }
.g-node-hit { fill: transparent; cursor: pointer; }
.g-node.g-found .g-node-circle { stroke: var(--vscode-charts-yellow, #d7ba7d); stroke-width: 3; }
.g-node.g-found .g-node-label { font-weight: 700; }
.g-edge { stroke: var(--vscode-foreground); opacity: 0.4; fill: none; }
.g-edge.g-provisional { stroke-dasharray: 5 4; opacity: 0.55; }
.g-edge.g-selected { stroke: var(--vscode-focusBorder); opacity: 1; }
.g-edge-hit { stroke: transparent; stroke-width: 12; fill: none; cursor: pointer; }
.g-edge-label { fill: var(--vscode-descriptionForeground); font-size: 11px; }
.g-arc { stroke: var(--novelai-organization); stroke-width: 6; fill: none; opacity: 0.75; }
.g-arc-label { fill: var(--novelai-organization); font-size: 12px; }
.g-ring { stroke: var(--vscode-panel-border); fill: none; stroke-dasharray: 2 4; }
</style>
</head>
<body>
<header>
  <h1 id="title">人物相関図</h1>
  <button id="toAll" title="作品全体の相関図に戻ります">全体図へ</button>
  <button id="back" title="ひとつ前に見ていた人物へ戻ります（マウスの戻るボタンでも同じ）">戻る</button>
  <button id="forward" title="「戻る」で戻ったぶんを進みます（マウスの進むボタンでも同じ）">進む</button>
  <button id="ring2" title="1次の相手のさらに先（2次）も薄く出します">2次も出す</button>
  <button id="openRecord" title="中心の人物の設定資料を開きます">設定資料を開く</button>
  <button id="export" title="いま見えている図をSVGファイルとして書き出します">SVGを書き出す</button>
  <button id="wide" title="左の絞り込みと右の詳細を畳んで、図を画面いっぱいに出します">図を広く</button>
</header>
<div id="layout">
  <aside id="filters">
    <div class="filter">
      <span class="filter-title">第N話までの相関図</span>
      <input type="range" id="upToChapter" min="1" max="1" value="1">
      <div class="sub" id="upToChapterValue"></div>
    </div>
    <div class="filter">
      <span class="filter-title">出す線</span>
      <label><input type="checkbox" id="kindRelation" checked> 関係（師匠・兄など）</label>
      <label><input type="checkbox" id="kindAddress" checked> 呼称（呼び方）</label>
    </div>
    <div class="filter">
      <span class="filter-title">所属</span>
      <div id="affiliations"></div>
    </div>
    <div class="filter">
      <span class="filter-title">名前で探す</span>
      <input type="search" id="search" placeholder="名前の一部">
      <div class="sub" id="searchNote"></div>
    </div>
    <div class="filter">
      <label><input type="checkbox" id="showIsolated"> 関係の無い人も出す</label>
      <div class="sub" id="isolatedNote"></div>
    </div>
  </aside>
  <main id="canvas">
    <div class="empty" id="empty"></div>
    <svg id="graph" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid meet"></svg>
    <div id="zoom">
      <button id="zoomOut" title="図を小さくします（Ctrl+－。Ctrl+ホイールを奥へ回しても同じ）">－</button>
      <span id="zoomValue" title="図の全体がちょうど収まる大きさを100%とした倍率です"></span>
      <button id="zoomIn" title="図を大きくします（Ctrl+＋。Ctrl+ホイールを手前へ回すと、マウスの位置を中心に大きくなります）">＋</button>
      <button id="zoomFit" title="図の全体が欄にちょうど収まる大きさへ戻します（Ctrl+0）">全体を合わせる</button>
    </div>
  </main>
  <aside id="side"></aside>
</div>
<footer id="notice"></footer>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const SVG_NS = "http://www.w3.org/2000/svg";

/** 拡張機能から届いた図。画面はこれを描くだけで、作り替えはしない */
let data = null;
/** 押されている辺。右側に詳細を出す */
let selectedEdge = null;
/** 所属の絞り込みを組み直すかの判断に使う（毎回作り直すと選択が飛ぶ） */
let renderedAffiliations = "";
/**
 * 脇（左の絞り込み・右の詳細）を畳んでいるか（設計書6.38.4）。
 *
 * 設定資料の隣に開くと横幅が半分しか無い。畳めば図がその分だけ広がる。
 * 開き直しても保つよう、WebViewの state に控える。
 */
let sidesHidden = false;
/** 畳んでいるあいだに線を押したので、右の詳細だけを仮に出している */
let sideTemporary = false;

/*
  拡大・縮小と移動（設計書6.38.2。作者の要望、2026-10-03）。
  見せる範囲は viewBox だけで決める。null は「まだ描いていない」。
*/
/** いま見せている範囲（図の座標） */
let viewBox = null;
/** 図の全体がちょうど収まる範囲。倍率はこれを1として数える */
let fitBox = null;
/** 図の全体（配置の枠と、実際に描いた名前のはみ出しを合わせたもの） */
let contentBox = null;
/** 欄の大きさ（画素）。マウスの位置を図の座標へ直すのに使う */
let canvasSize = { w: 0, h: 0 };
/**
 * 「全体を合わせる」に付いて行っているか。手で寄せたり動かしたり
 * するまでは、欄の大きさが変わるたびに合わせ直す
 */
let followFit = true;
/** どの図を見ているか。変わったときだけ「全体を合わせる」へ戻す */
let viewKey = "";

const el = {
  title: document.getElementById("title"),
  toAll: document.getElementById("toAll"),
  back: document.getElementById("back"),
  forward: document.getElementById("forward"),
  ring2: document.getElementById("ring2"),
  openRecord: document.getElementById("openRecord"),
  exportSvg: document.getElementById("export"),
  wide: document.getElementById("wide"),
  filters: document.getElementById("filters"),
  upToChapter: document.getElementById("upToChapter"),
  upToChapterValue: document.getElementById("upToChapterValue"),
  kindRelation: document.getElementById("kindRelation"),
  kindAddress: document.getElementById("kindAddress"),
  affiliations: document.getElementById("affiliations"),
  search: document.getElementById("search"),
  searchNote: document.getElementById("searchNote"),
  showIsolated: document.getElementById("showIsolated"),
  isolatedNote: document.getElementById("isolatedNote"),
  empty: document.getElementById("empty"),
  canvas: document.getElementById("canvas"),
  graph: document.getElementById("graph"),
  zoom: document.getElementById("zoom"),
  zoomIn: document.getElementById("zoomIn"),
  zoomOut: document.getElementById("zoomOut"),
  zoomFit: document.getElementById("zoomFit"),
  zoomValue: document.getElementById("zoomValue"),
  side: document.getElementById("side"),
  notice: document.getElementById("notice"),
};

function post(type, payload) {
  vscode.postMessage(Object.assign({ type: type }, payload || {}));
}

/** いま画面に出ている絞り込みを、そのまま拡張機能へ返す */
function sendFilter() {
  const kinds = [];
  if (el.kindRelation.checked) kinds.push("relation");
  if (el.kindAddress.checked) kinds.push("address");
  const affiliations = [];
  const boxes = el.affiliations.querySelectorAll("input[type=checkbox]");
  for (const box of boxes) {
    if (box.checked) affiliations.push(box.dataset.key);
  }
  post("filter", {
    filter: {
      upToChapter: Number(el.upToChapter.value),
      kinds: kinds,
      affiliations: affiliations,
      showIsolated: el.showIsolated.checked,
    },
  });
}

/** 畳んでいるかを画面へ反映する。詳細は、線を選んでいるあいだだけ仮に出す */
function applySides() {
  el.filters.hidden = sidesHidden;
  el.side.hidden = sidesHidden && !sideTemporary;
  el.wide.textContent = sidesHidden ? "絞り込みと詳細を出す" : "図を広く";
  el.wide.classList.toggle("on", sidesHidden);
}

el.wide.addEventListener("click", function () {
  sidesHidden = !sidesHidden;
  // 手で開き直したときは、仮出しの記憶を持ち越さない
  sideTemporary = false;
  vscode.setState({ sidesHidden: sidesHidden });
  applySides();
});

el.toAll.addEventListener("click", function () { post("all"); });
el.back.addEventListener("click", function () { post("back"); });
el.forward.addEventListener("click", function () { post("forward"); });

/*
  マウスの戻る・進むボタン（作者の依頼、2026-09-10）。

  WebView の中では VS Code 本体の割り当てが効かないので、この画面で受けて
  中心の履歴に結ぶ。画面のボタンと**同じ用件を送るだけ**——行き先を決めて
  いるのは拡張機能側で、押せるかどうかも向こうが返す（canGoBack /
  canGoForward）。

  **mouseup だけで扱う。** Chromium は同じ押下で auxclick も出すので、
  両方に付けると1回押しただけで2つぶん動く。
*/
document.addEventListener("mouseup", function (event) {
  if (event.button !== 3 && event.button !== 4) return;
  event.preventDefault();
  // 行き先が無いときは送らない（拡張機能側でも弾くが、往復を増やさない）
  const button = event.button === 3 ? el.back : el.forward;
  if (button.disabled) return;
  post(event.button === 3 ? "back" : "forward");
});
el.ring2.addEventListener("click", function () { post("toggleSecondRing"); });
el.openRecord.addEventListener("click", function () { post("openRecord"); });
el.exportSvg.addEventListener("click", function () { exportSvg(); });

// 動かしている最中は数字だけ直す。放したときに引き直す——
// つまみを動かすたびに図を作り直させると、拡張機能との往復が溢れる
el.upToChapter.addEventListener("input", function () {
  el.upToChapterValue.textContent = upToChapterText(Number(el.upToChapter.value));
});
el.upToChapter.addEventListener("change", sendFilter);
el.kindRelation.addEventListener("change", sendFilter);
el.kindAddress.addEventListener("change", sendFilter);
el.showIsolated.addEventListener("change", sendFilter);
// 探すのは画面の中だけで済む。拡張機能へ聞き直さない
el.search.addEventListener("input", function () { renderGraph(); });

function escapeText(value) {
  return String(value === null || value === undefined ? "" : value);
}

function nodeById(id) {
  if (!data) return null;
  for (const node of data.graph.nodes) {
    if (node.id === id) return node;
  }
  return null;
}

function nameOf(id) {
  const node = nodeById(id);
  return node ? node.name : id;
}

/** 辺の言葉を、向きごとに読める文へ直す */
function describeLabel(label) {
  const from = nameOf(label.from);
  const to = nameOf(label.to);
  if (label.kind === "address") {
    return from + " → " + to + "「" + label.text + "」と呼ぶ";
  }
  return from + " → " + to + "「" + label.text + "」";
}

/** 線に指を置いたときの説明。関係は1つずつ、呼び方は詳細と同じ対で */
function edgeTitle(edge) {
  const lines = [];
  for (const label of edge.labels) {
    if (label.kind === "relation") lines.push(describeLabel(label));
  }
  if (data.filter.kinds.indexOf("address") !== -1) {
    const rows = addressPairRows(
      edge, edge.a, nameOf(edge.a), nameOf(edge.b), limitedUpTo()
    );
    for (const row of rows) lines.push(row);
  }
  return lines.join("\\n");
}

function render() {
  if (!data) return;
  el.title.textContent = data.title;
  el.toAll.disabled = data.mode !== "ego";
  el.back.disabled = !data.canGoBack;
  el.forward.disabled = !data.canGoForward;
  el.ring2.disabled = data.mode !== "ego";
  el.ring2.classList.toggle("on", Boolean(data.showSecondRing));
  el.ring2.textContent = data.showSecondRing ? "2次を隠す" : "2次も出す";
  el.openRecord.disabled = !data.canOpenRecord;
  el.exportSvg.disabled = data.graph.nodes.length === 0;

  renderFilters();
  renderGraph();
  renderSide();

  const notes = [];
  if (data.unresolvedCount > 0) {
    notes.push(
      "資料に結べなかった相手 " + data.unresolvedCount + "人を点線で出しています" +
        "（抽出し直すと減ることがあります）。"
    );
  }
  // 「資料に無い」と「同じ名前が複数いる」は直し方が違う。
  // 抽出をやり直しても後者は減らないので、分けて出す
  if (data.ambiguousCount > 0) {
    notes.push(
      "うち " + data.ambiguousCount + "人は、同じ名前の人物が資料に複数いて" +
        "どちらか決められませんでした（別名の重なりを直すと結ばれます）。"
    );
  }
  if (data.hiddenIsolated.count > 0) {
    notes.push("関係の無い人 ほか " + data.hiddenIsolated.count + "人を畳んでいます。");
  }
  // 読めなかった資料があることは隠さない。0件の図を黙って出すと、
  // 関係が無いのか読めていないのかが作者に区別できない
  if (data.warning) notes.push(data.warning);
  el.notice.textContent = notes.join(" ");
  applySides();
}

/** つまみの数字の読み方。最終話なら、そう添える（既定で全部出ている印） */
function upToChapterText(chapter) {
  if (data && chapter >= data.lastChapter) return "第" + chapter + "話まで（最終話）";
  return "第" + chapter + "話まで";
}

function renderFilters() {
  const filter = data.filter;
  // 話数の記録が1つも無い作品では絞れない。消さずに押せなくして理由を出す
  el.upToChapter.disabled = data.lastChapter <= 0;
  el.upToChapter.max = String(Math.max(1, data.lastChapter));
  if (document.activeElement !== el.upToChapter) {
    el.upToChapter.value = String(Math.max(1, filter.upToChapter));
  }
  el.upToChapterValue.textContent =
    data.lastChapter <= 0
      ? "登場話数の記録が無いため、話数では絞れません"
      : upToChapterText(filter.upToChapter);
  el.kindRelation.checked = filter.kinds.indexOf("relation") !== -1;
  el.kindAddress.checked = filter.kinds.indexOf("address") !== -1;
  el.showIsolated.checked = Boolean(filter.showIsolated);
  el.isolatedNote.textContent =
    data.hiddenIsolated.count > 0
      ? "ほか " + data.hiddenIsolated.count + "人：" + data.hiddenIsolated.names.join("、")
      : "";

  // 所属の顔ぶれが変わったときだけ組み直す。毎回作り直すと、
  // チェックを入れた瞬間に押していた場所が消える
  const signature = JSON.stringify(data.affiliations.map(function (entry) {
    return [entry.key, entry.count];
  }));
  if (signature !== renderedAffiliations) {
    renderedAffiliations = signature;
    el.affiliations.replaceChildren();
    for (const entry of data.affiliations) {
      const label = document.createElement("label");
      const box = document.createElement("input");
      box.type = "checkbox";
      box.dataset.key = entry.key;
      box.checked = filter.affiliations.indexOf(entry.key) !== -1;
      box.addEventListener("change", sendFilter);
      label.appendChild(box);
      label.appendChild(
        document.createTextNode(" " + entry.label + "（" + entry.count + "）")
      );
      el.affiliations.appendChild(label);
    }
  } else {
    const boxes = el.affiliations.querySelectorAll("input[type=checkbox]");
    for (const box of boxes) {
      box.checked = filter.affiliations.indexOf(box.dataset.key) !== -1;
    }
  }
}

function svgNode(name, attributes) {
  const node = document.createElementNS(SVG_NS, name);
  for (const key of Object.keys(attributes || {})) {
    node.setAttribute(key, String(attributes[key]));
  }
  return node;
}

function withTitle(node, text) {
  const title = document.createElementNS(SVG_NS, "title");
  title.textContent = text;
  node.appendChild(title);
  return node;
}

/** 所属の弧。円のすこし外に帯を引く */
function arcPath(center, radius, start, end) {
  const x1 = center.x + radius * Math.cos(start);
  const y1 = center.y + radius * Math.sin(start);
  const x2 = center.x + radius * Math.cos(end);
  const y2 = center.y + radius * Math.sin(end);
  const large = end - start > Math.PI ? 1 : 0;
  return "M " + x1 + " " + y1 + " A " + radius + " " + radius +
    " 0 " + large + " 1 " + x2 + " " + y2;
}

function renderGraph() {
  if (!data) return;
  const layout = data.layout;
  const root = el.graph;
  root.replaceChildren();

  if (data.graph.nodes.length === 0) {
    el.empty.textContent = data.emptyMessage;
    el.empty.style.display = "block";
    root.style.display = "none";
    el.zoom.style.display = "none";
    return;
  }
  el.empty.style.display = "none";
  root.style.display = "block";
  el.zoom.style.display = "flex";
  // 中身は1つの束にまとめる。外周の名前がどこまではみ出したかを
  // この束の getBBox で測り、「全体を合わせる」に含めるため
  const svg = svgNode("g", { id: "scene" });
  root.appendChild(svg);

  const keyword = el.search.value.trim();
  let found = 0;

  // 環の目安。個人中心図でだけ引く（全体図では円周そのものが目安になる）
  if (data.mode === "ego") {
    for (const ring of layout.rings) {
      svg.appendChild(svgNode("circle", {
        class: "g-ring",
        cx: layout.center.x,
        cy: layout.center.y,
        r: ring,
      }));
    }
  }

  // 所属の弧と名前
  for (const arc of layout.arcs) {
    const radius = layout.radius + 26;
    svg.appendChild(svgNode("path", {
      class: "g-arc",
      d: arcPath(layout.center, radius, arc.start, arc.end),
    }));
    const middle = (arc.start + arc.end) / 2;
    const label = svgNode("text", {
      class: "g-arc-label",
      x: layout.center.x + (radius + 16) * Math.cos(middle),
      y: layout.center.y + (radius + 16) * Math.sin(middle),
      "text-anchor": "middle",
      "dominant-baseline": "middle",
    });
    label.textContent = arc.affiliation === null ? "所属なし" : arc.affiliation;
    svg.appendChild(label);
  }

  const placed = {};
  for (const node of layout.nodes) placed[node.id] = node;

  // 辺。太さは関係と呼称の本数
  for (const edge of data.graph.edges) {
    const from = placed[edge.a];
    const to = placed[edge.b];
    if (!from || !to) continue;
    const dashed = isProvisional(edge.a) || isProvisional(edge.b);
    const selected = selectedEdge &&
      selectedEdge.a === edge.a && selectedEdge.b === edge.b;
    const classes = ["g-edge"];
    if (dashed) classes.push("g-provisional");
    if (selected) classes.push("g-selected");
    svg.appendChild(svgNode("line", {
      class: classes.join(" "),
      x1: from.x, y1: from.y, x2: to.x, y2: to.y,
      "stroke-width": Math.min(1 + edge.weight, 7),
    }));

    // 押しやすいように、透明の太い線を重ねる。細い線は狙えない
    const hit = svgNode("line", {
      class: "g-edge-hit",
      x1: from.x, y1: from.y, x2: to.x, y2: to.y,
    });
    withTitle(hit, edgeTitle(edge));
    hit.addEventListener("click", function () {
      selectedEdge = { a: edge.a, b: edge.b };
      // 畳んでいても、押したからには中身が見たいはず。閉じれば元の広さへ戻る
      if (sidesHidden) {
        sideTemporary = true;
        applySides();
      }
      renderGraph();
      renderSide();
    });
    svg.appendChild(hit);
  }

  // 辺のラベル。全体図では線が混むので、個人中心図でだけ文字にする
  if (data.mode === "ego") {
    for (const position of layout.edges) {
      const edge = findEdge(position.a, position.b);
      if (!edge) continue;
      const label = svgNode("text", {
        class: "g-edge-label",
        x: position.x,
        y: position.y,
        "text-anchor": "middle",
        "dominant-baseline": "middle",
      });
      label.textContent = pairLabel(edge, orientFrom(edge));
      svg.appendChild(label);
    }
  }

  // ノード
  for (const position of layout.nodes) {
    const node = nodeById(position.id);
    if (!node) continue;
    const group = svgNode("g", { class: "g-node" });
    if (keyword && node.name.indexOf(keyword) !== -1) {
      group.setAttribute("class", "g-node g-found");
      found++;
    }

    const circleClasses = ["g-node-circle"];
    if (node.provisional) circleClasses.push("g-provisional");
    if (data.mode === "ego" && node.id === data.centerId) {
      circleClasses.push("g-center");
    }
    group.appendChild(svgNode("circle", {
      class: circleClasses.join(" "),
      cx: position.x, cy: position.y, r: position.r,
    }));

    const isCenter = data.mode === "ego" && node.id === data.centerId;
    const right = position.x >= layout.center.x;
    const labelClasses = ["g-node-label"];
    if (node.provisional) labelClasses.push("g-provisional");
    const label = svgNode("text", {
      class: labelClasses.join(" "),
      x: isCenter ? position.x : position.x + (right ? position.r + 6 : -position.r - 6),
      y: isCenter ? position.y + position.r + 16 : position.y,
      "text-anchor": isCenter ? "middle" : (right ? "start" : "end"),
      "dominant-baseline": "middle",
    });
    label.textContent = node.name;
    group.appendChild(label);

    // 円だけでは小さくて押せない。透明の輪を重ねる
    const hit = svgNode("circle", {
      class: "g-node-hit",
      cx: position.x, cy: position.y, r: Math.max(position.r + 8, 14),
    });
    withTitle(hit, nodeTitle(node));
    hit.addEventListener("click", function () {
      post("center", { id: node.id });
    });
    group.appendChild(hit);
    svg.appendChild(group);
  }

  el.searchNote.textContent = keyword
    ? (found > 0 ? found + "人が当たりました" : "当たる人が居ません")
    : "";

  // 描き直しても見ている範囲は変えない（名前で探すたびに全体へ戻ると、
  // 寄せて探していた所を見失う）。戻すのは図そのものが変わったときだけ
  contentBox = measureContent();
  if (viewBox === null || followFit) {
    fitToCanvas();
  } else {
    canvasSize = measureCanvas();
    fitBox = fitViewBox(contentBox, canvasSize, FIT_MARGIN);
    applyViewBox();
  }
}

function isProvisional(id) {
  const node = nodeById(id);
  return Boolean(node && node.provisional);
}

function findEdge(a, b) {
  for (const edge of data.graph.edges) {
    if (edge.a === a && edge.b === b) return edge;
  }
  return null;
}

/*
  ── 呼び合い（作者の要望、2026-10-03「人物相関図の説明に呼び合いも必要です」）──
  2人が互いを何と呼ぶかを、片方ずつではなく対で見せる。片方しか記録が
  無いときは「記録なし」と書く——1行だけ出すと、もう片方が抜けているのか
  見落としなのかが読めない。
  届いた辺は、第N話までの絞り込みを拡張機能側で済ませてある（呼び方は
  firstChapter が第N話までのものだけ）。ここは並べ方を決めるだけ。
  test/unit/views/relationGraphPanelHtml.test.ts がこの区切りを切り出して呼ぶ。
*/
/* pairs:start */
/** fromId から toId へ向かう言葉を、関係と呼び方に分けて集める */
function wordsFrom(edge, fromId, kind) {
  const out = [];
  for (const label of edge.labels) {
    if (label.kind === kind && label.from === fromId) out.push(label.text);
  }
  return out;
}

function otherEnd(edge, id) {
  return edge.a === id ? edge.b : edge.a;
}

/**
 * 呼び合いの2行。先に fromId から、次に相手から。
 * upTo は「第N話まで」に絞っているときの N（絞っていなければ null）。
 * どちらにも無ければ1行で済ませる（2行とも「記録なし」は読みにくい）
 */
function addressPairRows(edge, fromId, fromName, toName, upTo) {
  const toId = otherEnd(edge, fromId);
  const forward = wordsFrom(edge, fromId, "address");
  const backward = wordsFrom(edge, toId, "address");
  if (forward.length === 0 && backward.length === 0) {
    return [upTo === null
      ? "どちらからの呼び方も記録なし"
      : "どちらからの呼び方も第" + upTo + "話までに記録なし"];
  }
  function row(speaker, listener, words) {
    if (words.length === 0) {
      return upTo === null
        ? "（" + speaker + "からの呼び方は記録なし）"
        : "（" + speaker + "からの呼び方は第" + upTo + "話までに記録なし）";
    }
    return speaker + "は" + listener + "を" +
      words.map(function (word) { return "『" + word + "』"; }).join("") + "と呼ぶ";
  }
  return [row(fromName, toName, forward), row(toName, fromName, backward)];
}

/**
 * 線の上と「つながっている人」に置く短いラベル。fromId から見て
 * →（fromId から相手へ）／←（相手から fromId へ）の対にする。
 * 関係はそのまま、呼び方は『』で囲む
 */
function pairLabel(edge, fromId) {
  const toId = otherEnd(edge, fromId);
  function half(id) {
    const relations = wordsFrom(edge, id, "relation");
    const addresses = wordsFrom(edge, id, "address");
    return relations.join("・") +
      addresses.map(function (word) { return "『" + word + "』"; }).join("");
  }
  const forward = half(fromId);
  const backward = half(toId);
  return "→" + (forward || "（記録なし）") + "／←" + (backward || "（記録なし）");
}
/* pairs:end */

/**
 * 線のラベルをどちらから見るか。個人中心図では中心の人から（→は
 * 「中心の人から相手へ」と読める）。中心に触れない2次の線は、辺の a から
 */
function orientFrom(edge) {
  if (data.mode === "ego" && (edge.a === data.centerId || edge.b === data.centerId)) {
    return data.centerId;
  }
  return edge.a;
}

/** 第N話までに絞っているときの N。最終話までなら null */
function limitedUpTo() {
  if (!data || data.lastChapter <= 0) return null;
  const upTo = data.filter.upToChapter;
  return upTo < data.lastChapter ? upTo : null;
}

function nodeTitle(node) {
  const lines = [node.name];
  if (node.affiliation) lines.push("所属：" + node.affiliation);
  if (node.provisional) {
    // 結べない理由は2通りある（資料に居ない／同じ名前が複数いる）。
    // 片方だけを書くと、居る人を「居ません」と言い切ることになる
    lines.push(
      "資料の人物に結べませんでした（名前が当たらないか、同じ名前が複数あります）"
    );
  } else {
    lines.push("登場話数：" + node.chapterCount);
  }
  return lines.join("\\n");
}

function heading(text) {
  const node = document.createElement("h3");
  node.textContent = text;
  return node;
}

function renderSide() {
  el.side.replaceChildren();
  if (!data) return;

  if (selectedEdge) {
    const edge = findEdge(selectedEdge.a, selectedEdge.b);
    if (edge) {
      const title = document.createElement("h2");
      title.textContent = nameOf(edge.a) + " と " + nameOf(edge.b);
      el.side.appendChild(title);
      appendLabels(edge, "relation", "関係");
      // 呼称を出さない絞り込みのときは、呼び合いの見出しごと出さない
      // （呼称が無いのではなく、見せていないだけなので「記録なし」と書けない）
      if (data.filter.kinds.indexOf("address") !== -1) {
        el.side.appendChild(heading("呼び合い"));
        const rows = addressPairRows(
          edge, edge.a, nameOf(edge.a), nameOf(edge.b), limitedUpTo()
        );
        for (const text of rows) el.side.appendChild(sideRow(text));
      }
      const close = document.createElement("button");
      close.textContent = "選択を外す";
      close.addEventListener("click", function () {
        selectedEdge = null;
        sideTemporary = false;
        applySides();
        renderGraph();
        renderSide();
      });
      el.side.appendChild(close);
      return;
    }
    selectedEdge = null;
  }

  if (data.mode === "ego" && data.centerId) {
    const center = nodeById(data.centerId);
    const title = document.createElement("h2");
    title.textContent = center ? center.name : data.centerName;
    el.side.appendChild(title);
    if (center && center.affiliation) {
      el.side.appendChild(sideRow("所属：" + center.affiliation));
    }
    if (center && !center.provisional) {
      el.side.appendChild(sideRow("登場話数：" + center.chapterCount));
    }
    el.side.appendChild(heading("つながっている人"));
    const centerName = center ? center.name : data.centerName;
    el.side.appendChild(sideRow(
      "→は" + centerName + "から相手へ、←は相手から" + centerName + "へ。『』は呼び方です。"
    ));
    const neighbours = neighboursOf(data.centerId);
    if (neighbours.length === 0) {
      el.side.appendChild(sideRow("関係も呼称も見つかりません。"));
    }
    for (const entry of neighbours) {
      const row = document.createElement("div");
      row.className = "side-row";
      const link = document.createElement("button");
      link.className = "person-link";
      link.textContent = nameOf(entry.id);
      link.addEventListener("click", function () {
        post("center", { id: entry.id });
      });
      row.appendChild(link);
      row.appendChild(document.createTextNode(" " + pairLabel(entry.edge, data.centerId)));
      el.side.appendChild(row);
    }
    return;
  }

  const title = document.createElement("h2");
  title.textContent = "この図について";
  el.side.appendChild(title);
  el.side.appendChild(sideRow("人物 " + data.graph.nodes.length + "人"));
  el.side.appendChild(sideRow("つながり " + data.graph.edges.length + "本"));
  el.side.appendChild(
    sideRow("線を押すと、2人の関係と呼び合いが出ます。人物を押すと、その人を中心にした図に変わります。")
  );
  el.side.appendChild(heading("呼び合いの見方"));
  el.side.appendChild(
    sideRow(
      "2人が互いを何と呼ぶかを「AはBを『〇〇』と呼ぶ／BはAを『△△』と呼ぶ」の対で並べます。" +
        "片方しか記録が無いときは「（Bからの呼び方は記録なし）」と出します。"
    )
  );
  el.side.appendChild(
    sideRow(
      "第N話までに絞っているときは、その話までに使い始めた呼び方だけを出します。" +
        "人物を押した図では、線の上に「→中心の人から相手へ／←相手から中心の人へ」の順で書きます。"
    )
  );
}

function sideRow(text) {
  const row = document.createElement("div");
  row.className = "side-row";
  row.textContent = escapeText(text);
  return row;
}

function appendLabels(edge, kind, caption) {
  const labels = edge.labels.filter(function (label) { return label.kind === kind; });
  if (labels.length === 0) return;
  el.side.appendChild(heading(caption));
  for (const label of labels) {
    el.side.appendChild(sideRow(describeLabel(label)));
  }
}

function neighboursOf(id) {
  const out = [];
  for (const edge of data.graph.edges) {
    if (edge.a === id) out.push({ id: edge.b, edge: edge });
    else if (edge.b === id) out.push({ id: edge.a, edge: edge });
  }
  return out;
}

/*
  ── 拡大・縮小と移動の計算 ──────────────────────────────
  core/relationGraphViewport.ts の写し（このスクリプトは TypeScript を
  読めない）。離れていないことは test/unit/cross/relationGraphViewportCopy.test.ts
  が同じ入力で比べて見張る。直すときは core と両方を直す。
*/
/* viewport:start */
const ZOOM_LIMITS = ${JSON.stringify(ZOOM_LIMITS)};
const WHEEL_SENSITIVITY = 0.002;
const WHEEL_LINE_PX = 40;
const WHEEL_PAGE_PX = 800;

function fitViewBox(content, canvas, margin) {
  const w = content.w + margin * 2;
  const h = content.h + margin * 2;
  if (!(canvas.w > 0) || !(canvas.h > 0)) {
    return { x: content.x - margin, y: content.y - margin, w: w, h: h };
  }
  const unit = Math.max(w / canvas.w, h / canvas.h);
  const vw = canvas.w * unit;
  const vh = canvas.h * unit;
  return {
    x: content.x - margin - (vw - w) / 2,
    y: content.y - margin - (vh - h) / 2,
    w: vw,
    h: vh,
  };
}

function zoomOf(vb, fit) {
  if (!(vb.w > 0)) return 1;
  return fit.w / vb.w;
}

function zoomViewBoxAt(vb, factor, pointer, canvas, fit) {
  if (!(canvas.w > 0) || !(canvas.h > 0) || !(factor > 0)) return vb;
  const current = zoomOf(vb, fit);
  const target = Math.min(ZOOM_LIMITS.max, Math.max(ZOOM_LIMITS.min, current * factor));
  if (Math.abs(target - current) < 1e-9) return vb;
  const w = fit.w / target;
  const h = (w * canvas.h) / canvas.w;
  const gx = vb.x + (pointer.x * vb.w) / canvas.w;
  const gy = vb.y + (pointer.y * vb.h) / canvas.h;
  return {
    x: gx - (pointer.x * w) / canvas.w,
    y: gy - (pointer.y * h) / canvas.h,
    w: w,
    h: h,
  };
}

function wheelZoomFactor(deltaY, deltaMode) {
  const unit = deltaMode === 1 ? WHEEL_LINE_PX : deltaMode === 2 ? WHEEL_PAGE_PX : 1;
  const delta = (Number(deltaY) || 0) * unit;
  if (delta === 0) return 1;
  return Math.exp(-delta * WHEEL_SENSITIVITY);
}

function clampViewBoxToContent(vb, content) {
  const cx = vb.x + vb.w / 2;
  const cy = vb.y + vb.h / 2;
  const nx = Math.min(content.x + content.w, Math.max(content.x, cx));
  const ny = Math.min(content.y + content.h, Math.max(content.y, cy));
  if (nx === cx && ny === cy) return vb;
  return { x: nx - vb.w / 2, y: ny - vb.h / 2, w: vb.w, h: vb.h };
}

function panViewBox(vb, dx, dy, canvas, content) {
  if (!(canvas.w > 0) || !(canvas.h > 0)) return vb;
  return clampViewBoxToContent(
    {
      x: vb.x - (dx * vb.w) / canvas.w,
      y: vb.y - (dy * vb.h) / canvas.h,
      w: vb.w,
      h: vb.h,
    },
    content
  );
}

function resizeViewBox(vb, before, after) {
  if (!(before.w > 0) || !(after.w > 0) || !(after.h > 0)) return vb;
  const unit = vb.w / before.w;
  const w = after.w * unit;
  const h = after.h * unit;
  const cx = vb.x + vb.w / 2;
  const cy = vb.y + vb.h / 2;
  return { x: cx - w / 2, y: cy - h / 2, w: w, h: h };
}
/* viewport:end */

/** 外周の名前が縁に貼り付かないための余白（図の単位） */
const FIT_MARGIN = 12;
/** ボタンとキーで1回に変える倍率 */
const ZOOM_STEP = 1.25;
/** これより動いたら「引いた」とみなし、点や線を押したことにしない（画素） */
const DRAG_THRESHOLD = 4;

/** 欄の大きさ。背面のタブでは0になる（そのときは計算を進めない） */
function measureCanvas() {
  const rect = el.canvas.getBoundingClientRect();
  return { w: rect.width, h: rect.height };
}

/**
 * 図の全体。配置の枠（拡張機能が決めた幅と高さ）に、実際に描いた中身の
 * 外接の四角を合わせる——長い名前は枠の外へはみ出すことがあり、枠だけに
 * 合わせると右端の名前が切れる（作者の画面で起きていたこと）
 */
function measureContent() {
  const layout = data.layout;
  let x1 = 0;
  let y1 = 0;
  let x2 = layout.width;
  let y2 = layout.height;
  const scene = document.getElementById("scene");
  if (scene) {
    try {
      const box = scene.getBBox();
      if (box.width > 0 && box.height > 0) {
        x1 = Math.min(x1, box.x);
        y1 = Math.min(y1, box.y);
        x2 = Math.max(x2, box.x + box.width);
        y2 = Math.max(y2, box.y + box.height);
      }
    } catch (error) {
      // 描く前で測れないときは、配置の枠だけで合わせる
    }
  }
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

function applyViewBox() {
  if (viewBox === null || fitBox === null) return;
  el.graph.setAttribute(
    "viewBox",
    viewBox.x + " " + viewBox.y + " " + viewBox.w + " " + viewBox.h
  );
  el.zoomValue.textContent = Math.round(zoomOf(viewBox, fitBox) * 100) + "%";
  const zoom = zoomOf(viewBox, fitBox);
  el.zoomIn.disabled = zoom >= ZOOM_LIMITS.max - 1e-6;
  el.zoomOut.disabled = zoom <= ZOOM_LIMITS.min + 1e-6;
}

/** 「全体を合わせる」。欄の大きさに図がちょうど収まる倍率へ */
function fitToCanvas() {
  if (!data || contentBox === null) return;
  canvasSize = measureCanvas();
  fitBox = fitViewBox(contentBox, canvasSize, FIT_MARGIN);
  viewBox = fitBox;
  followFit = true;
  applyViewBox();
}

/** 欄の中の点（画素）を中心に、倍率を factor 倍する */
function zoomBy(factor, pointer) {
  if (viewBox === null || fitBox === null) return;
  const next = zoomViewBoxAt(viewBox, factor, pointer, canvasSize, fitBox);
  viewBox = clampViewBoxToContent(next, contentBox);
  followFit = false;
  applyViewBox();
}

function zoomAtCenter(factor) {
  zoomBy(factor, { x: canvasSize.w / 2, y: canvasSize.h / 2 });
}

function graphShown() {
  return Boolean(data) && data.graph.nodes.length > 0 && viewBox !== null;
}

el.zoomIn.addEventListener("click", function () { zoomAtCenter(ZOOM_STEP); });
el.zoomOut.addEventListener("click", function () { zoomAtCenter(1 / ZOOM_STEP); });
el.zoomFit.addEventListener("click", function () { fitToCanvas(); });

/*
  ホイール。
  - Ctrl（Mac は Cmd）＋ホイール：マウスの位置を中心に拡大・縮小。
    トラックパッドのピンチも、Chromium では Ctrl 付きの wheel で届くので
    ここで一緒に効く。既定を止めないと VS Code 全体の拡大へ渡る
  - 素のホイール：図を動かす（縦。Shift を押すと横。トラックパッドの
    2本指は縦横そのまま）。欄にはもうスクロールが無いので、回しても
    何も起きないより、地図と同じく図が動くほうが迷わない
  受け身（passive）扱いだと既定を止められないので明示する。
*/
el.canvas.addEventListener(
  "wheel",
  function (event) {
    if (!graphShown()) return;
    event.preventDefault();
    const rect = el.canvas.getBoundingClientRect();
    if (event.ctrlKey || event.metaKey) {
      zoomBy(wheelZoomFactor(event.deltaY, event.deltaMode), {
        x: event.clientX - rect.left,
        y: event.clientY - rect.top,
      });
      return;
    }
    const unit = event.deltaMode === 1 ? WHEEL_LINE_PX : event.deltaMode === 2 ? WHEEL_PAGE_PX : 1;
    let dx = (Number(event.deltaX) || 0) * unit;
    let dy = (Number(event.deltaY) || 0) * unit;
    if (event.shiftKey && dx === 0) {
      dx = dy;
      dy = 0;
    }
    // 下へ回すと、ページを下へ送るのと同じく図は上へ動く
    viewBox = panViewBox(viewBox, -dx, -dy, canvasSize, contentBox);
    followFit = false;
    applyViewBox();
  },
  { passive: false }
);

/*
  ドラッグで図を動かす。
  点や線を押す操作を壊さないよう、少し（DRAG_THRESHOLD）動くまでは何も
  しない。動いたら「引いた」とし、離したあとに来る click を握りつぶす
  ——動かしただけで中心の人物が替わると、寄せた所から別の図へ飛ばされる。
  マウスの戻る・進むボタン（3・4）は既存の mouseup が受けるので、左ボタン
  だけを見る。
*/
let drag = null;
let dragMoved = false;

el.graph.addEventListener("pointerdown", function (event) {
  dragMoved = false;
  if (event.button !== 0 || !graphShown()) return;
  drag = {
    id: event.pointerId,
    x: event.clientX,
    y: event.clientY,
    start: viewBox,
    moving: false,
  };
});

el.graph.addEventListener("pointermove", function (event) {
  if (drag === null || event.pointerId !== drag.id) return;
  const dx = event.clientX - drag.x;
  const dy = event.clientY - drag.y;
  if (!drag.moving) {
    if (Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return;
    drag.moving = true;
    // 引き始めてから捕まえる。押した直後に捕まえると、ただのクリックも
    // 図そのもの宛てになり、点や線の click が届かなくなる
    try {
      el.graph.setPointerCapture(event.pointerId);
    } catch (error) {
      // 捕まえられなくても、欄の中で動かすぶんには困らない
    }
    el.graph.classList.add("dragging");
  }
  viewBox = panViewBox(drag.start, dx, dy, canvasSize, contentBox);
  followFit = false;
  applyViewBox();
});

function endDrag(event) {
  if (drag === null || event.pointerId !== drag.id) return;
  if (drag.moving) dragMoved = true;
  drag = null;
  el.graph.classList.remove("dragging");
}
el.graph.addEventListener("pointerup", endDrag);
el.graph.addEventListener("pointercancel", endDrag);

// 引いたあとの click は、点にも線にも届かせない（捕獲の段で止める）
el.graph.addEventListener(
  "click",
  function (event) {
    if (!dragMoved) return;
    dragMoved = false;
    event.stopPropagation();
    event.preventDefault();
  },
  true
);

/*
  キー。原稿エディターの字の大きさ（Ctrl+＋／－／0）と同じ形にする。
  日本語の配列では「＋」が「;」の Shift 側にあるので、; = + を「大きく」。
  名前で探す欄やつまみで打っているあいだは、そちらに任せる
*/
document.addEventListener(
  "keydown",
  function (event) {
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
    if (!graphShown()) return;
    const target = event.target;
    if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
    const key = event.key;
    const code = event.code;
    if (key === "+" || key === "=" || key === ";" || code === "NumpadAdd") {
      event.preventDefault();
      event.stopPropagation();
      zoomAtCenter(ZOOM_STEP);
      return;
    }
    if (key === "-" || key === "_" || code === "NumpadSubtract") {
      event.preventDefault();
      event.stopPropagation();
      zoomAtCenter(1 / ZOOM_STEP);
      return;
    }
    if (!event.shiftKey && (key === "0" || code === "Numpad0")) {
      event.preventDefault();
      event.stopPropagation();
      fitToCanvas();
    }
  },
  true
);

/*
  欄の大きさが変わったとき（窓の大きさ・「図を広く」・脇の詳細の仮出し）。
  全体を合わせているあいだは合わせ直し、手で寄せているあいだは寄せ具合と
  見ている真ん中を保つ。
*/
if (typeof ResizeObserver === "function") {
  new ResizeObserver(function () {
    if (!graphShown()) return;
    const next = measureCanvas();
    if (!(next.w > 0) || !(next.h > 0)) return;
    if (followFit) {
      fitToCanvas();
      return;
    }
    viewBox = resizeViewBox(viewBox, canvasSize, next);
    canvasSize = next;
    fitBox = fitViewBox(contentBox, canvasSize, FIT_MARGIN);
    applyViewBox();
  }).observe(el.canvas);
}

/**
 * どの図を見ているかの鍵。同じ図が届き直しただけ（資料の保存で引き直した
 * とき）なら、寄せていた所を保つ。全体図か個人中心図か・中心の人・
 * 絞り込み・2次の有無のどれかが変われば、別の図として「全体を合わせる」へ
 */
function viewKeyOf(next) {
  return JSON.stringify([
    next.mode,
    next.mode === "ego" ? next.centerId : null,
    next.filter,
    Boolean(next.showSecondRing),
  ]);
}

/**
 * 図の見た目の規則を集める。
 *
 * 書き出したSVGはこのページの外で開かれるので、規則を持って行かないと
 * 色も太さも失われる。写しを作らずに済むよう、いま効いている規則から
 * 集める（class の頭が g- のものが図の規則）。
 */
function svgCss() {
  const out = [];
  for (const sheet of document.styleSheets) {
    let rules = null;
    try {
      rules = sheet.cssRules;
    } catch (error) {
      continue;
    }
    if (!rules) continue;
    for (const rule of rules) {
      if (rule.selectorText && rule.selectorText.indexOf(".g-") !== -1) {
        out.push(rule.cssText);
      }
    }
  }
  return out.join("\\n");
}

/**
 * いま見えている図をSVGの文字列にして、拡張機能へ渡す。
 *
 * 色はVS Codeのテーマ変数で書いてあるので、そのまま出すと外では
 * 何色にもならない。書き出すときだけ、いまの値に置き換えて埋め込む。
 */
function exportSvg() {
  const clone = el.graph.cloneNode(true);
  const computed = getComputedStyle(document.body);
  const names = [
    "--novelai-character",
    "--novelai-organization",
    "--vscode-foreground",
    "--vscode-descriptionForeground",
    "--vscode-panel-border",
    "--vscode-editor-background",
    "--vscode-focusBorder",
    "--vscode-charts-yellow",
  ];
  const variables = [];
  for (const name of names) {
    const value = computed.getPropertyValue(name).trim();
    if (value) variables.push(name + ": " + value + ";");
  }
  const style = document.createElementNS(SVG_NS, "style");
  style.textContent = "svg { " + variables.join(" ") +
    " background: var(--vscode-editor-background); }\\n" + svgCss();
  clone.insertBefore(style, clone.firstChild);
  clone.setAttribute("xmlns", SVG_NS);
  // 拡大して見ていても、書き出すのは図の全体（いま見えている切り抜きではない）。
  // 画面では欄いっぱいに広げているので、外で開いたときの大きさも付け直す
  const whole = contentBox !== null ? contentBox : {
    x: 0, y: 0, w: data.layout.width, h: data.layout.height,
  };
  const full = fitViewBox(whole, { w: 0, h: 0 }, FIT_MARGIN);
  clone.setAttribute("viewBox", full.x + " " + full.y + " " + full.w + " " + full.h);
  clone.setAttribute("width", String(Math.ceil(full.w)));
  clone.setAttribute("height", String(Math.ceil(full.h)));
  clone.removeAttribute("class");
  clone.removeAttribute("style");
  post("export", { svg: new XMLSerializer().serializeToString(clone) });
}

window.addEventListener("message", function (event) {
  const message = event.data;
  if (!message) return;
  if (message.type === "graph") {
    // 中心や絞り込みが変わると、選んでいた線は図に無いことがある
    data = message.data;
    // 別の図になったら「全体を合わせる」から（開いたとき・絞り込みを
    // 変えたとき・中心を替えたとき）。描き終えてから測るので、ここでは印だけ
    const key = viewKeyOf(data);
    if (key !== viewKey) {
      viewKey = key;
      followFit = true;
    }
    if (selectedEdge && !findEdge(selectedEdge.a, selectedEdge.b)) {
      selectedEdge = null;
      sideTemporary = false;
    }
    render();
  }
});

// 前回の畳み方を戻す。図の中身は拡張機能から届くが、脇の畳み方は画面側の好み
const savedState = vscode.getState();
if (savedState && savedState.sidesHidden === true) sidesHidden = true;
applySides();

// HTMLを流し込んだ直後は受け手がまだ居ない。準備ができたと伝えてから送ってもらう
post("ready");
</script>
</body>
</html>`;
}
