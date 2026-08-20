import { ACTOR_MARKS, ACTOR_STYLES, ACTOR_KINDS } from "../models/actor";

/**
 * 編集履歴の画面（設計書5.6）。
 *
 * **3種類を色分けするのは、見た目のためではない。**
 * 並んでいるものが同じ見え方をしていたら、**編集部の直しを自分の直しと
 * 取り違える。** 色に加えて記号（●▲■）も出すのは、色が分からなくても
 * 区別できるようにするためである。
 *
 * VS Codeの配色に合わせつつ、3色は自前で持つ（`models/actor.ts`）。
 * 配色テーマ側の色を使うと、テーマによって3つが似た色になりうる。
 */
export function buildEditHistoryHtml(nonce: string, cspSource: string): string {
  const legend = ACTOR_KINDS.map((kind) => {
    const style = ACTOR_STYLES[kind];
    return (
      `<span class="legend-item"><span class="mark" style="color:${style.color}">` +
      `${ACTOR_MARKS[kind]}</span>${style.label}` +
      `<span class="legend-note">${style.description}</span></span>`
    );
  }).join("");

  const colorRules = ACTOR_KINDS.map(
    (kind) =>
      `.entry.${kind} { border-left-color: ${ACTOR_STYLES[kind].color}; }\n` +
      `.entry.${kind} .who { color: ${ACTOR_STYLES[kind].color}; }`
  ).join("\n");

  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
body {
  font-family: var(--vscode-font-family);
  color: var(--vscode-foreground);
  background: var(--vscode-editor-background);
  padding: 12px 16px;
  font-size: 13px;
}
h1 { font-size: 15px; margin: 0 0 4px; }
.subtitle { color: var(--vscode-descriptionForeground); margin: 0 0 12px; }

.legend { display: flex; flex-wrap: wrap; gap: 14px; margin-bottom: 14px; }
.legend-item { display: flex; align-items: baseline; gap: 5px; }
.mark { font-size: 14px; }
.legend-note { color: var(--vscode-descriptionForeground); font-size: 11px; }

.filters { display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 12px; }
.filters label { cursor: pointer; user-select: none; }

.entry {
  border-left: 3px solid transparent;
  padding: 6px 0 6px 10px;
  margin-bottom: 6px;
}
.entry .head { display: flex; flex-wrap: wrap; gap: 8px; align-items: baseline; }
.who { font-weight: 600; }
.name { color: var(--vscode-descriptionForeground); }
.time { color: var(--vscode-descriptionForeground); font-size: 11px; margin-left: auto; }
.action { margin-top: 2px; }
.file {
  font-family: var(--vscode-editor-font-family);
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
}
.detail {
  font-family: var(--vscode-editor-font-family);
  font-size: 11px;
  white-space: pre-wrap;
  word-break: break-all;
  margin-top: 2px;
  opacity: 0.85;
}
${colorRules}

.empty { color: var(--vscode-descriptionForeground); padding: 20px 0; }
.hidden { display: none; }
</style>
</head>
<body>
<h1>編集履歴</h1>
<p class="subtitle">誰が何を直したかの記録です。<strong>この画面から履歴は変えられません。</strong></p>

<div class="legend">${legend}</div>

<div class="filters" id="filters">
${ACTOR_KINDS.map(
  (kind) =>
    `<label><input type="checkbox" data-kind="${kind}" checked> ${ACTOR_STYLES[kind].label}だけ見る</label>`
).join("\n")}
</div>

<div id="list"></div>

<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const listEl = document.getElementById('list');
const MARKS = ${JSON.stringify(ACTOR_MARKS)};
const LABELS = ${JSON.stringify(
    Object.fromEntries(ACTOR_KINDS.map((k) => [k, ACTOR_STYLES[k].label]))
  )};
let entries = [];

document.getElementById('filters').addEventListener('change', render);

function visibleKinds() {
  return [...document.querySelectorAll('#filters input')]
    .filter((box) => box.checked)
    .map((box) => box.dataset.kind);
}

function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** 時刻は読める形にする。読めない値はそのまま出す（捨てない） */
function formatTime(value) {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return escapeHtml(value);
  const d = new Date(parsed);
  const pad = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
    + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

function render() {
  const kinds = visibleKinds();
  const shown = entries.filter((entry) => kinds.includes(entry.actor));
  if (shown.length === 0) {
    listEl.innerHTML = '<p class="empty">まだ記録がありません。</p>';
    return;
  }
  listEl.innerHTML = shown.map((entry) =>
    '<div class="entry ' + entry.actor + '">' +
      '<div class="head">' +
        '<span class="who">' + MARKS[entry.actor] + ' ' + LABELS[entry.actor] + '</span>' +
        (entry.actorName ? '<span class="name">' + escapeHtml(entry.actorName) + '</span>' : '') +
        '<span class="time">' + formatTime(entry.time) + '</span>' +
      '</div>' +
      '<div class="action">' + escapeHtml(entry.action) + '</div>' +
      (entry.file ? '<div class="file">' + escapeHtml(entry.file) + '</div>' : '') +
      (entry.detail ? '<div class="detail">' + escapeHtml(entry.detail) + '</div>' : '') +
    '</div>'
  ).join('');
}

window.addEventListener('message', (event) => {
  if (event.data.type === 'history') {
    entries = event.data.entries;
    render();
  }
});

vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
}
