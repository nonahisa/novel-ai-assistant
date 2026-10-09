import { TERM_COLORS } from "../core/termColors";

/**
 * 場所の略図の画面（設計書6.93.10）。
 *
 * 人物相関図（`relationGraphPanelHtml.ts`）と同じく、外部ライブラリを使わず
 * 自前の SVG で描く。値はすべて postMessage で受け取り、HTML へ文字列として
 * 埋め込まない（場所の名前の引用符で画面が壊れるのを防ぐ）。文字は
 * textContent で入れる。
 *
 * **計算はしない。** 置き方は拡張機能側（`core/locationSketch.ts`）で済ませて
 * ある。ここで変えるのは、作者が点を引っ張っている間の見た目だけで、
 * 離したら位置を拡張機能へ返して保存してもらう。
 *
 * 見た目は決まった位置と決まらない位置を分けることだけに使う：
 * 決まった位置は塗った点、仮に置いた位置は点線の丸、作者が置いた点には
 * 小さな四角の印。線は決まった線だけ実線で、食い違いは赤。
 */

/** 地名の色（`core/termColors.ts` にしか16進を置かない。相関図と同じ受け方） */
function locationColorVariables(): string {
  const color = TERM_COLORS.location;
  return `:root { --novelai-location: ${color.light}; }
body.vscode-dark, body.vscode-high-contrast { --novelai-location: ${color.dark}; }`;
}

export function buildLocationSketchPanelHtml(nonce: string, cspSource: string): string {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src ${cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>場所の略図</title>
<style nonce="${nonce}">
${locationColorVariables()}
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
label.inline { font-size: 12px; color: var(--vscode-descriptionForeground); }
select {
  background: var(--vscode-dropdown-background);
  color: var(--vscode-dropdown-foreground);
  border: 1px solid var(--vscode-dropdown-border, transparent);
  font-family: inherit;
  font-size: inherit;
  padding: 2px 4px;
}
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
#layout { display: flex; flex: 1; min-height: 0; }
#canvas { flex: 1; min-width: 0; overflow: hidden; position: relative; display: flex; }
#side {
  width: 300px;
  min-width: 220px;
  padding: 12px;
  overflow-y: auto;
  border-left: 1px solid var(--vscode-panel-border);
  font-size: 12px;
  line-height: 1.6;
}
h2 { font-size: 1em; margin: 0 0 6px; }
h3 {
  font-size: 12px;
  color: var(--vscode-descriptionForeground);
  margin: 14px 0 4px;
  font-weight: normal;
}
.empty {
  margin: auto;
  padding: 32px 16px;
  color: var(--vscode-descriptionForeground);
  line-height: 1.8;
  max-width: 34em;
}
.side-row { padding: 2px 0; }
.sub { color: var(--vscode-descriptionForeground); }
.link {
  background: none;
  border: none;
  color: var(--vscode-textLink-foreground);
  padding: 0;
  text-align: left;
  cursor: pointer;
}
.link:hover { text-decoration: underline; }
.actions { display: flex; flex-wrap: wrap; gap: 6px; margin: 6px 0 4px; }
table.legend { border-collapse: collapse; }
table.legend td { padding: 1px 8px 1px 0; vertical-align: middle; }
/* 狭い窓では右の欄を細くして、図の場所を残す */
@media (max-width: 760px) {
  #side { width: 200px; min-width: 160px; }
}
footer {
  padding: 6px 16px;
  border-top: 1px solid var(--vscode-panel-border);
  font-size: 12px;
  color: var(--vscode-descriptionForeground);
  min-height: 26px;
}
svg#sketch {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  touch-action: none;
  cursor: grab;
  user-select: none;
}
svg#sketch.panning { cursor: grabbing; }
/* 図の中の見た目。class の頭を s- で揃える */
.s-frame { fill: none; stroke: var(--novelai-location); stroke-opacity: 0.45; stroke-width: 1.2; }
.s-frame-label { fill: var(--novelai-location); font-size: 13px; opacity: 0.9; }
.s-line { stroke: var(--vscode-foreground); stroke-opacity: 0.55; stroke-width: 1.4; fill: none; }
.s-line.s-dashed { stroke-dasharray: 6 4; }
.s-line.s-adjacent { stroke-dasharray: 2 3; stroke-opacity: 0.7; }
.s-line.s-conflict { stroke: var(--vscode-errorForeground, #d33); stroke-opacity: 0.95; stroke-width: 2; }
.s-line-label { fill: var(--vscode-descriptionForeground); font-size: 12px; }
.s-conflict-label { fill: var(--vscode-errorForeground, #d33); font-size: 12px; cursor: pointer; text-decoration: underline; }
.s-conflict-hit { stroke: transparent; stroke-width: 12; fill: none; cursor: pointer; }
.s-mismatch { fill: var(--vscode-editorWarning-foreground, #c90); }
.s-mismatch-text { fill: var(--vscode-editor-background); font-size: 10px; font-weight: 700; }
.s-point { cursor: move; }
.s-dot { fill: var(--novelai-location); }
.s-dot.s-unsettled {
  fill: var(--vscode-editor-background);
  stroke: var(--novelai-location);
  stroke-width: 1.5;
  stroke-dasharray: 3 2;
}
.s-dot.s-shelf { fill: var(--vscode-editor-background); stroke: var(--vscode-descriptionForeground); stroke-width: 1.2; }
.s-author-mark { fill: var(--vscode-foreground); }
.s-name { fill: var(--vscode-foreground); font-size: 15px; }
.s-name.s-unsettled { fill: var(--vscode-descriptionForeground); }
.s-point.s-selected .s-dot { stroke: var(--vscode-focusBorder); stroke-width: 2.5; stroke-dasharray: none; }
.s-shelf-label { fill: var(--vscode-descriptionForeground); font-size: 13px; }
.s-shelf-line { stroke: var(--vscode-panel-border); stroke-dasharray: 2 4; }
</style>
</head>
<body>
<header>
  <h1 id="title">場所の略図</h1>
  <label class="inline" for="origin">起点</label>
  <select id="origin" title="図の起点にする場所。関係のいちばん多い場所が既定です"></select>
  <button id="fit" title="図の全体が欄にちょうど収まる大きさへ戻します">全体を合わせる</button>
</header>
<div id="layout">
  <main id="canvas">
    <div class="empty" id="empty"></div>
    <svg id="sketch" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid meet"></svg>
  </main>
  <aside id="side">
    <div id="selected"></div>
    <div id="conflicts"></div>
    <div id="legend"></div>
    <div id="unused"></div>
  </aside>
</div>
<footer id="notice"></footer>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const SVG_NS = "http://www.w3.org/2000/svg";
/** 棚を図の下にどれだけ離して置くか・棚の点の間 */
const SHELF_GAP = 90;
const SHELF_STEP = 110;

/** 拡張機能から届いた図。画面はこれを描くだけ */
let view = null;
/** 選んでいる点 */
let selectedId = null;
/** いま見せている範囲。null は全体を合わせる */
let viewBox = null;
/** 引っ張っている途中の点の位置（離すまで画面だけで動かす） */
let dragging = null;
let panning = null;
/** 保存を頼んで、まだ読み直した図が届いていない点（届くまで置いた所に見せる） */
let pending = null;

const el = {
  title: document.getElementById("title"),
  origin: document.getElementById("origin"),
  fit: document.getElementById("fit"),
  svg: document.getElementById("sketch"),
  empty: document.getElementById("empty"),
  selected: document.getElementById("selected"),
  conflicts: document.getElementById("conflicts"),
  legend: document.getElementById("legend"),
  unused: document.getElementById("unused"),
  notice: document.getElementById("notice"),
};

function svgEl(tag, attrs, text) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const key of Object.keys(attrs || {})) node.setAttribute(key, String(attrs[key]));
  if (text !== undefined) node.textContent = text;
  return node;
}

function htmlEl(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** 棚の点の位置（図の下に横一列） */
function shelfPositions() {
  const result = new Map();
  if (!view) return result;
  const bounds = view.sketch.bounds;
  const y = (view.sketch.points.length > 0 ? bounds.maxY : 0) + SHELF_GAP;
  const left = view.sketch.points.length > 0 ? bounds.minX : 0;
  view.sketch.shelf.forEach(function (entry, index) {
    result.set(entry.id, { x: left + index * SHELF_STEP, y: y });
  });
  return result;
}

function positionOf(id) {
  if (dragging && dragging.id === id) return { x: dragging.x, y: dragging.y };
  if (pending && pending.id === id) return { x: pending.x, y: pending.y };
  const point = view.sketch.points.find(function (p) { return p.id === id; });
  if (point) return { x: point.x, y: point.y };
  return shelfPositions().get(id) || null;
}

function fullBox() {
  const bounds = view.sketch.bounds;
  let minX = bounds.minX, minY = bounds.minY, maxX = bounds.maxX, maxY = bounds.maxY;
  if (view.sketch.points.length === 0) { minX = 0; minY = 0; maxX = 0; maxY = 0; }
  const shelf = shelfPositions();
  shelf.forEach(function (pos) {
    minX = Math.min(minX, pos.x); maxX = Math.max(maxX, pos.x);
    minY = Math.min(minY, pos.y - 30); maxY = Math.max(maxY, pos.y);
  });
  const pad = 70;
  return { x: minX - pad, y: minY - pad, w: Math.max(maxX - minX + pad * 2, 200), h: Math.max(maxY - minY + pad * 2, 160) };
}

function applyViewBox() {
  const box = viewBox || fullBox();
  el.svg.setAttribute("viewBox", box.x + " " + box.y + " " + box.w + " " + box.h);
}

function nameOf(id) {
  const entry = view.locations.find(function (l) { return l.id === id; });
  return entry ? entry.name : id;
}

function draw() {
  el.svg.textContent = "";
  if (!view) return;
  const sketch = view.sketch;
  const nothing = sketch.points.length === 0 && sketch.shelf.length === 0;
  el.empty.textContent = view.emptyMessage;
  el.empty.style.display = nothing ? "block" : "none";
  el.svg.style.display = nothing ? "none" : "block";
  applyViewBox();

  const layerFrames = svgEl("g", {});
  const layerLines = svgEl("g", {});
  const layerPoints = svgEl("g", {});
  el.svg.appendChild(layerFrames);
  el.svg.appendChild(layerLines);
  el.svg.appendChild(layerPoints);

  for (const frame of sketch.frames) {
    layerFrames.appendChild(svgEl("rect", {
      class: "s-frame", x: frame.x, y: frame.y, width: frame.width, height: frame.height, rx: 8,
      "data-id": frame.id,
    }));
    layerFrames.appendChild(svgEl("text", { class: "s-frame-label", x: frame.x + 6, y: frame.y + 15 }, frame.name));
  }

  for (const line of sketch.lines) {
    const a = positionOf(line.from);
    const b = positionOf(line.to);
    if (!a || !b) continue;
    const classes = ["s-line"];
    if (line.kind === "adjacent") classes.push("s-adjacent");
    else if (line.dashed) classes.push("s-dashed");
    if (line.conflict) classes.push("s-conflict");
    const group = svgEl("g", { class: "s-line-group", "data-from": line.from, "data-to": line.to });
    const shape = svgEl("line", { class: classes.join(" "), x1: a.x, y1: a.y, x2: b.x, y2: b.y });
    const tip = svgEl("title", {}, line.statements.join("\\n"));
    shape.appendChild(tip);
    group.appendChild(shape);
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    if (line.label) {
      group.appendChild(svgEl("text", { class: "s-line-label", x: mx + 4, y: my - 4 }, line.label));
    }
    if (line.conflict) {
      const index = line.conflict.index;
      const hit = svgEl("line", { class: "s-conflict-hit", x1: a.x, y1: a.y, x2: b.x, y2: b.y, "data-conflict": index });
      hit.appendChild(svgEl("title", {}, "押すと提案パネルの「矛盾」の同じ行と、本文の同じ所を開きます"));
      group.appendChild(hit);
      const label = svgEl("text", { class: "s-conflict-label", x: mx + 4, y: my + 10, "data-conflict": index }, line.conflict.label);
      group.appendChild(label);
    }
    if (line.authorMismatch) {
      const mark = svgEl("g", { class: "s-mismatch-mark" });
      mark.appendChild(svgEl("circle", { class: "s-mismatch", cx: mx - 10, cy: my, r: 6 }));
      mark.appendChild(svgEl("text", { class: "s-mismatch-text", x: mx - 12, y: my + 3.5 }, "!"));
      mark.appendChild(svgEl("title", {}, "作者が置いた位置が、資料の方角と食い違っています（位置はそのまま残します）"));
      group.appendChild(mark);
    }
    layerLines.appendChild(group);
  }

  const shelf = shelfPositions();
  if (sketch.shelf.length > 0) {
    const first = shelf.get(sketch.shelf[0].id);
    layerLines.appendChild(svgEl("text", { class: "s-shelf-label", x: first.x - 10, y: first.y - 22 },
      "位置未定の棚（手がかりの無い場所。引っ張って図へ置けます）"));
  }

  const drawPoint = function (id, name, pos, classes, extra) {
    const group = svgEl("g", { class: "s-point" + (selectedId === id ? " s-selected" : ""), "data-id": id, "data-kind": extra.kind });
    group.appendChild(svgEl("circle", { class: "s-dot " + classes, cx: pos.x, cy: pos.y, r: 7 }));
    if (extra.author) {
      group.appendChild(svgEl("rect", { class: "s-author-mark", x: pos.x + 6, y: pos.y - 11, width: 5, height: 5 }));
    }
    group.appendChild(svgEl("text", { class: "s-name" + (extra.settled ? "" : " s-unsettled"), x: pos.x + 10, y: pos.y + 16 }, name));
    group.appendChild(svgEl("title", {}, extra.tip));
    layerPoints.appendChild(group);
  };
  for (const point of sketch.points) {
    const pos = positionOf(point.id);
    const unsettled = !point.settled && !point.authorPlaced;
    drawPoint(point.id, point.name, pos, unsettled ? "s-unsettled" : "", {
      kind: "point",
      author: point.authorPlaced,
      settled: point.settled || point.authorPlaced,
      tip: point.authorPlaced ? point.name + "（作者が置いた位置）" : point.settled ? point.name + "（方角と距離で決まった位置）" : point.name + "（仮に置いた位置）",
    });
  }
  for (const entry of sketch.shelf) {
    drawPoint(entry.id, entry.name, positionOf(entry.id), "s-shelf", {
      kind: "shelf", author: false, settled: false, tip: entry.name + "（位置の手がかりがありません）",
    });
  }
}

function drawSide() {
  const sketch = view.sketch;
  // 選んでいる点
  el.selected.textContent = "";
  const point = sketch.points.find(function (p) { return p.id === selectedId; });
  const onShelf = sketch.shelf.find(function (s) { return s.id === selectedId; });
  if (point || onShelf) {
    el.selected.appendChild(htmlEl("h2", "", (point || onShelf).name));
    el.selected.appendChild(htmlEl("div", "sub",
      point ? (point.authorPlaced ? "作者が置いた位置です。" : point.settled ? "方角と距離で決まった位置です。" : "仮に置いた位置です（方角か距離が足りません）。")
        : "位置の手がかりがありません。引っ張って図へ置けます。"));
    const actions = htmlEl("div", "actions");
    const open = htmlEl("button", "", "場所の資料を開く");
    open.addEventListener("click", function () { vscode.postMessage({ type: "openRecord", id: selectedId }); });
    actions.appendChild(open);
    if (point) {
      const origin = htmlEl("button", "", "ここを起点にする");
      origin.addEventListener("click", function () { vscode.postMessage({ type: "origin", id: selectedId }); });
      actions.appendChild(origin);
    }
    if (point && point.authorPlaced) {
      const reset = htmlEl("button", "", "置いた位置を外す");
      reset.title = "作者が置いた位置を外し、関係から決めた位置へ戻します";
      reset.addEventListener("click", function () { vscode.postMessage({ type: "resetPosition", id: selectedId }); });
      actions.appendChild(reset);
    }
    el.selected.appendChild(actions);
  }

  // 食い違い
  el.conflicts.textContent = "";
  if (sketch.conflicts.length > 0) {
    el.conflicts.appendChild(htmlEl("h3", "", "位置関係の食い違い（押すと提案パネルの行へ）"));
    for (const conflict of sketch.conflicts) {
      const row = htmlEl("div", "side-row");
      const link = htmlEl("button", "link", conflict.summary);
      link.setAttribute("data-conflict", String(conflict.index));
      link.addEventListener("click", function () { vscode.postMessage({ type: "conflict", index: conflict.index }); });
      row.appendChild(link);
      row.appendChild(htmlEl("div", "sub", conflict.label));
      el.conflicts.appendChild(row);
    }
  }

  // 凡例
  el.legend.textContent = "";
  el.legend.appendChild(htmlEl("h3", "", "見方"));
  const rows = [
    ["塗った点", "方角と距離で決まった位置"],
    ["点線の丸", "仮に置いた位置（方角か距離が足りない・換算した）"],
    ["点の右上の四角", "作者が引っ張って置いた位置"],
    ["実線", "方角と距離がそろった関係"],
    ["点線", "方角だけ（距離未定）・距離だけ（向き未定）・換算した距離"],
    ["（縮めて描画）", "ほかとかけ離れた距離を、図に収まる長さで描いた線（比のままではない）"],
    ["細かい点線", "隣接（近くへ寄せただけ）"],
    ["枠", "含む関係（枠の中にある）"],
    ["赤い線", "資料の位置関係が食い違っている組"],
    ["「!」の印", "作者が置いた位置が、資料の方角と食い違う"],
  ];
  const table = htmlEl("table", "legend");
  for (const row of rows) {
    const tr = htmlEl("tr");
    tr.appendChild(htmlEl("td", "", row[0]));
    tr.appendChild(htmlEl("td", "sub", row[1]));
    table.appendChild(tr);
  }
  el.legend.appendChild(table);
  el.legend.appendChild(htmlEl("div", "sub",
    "関係でつながらない場所どうしは、離れた塊（島）として横に並べています。島どうしの距離や向きには意味がありません。"));
  if (sketch.conversions) {
    el.legend.appendChild(htmlEl("h3", "", "乗り物の換算（乗り物が混ざる所だけ）"));
    const speeds = htmlEl("table", "legend");
    for (const entry of sketch.conversions) {
      const tr = htmlEl("tr");
      tr.appendChild(htmlEl("td", "", entry.mode));
      tr.appendChild(htmlEl("td", "sub", "時速" + entry.kmh + "km"));
      speeds.appendChild(tr);
    }
    el.legend.appendChild(speeds);
  }

  // 使えなかった関係
  el.unused.textContent = "";
  if (sketch.unused.length > 0) {
    el.unused.appendChild(htmlEl("h3", "", "略図に使えなかった関係"));
    for (const entry of sketch.unused) {
      const row = htmlEl("div", "side-row");
      row.appendChild(htmlEl("div", "", entry.text));
      row.appendChild(htmlEl("div", "sub", entry.reason));
      el.unused.appendChild(row);
    }
  }

  el.notice.textContent = view.warning || "";
}

function drawOrigin() {
  const current = view.origin || "";
  el.origin.textContent = "";
  const auto = document.createElement("option");
  auto.value = "";
  auto.textContent = "関係のいちばん多い場所";
  el.origin.appendChild(auto);
  for (const entry of view.locations) {
    const option = document.createElement("option");
    option.value = entry.id;
    option.textContent = entry.name;
    el.origin.appendChild(option);
  }
  el.origin.value = current;
}

/** 画面の座標を図の座標へ */
function toSketch(event) {
  const matrix = el.svg.getScreenCTM();
  if (!matrix) return { x: 0, y: 0 };
  const point = el.svg.createSVGPoint();
  point.x = event.clientX;
  point.y = event.clientY;
  const result = point.matrixTransform(matrix.inverse());
  return { x: result.x, y: result.y };
}

el.svg.addEventListener("pointerdown", function (event) {
  if (!view) return;
  const conflictTarget = event.target.closest && event.target.closest("[data-conflict]");
  if (conflictTarget) {
    vscode.postMessage({ type: "conflict", index: Number(conflictTarget.getAttribute("data-conflict")) });
    return;
  }
  const pointTarget = event.target.closest && event.target.closest(".s-point");
  if (pointTarget) {
    const id = pointTarget.getAttribute("data-id");
    const start = toSketch(event);
    const pos = positionOf(id);
    dragging = { id: id, x: pos.x, y: pos.y, dx: pos.x - start.x, dy: pos.y - start.y, moved: false, startX: event.clientX, startY: event.clientY };
    el.svg.setPointerCapture(event.pointerId);
    return;
  }
  const start = toSketch(event);
  if (!viewBox) viewBox = fullBox();
  panning = { x: start.x, y: start.y };
  el.svg.classList.add("panning");
  el.svg.setPointerCapture(event.pointerId);
});

el.svg.addEventListener("pointermove", function (event) {
  if (dragging) {
    if (Math.abs(event.clientX - dragging.startX) + Math.abs(event.clientY - dragging.startY) > 3) dragging.moved = true;
    if (!dragging.moved) return;
    // 引っ張っている間は見せる範囲を止める（点が逃げないように）
    if (!viewBox) viewBox = fullBox();
    const at = toSketch(event);
    dragging.x = at.x + dragging.dx;
    dragging.y = at.y + dragging.dy;
    draw();
    return;
  }
  if (panning && viewBox) {
    const at = toSketch(event);
    viewBox = { x: viewBox.x - (at.x - panning.x), y: viewBox.y - (at.y - panning.y), w: viewBox.w, h: viewBox.h };
    applyViewBox();
  }
});

el.svg.addEventListener("pointerup", function () {
  if (dragging) {
    const done = dragging;
    dragging = null;
    if (done.moved) {
      // 離したら保存を頼む。保存して読み直した図が届くまで、置いた所に見せておく
      selectedId = done.id;
      vscode.postMessage({ type: "move", id: done.id, x: done.x, y: done.y });
      pending = done;
    } else {
      selectedId = selectedId === done.id ? null : done.id;
    }
    draw();
    drawSide();
    return;
  }
  panning = null;
  el.svg.classList.remove("panning");
});



el.svg.addEventListener("wheel", function (event) {
  if (!view) return;
  event.preventDefault();
  if (!viewBox) viewBox = fullBox();
  const at = toSketch(event);
  const factor = event.deltaY > 0 ? 1.15 : 1 / 1.15;
  viewBox = {
    x: at.x - (at.x - viewBox.x) * factor,
    y: at.y - (at.y - viewBox.y) * factor,
    w: viewBox.w * factor,
    h: viewBox.h * factor,
  };
  applyViewBox();
}, { passive: false });

el.fit.addEventListener("click", function () {
  viewBox = null;
  applyViewBox();
});

el.origin.addEventListener("change", function () {
  vscode.postMessage({ type: "origin", id: el.origin.value || null });
});

window.addEventListener("message", function (event) {
  const message = event.data;
  if (!message || message.type !== "sketch") return;
  view = message.data;
  pending = null;
  if (view.focusId) selectedId = view.focusId;
  if (selectedId && !view.locations.some(function (l) { return l.id === selectedId; })) selectedId = null;
  el.title.textContent = view.title;
  drawOrigin();
  draw();
  drawSide();
});

vscode.postMessage({ type: "ready" });
</script>
</body>
</html>`;
}
