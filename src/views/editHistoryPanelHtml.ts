import { ACTOR_MARKS, ACTOR_STYLES, ACTOR_KINDS } from "../models/actor";
import {
  EXTERNAL_EXPOSURE_LABELS,
  EXTERNAL_EXPOSURE_MARKS,
} from "../core/externalAccessLog";

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

/*
  外部AIの欄は、編集履歴と**見た目から分ける**。
  同じ形で並べると、外部AIが原稿を直したように読める。
*/
.section {
  margin-top: 26px;
  border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.35));
  padding-top: 14px;
}
.section h2 { font-size: 14px; margin: 0 0 4px; }
.access {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: baseline;
  padding: 5px 0 5px 10px;
  border-left: 3px solid var(--vscode-panel-border, rgba(128,128,128,0.35));
  margin-bottom: 4px;
}
/* **本文が外へ出た回だけは目立たせる。** そこだけは見落とされては困る */
.access.body { border-left-color: var(--vscode-errorForeground); }
.access.body .exposure { color: var(--vscode-errorForeground); font-weight: 600; }
.access .tool { font-family: var(--vscode-editor-font-family); }
.access .exposure { font-size: 12px; }
.access .meta { color: var(--vscode-descriptionForeground); font-size: 11px; }
.access .time { color: var(--vscode-descriptionForeground); font-size: 11px; margin-left: auto; }
.access.failed .tool { text-decoration: line-through; opacity: 0.7; }

/* いまの許可の状態。**記録より先に目に入る位置に置く** */
.permission {
  margin: 0 0 8px;
  padding: 6px 10px;
  border-left: 3px solid var(--vscode-charts-green, #6a8f3d);
  font-weight: 600;
}
.permission.allowed { border-left-color: var(--vscode-errorForeground); }
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

<div class="section" id="external-section">
<h2>外部AIが読んだ記録</h2>
<p class="permission" id="permission"></p>
<p class="subtitle">MCPサーバー経由で、外部のAIがこの作品を読んだ記録です。<strong>外部AIは原稿を書き換えません。</strong>いちばん大事なのは、本文がこの機械の外へ出たかどうかです。</p>
<div id="external-list"></div>
</div>

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

const externalListEl = document.getElementById('external-list');
const EXPOSURE_MARKS = ${JSON.stringify(EXTERNAL_EXPOSURE_MARKS)};
const EXPOSURE_LABELS = ${JSON.stringify(EXTERNAL_EXPOSURE_LABELS)};
let externalEntries = [];

function renderExternal() {
  if (externalEntries.length === 0) {
    externalListEl.innerHTML =
      '<p class="empty">外部AIがこの作品を読んだ記録はありません。</p>';
    return;
  }
  externalListEl.innerHTML = externalEntries.map((entry) => {
    const exposure = EXPOSURE_LABELS[entry.exposure] ? entry.exposure : 'body';
    const meta = [
      entry.client,
      entry.file,
      entry.model,
      entry.detail,
    ].filter(Boolean).map(escapeHtml).join(' / ');
    return '<div class="access ' + exposure + (entry.ok ? '' : ' failed') + '">' +
      '<span class="tool">' + escapeHtml(entry.tool) + '</span>' +
      '<span class="exposure">' + EXPOSURE_MARKS[exposure] + ' ' +
        escapeHtml(EXPOSURE_LABELS[exposure]) + '</span>' +
      (entry.ok ? '' : '<span class="meta">失敗</span>') +
      (meta ? '<span class="meta">' + meta + '</span>' : '') +
      '<span class="time">' + formatTime(entry.time) + '</span>' +
    '</div>';
  }).join('');
}

const permissionEl = document.getElementById('permission');

window.addEventListener('message', (event) => {
  if (event.data.type === 'history') {
    entries = event.data.entries;
    externalEntries = event.data.external ?? [];
    permissionEl.textContent = event.data.permission ?? '';
    // **許可されているときに目立たせる。** 拒否は既定なので、
    // 知らせるべきは「いま読まれうる」ほうである
    permissionEl.className = 'permission' + (event.data.allowed ? ' allowed' : '');
    render();
    renderExternal();
  }
});

vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
}
