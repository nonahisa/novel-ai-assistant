import { TERM_COLORS } from "../core/termColors";

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
 * 図だけが古い色のまま残る（`test/unit/termColors.test.ts` が見張る）。
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
#canvas { flex: 1; min-width: 0; overflow: auto; padding: 8px; }
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
svg { display: block; width: 100%; height: auto; }
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
  <button id="back" title="ひとつ前に見ていた人物へ戻ります">戻る</button>
  <button id="ring2" title="1次の相手のさらに先（2次）も薄く出します">2次も出す</button>
  <button id="openRecord" title="中心の人物の設定資料を開きます">設定資料を開く</button>
  <button id="export" title="いま見えている図をSVGファイルとして書き出します">SVGを書き出す</button>
</header>
<div id="layout">
  <aside id="filters">
    <div class="filter">
      <span class="filter-title">登場話数の下限</span>
      <input type="range" id="minChapters" min="0" max="0" value="0">
      <div class="sub" id="minChaptersValue"></div>
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
    <svg id="graph" xmlns="http://www.w3.org/2000/svg"></svg>
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

const el = {
  title: document.getElementById("title"),
  toAll: document.getElementById("toAll"),
  back: document.getElementById("back"),
  ring2: document.getElementById("ring2"),
  openRecord: document.getElementById("openRecord"),
  exportSvg: document.getElementById("export"),
  minChapters: document.getElementById("minChapters"),
  minChaptersValue: document.getElementById("minChaptersValue"),
  kindRelation: document.getElementById("kindRelation"),
  kindAddress: document.getElementById("kindAddress"),
  affiliations: document.getElementById("affiliations"),
  search: document.getElementById("search"),
  searchNote: document.getElementById("searchNote"),
  showIsolated: document.getElementById("showIsolated"),
  isolatedNote: document.getElementById("isolatedNote"),
  empty: document.getElementById("empty"),
  graph: document.getElementById("graph"),
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
      minChapters: Number(el.minChapters.value),
      kinds: kinds,
      affiliations: affiliations,
      showIsolated: el.showIsolated.checked,
    },
  });
}

el.toAll.addEventListener("click", function () { post("all"); });
el.back.addEventListener("click", function () { post("back"); });
el.ring2.addEventListener("click", function () { post("toggleSecondRing"); });
el.openRecord.addEventListener("click", function () { post("openRecord"); });
el.exportSvg.addEventListener("click", function () { exportSvg(); });

// 動かしている最中は数字だけ直す。放したときに引き直す——
// つまみを動かすたびに図を作り直させると、拡張機能との往復が溢れる
el.minChapters.addEventListener("input", function () {
  el.minChaptersValue.textContent = el.minChapters.value + "話以上を出す";
});
el.minChapters.addEventListener("change", sendFilter);
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

function edgeTitle(edge) {
  const lines = [];
  for (const label of edge.labels) lines.push(describeLabel(label));
  return lines.join("\\n");
}

function render() {
  if (!data) return;
  el.title.textContent = data.title;
  el.toAll.disabled = data.mode !== "ego";
  el.back.disabled = !data.canGoBack;
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
      "資料に無い相手 " + data.unresolvedCount + "人を点線で出しています" +
        "（抽出し直すと減ることがあります）。"
    );
  }
  if (data.hiddenIsolated.count > 0) {
    notes.push("関係の無い人 ほか " + data.hiddenIsolated.count + "人を畳んでいます。");
  }
  // 読めなかった資料があることは隠さない。0件の図を黙って出すと、
  // 関係が無いのか読めていないのかが作者に区別できない
  if (data.warning) notes.push(data.warning);
  el.notice.textContent = notes.join(" ");
}

function renderFilters() {
  const filter = data.filter;
  el.minChapters.max = String(Math.max(1, data.maxChapters));
  if (document.activeElement !== el.minChapters) {
    el.minChapters.value = String(filter.minChapters);
  }
  el.minChaptersValue.textContent = filter.minChapters + "話以上を出す";
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
  const svg = el.graph;
  svg.replaceChildren();

  if (data.graph.nodes.length === 0) {
    el.empty.textContent = data.emptyMessage;
    el.empty.style.display = "block";
    svg.style.display = "none";
    return;
  }
  el.empty.style.display = "none";
  svg.style.display = "block";
  svg.setAttribute("viewBox", "0 0 " + layout.width + " " + layout.height);
  svg.setAttribute("width", String(layout.width));
  svg.setAttribute("height", String(layout.height));

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
      label.textContent = shortLabel(edge);
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

/** 線の上に置く短いラベル。両方向を、向きの矢印で分けて出す */
function shortLabel(edge) {
  const parts = [];
  for (const label of edge.labels) {
    const arrow = label.from === edge.a ? "→" : "←";
    parts.push(arrow + label.text);
  }
  return parts.join(" ");
}

function nodeTitle(node) {
  const lines = [node.name];
  if (node.affiliation) lines.push("所属：" + node.affiliation);
  if (node.provisional) {
    lines.push("資料に無い相手です（名前でも別名でも当たりませんでした）");
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
      appendLabels(edge, "address", "呼び方");
      const close = document.createElement("button");
      close.textContent = "選択を外す";
      close.addEventListener("click", function () {
        selectedEdge = null;
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
      row.appendChild(document.createTextNode(" " + shortLabel(entry.edge)));
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
    sideRow("線を押すと、関係と呼び方の一覧が出ます。人物を押すと、その人を中心にした図に変わります。")
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
  post("export", { svg: new XMLSerializer().serializeToString(clone) });
}

window.addEventListener("message", function (event) {
  const message = event.data;
  if (!message) return;
  if (message.type === "graph") {
    // 中心や絞り込みが変わると、選んでいた線は図に無いことがある
    data = message.data;
    if (selectedEdge && !findEdge(selectedEdge.a, selectedEdge.b)) {
      selectedEdge = null;
    }
    render();
    return;
  }
  if (message.type === "notice") {
    el.notice.textContent = message.text;
  }
});

// HTMLを流し込んだ直後は受け手がまだ居ない。準備ができたと伝えてから送ってもらう
post("ready");
</script>
</body>
</html>`;
}
