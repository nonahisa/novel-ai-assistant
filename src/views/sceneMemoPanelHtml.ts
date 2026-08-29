/**
 * シーンメモのパネル（設計書6.40.4）。
 *
 * 年表・人物相関図・執筆量パネルと同じ作りにしてある——外部ライブラリを
 * 使わず、値はすべて `postMessage` で渡し、HTMLへ文字列として埋め込まない
 * （メモの文に引用符や `<` が入ると画面が壊れるため）。
 *
 * **数えたり並べたりしない。** 本文からの拾い出し（`core/sceneMemo.ts`）も
 * 絞り込みも並べ替えも拡張機能側で済ませてある。ここが描くのは受け取った
 * 一覧だけで、押したことは拡張機能へ返す。
 *
 * **この画面は本文を直に書き換えない。** 「済みにする」も拡張機能へ頼み、
 * 向こうが既存の書き換え経路（原稿エディタの WorkspaceEdit か
 * `writeTextFilePreservingFormat`）を通す（6.40.6）。
 */
export function buildSceneMemoPanelHtml(
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
<title>シーンメモ</title>
<style nonce="${nonce}">
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
  padding: 8px 12px 6px;
  border-bottom: 1px solid var(--vscode-panel-border);
}
h1 { font-size: 1.05em; margin: 0 0 4px; }
#counts { color: var(--vscode-descriptionForeground); font-size: 12px; }
.row-controls {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  margin-top: 6px;
}
button {
  background: var(--vscode-button-secondaryBackground);
  color: var(--vscode-button-secondaryForeground);
  border: none;
  border-radius: 2px;
  padding: 4px 10px;
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
select, input[type="search"] {
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border, var(--vscode-dropdown-border));
  padding: 3px 6px;
  font-family: inherit;
  font-size: inherit;
}
input[type="search"] { flex: 1 1 120px; min-width: 90px; }
#notice {
  padding: 6px 12px;
  color: var(--vscode-descriptionForeground);
  border-bottom: 1px solid var(--vscode-panel-border);
}
#notice:empty { display: none; }
#body { flex: 1; min-height: 0; overflow: auto; padding: 4px 0 32px; }
#empty { padding: 20px 12px; color: var(--vscode-descriptionForeground); }
h2 {
  font-size: 0.9em;
  margin: 12px 0 2px;
  padding: 0 12px 3px;
  color: var(--vscode-descriptionForeground);
  border-bottom: 1px solid var(--vscode-panel-border);
}
.memo {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  padding: 5px 12px;
  border-bottom: 1px solid var(--vscode-panel-border);
}
/* いまカーソルのある場所にいちばん近い付箋（設計書6.40.4）。
   **光らせるだけで、本文は動かさない** */
.memo.active { background: var(--vscode-list-activeSelectionBackground); }
.memo.active .go { color: var(--vscode-list-activeSelectionForeground); }
.dot {
  flex: 0 0 auto;
  width: 8px;
  height: 8px;
  margin-top: 6px;
  border-radius: 50%;
  background: var(--novelai-memo-other, #6b6b6b);
}
.dot.memo-todo { background: var(--novelai-memo-todo, #c01c28); }
.dot.memo-check { background: var(--novelai-memo-check, #9a6700); }
.dot.memo-foreshadow { background: var(--novelai-memo-foreshadow, #1a5fb4); }
.dot.memo-idea { background: var(--novelai-memo-idea, #1c7c3c); }
.main { flex: 1 1 auto; min-width: 0; }
.go {
  display: block;
  width: 100%;
  background: none;
  border: none;
  padding: 0;
  text-align: left;
  font: inherit;
  color: inherit;
  cursor: pointer;
  white-space: pre-wrap;
  overflow-wrap: break-word;
}
.go:hover { text-decoration: underline; }
.tag {
  display: inline-block;
  margin-right: 5px;
  padding: 0 5px;
  border-radius: 2px;
  font-size: 11px;
  background: var(--vscode-badge-background);
  color: var(--vscode-badge-foreground);
}
.where {
  display: block;
  margin-top: 2px;
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
}
.done {
  flex: 0 0 auto;
  padding: 2px 8px;
  font-size: 11px;
}
</style>
</head>
<body>
<header>
  <h1 id="title">シーンメモ</h1>
  <div id="counts"></div>
  <div class="row-controls">
    <button id="prev" title="ひとつ前のメモへ飛びます（話をまたぎます）">← 戻る</button>
    <button id="next" title="次のメモへ飛びます（話をまたぎます）">次へ →</button>
    <button id="onlyCurrent" title="いま開いている話のメモだけを出します">この話だけ</button>
    <select id="tag" title="タグで絞り込みます"></select>
    <input type="search" id="query" placeholder="文字で探す">
    <button id="export" title="いま出ているメモをMarkdownで書き出します">書き出す</button>
  </div>
</header>
<div id="notice"></div>
<div id="body">
  <div id="empty"></div>
  <div id="list"></div>
</div>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();

/** 拡張機能から届いた一覧。画面はこれを描くだけで、作り替えはしない */
let data = null;

const el = {
  title: document.getElementById("title"),
  counts: document.getElementById("counts"),
  prev: document.getElementById("prev"),
  next: document.getElementById("next"),
  onlyCurrent: document.getElementById("onlyCurrent"),
  tag: document.getElementById("tag"),
  query: document.getElementById("query"),
  exportMd: document.getElementById("export"),
  notice: document.getElementById("notice"),
  empty: document.getElementById("empty"),
  list: document.getElementById("list"),
};

function post(type, payload) {
  vscode.postMessage(Object.assign({ type: type }, payload || {}));
}

function escapeHtml(text) {
  return String(text === null || text === undefined ? "" : text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

el.prev.addEventListener("click", function () { post("prev"); });
el.next.addEventListener("click", function () { post("next"); });
el.onlyCurrent.addEventListener("click", function () {
  post("filter", {
    onlyCurrent: !(data && data.onlyCurrent),
    tag: el.tag.value,
    query: el.query.value,
  });
});
el.tag.addEventListener("change", sendFilter);
el.exportMd.addEventListener("click", function () { post("export"); });

/**
 * 文字で探すは、打ち終わるのを少し待ってから送る。
 * 1文字ごとに一覧を作り直すと、打っている手が止まる
 */
let queryTimer = null;
el.query.addEventListener("input", function () {
  if (queryTimer !== null) clearTimeout(queryTimer);
  queryTimer = setTimeout(function () {
    queryTimer = null;
    sendFilter();
  }, 200);
});

function sendFilter() {
  post("filter", {
    onlyCurrent: data ? data.onlyCurrent : false,
    tag: el.tag.value,
    query: el.query.value,
  });
}

/**
 * 押されたものを拡張機能へ返す。
 *
 * 行は絞り込みのたびに作り直すので、1つずつ耳を付けると付け直しが要る。
 * 一覧の外側で受けて、押されたものを見る（年表と同じ作り）
 */
el.list.addEventListener("click", function (event) {
  const target = event.target.closest("[data-key]");
  if (!target) return;
  const row = findRow(target.dataset.key);
  if (!row) return;
  if (target.classList.contains("done")) {
    // **1件ずつ確認しない**（設計書6.40.4）。付箋が消えても原稿は無傷で、
    // 取り消しは原稿エディタの Ctrl+Z か Git の復元でできる
    post("done", { filePath: row.filePath, line: row.line, raw: row.raw });
    return;
  }
  post("reveal", { filePath: row.filePath, line: row.line });
});

function findRow(key) {
  if (!data) return null;
  for (const row of data.rows) {
    if (row.key === key) return row;
  }
  return null;
}

function renderTags() {
  const signature = data.tags.join(",") + "|" + data.tag;
  if (el.tag.dataset.signature === signature) return;
  el.tag.dataset.signature = signature;

  const options = ['<option value="">すべてのタグ</option>'];
  for (const tag of data.tags) {
    options.push(
      '<option value="' + escapeHtml(tag) + '"' +
        (tag === data.tag ? " selected" : "") + ">" +
        escapeHtml(tag) + "</option>"
    );
  }
  el.tag.innerHTML = options.join("");
}

function renderRow(row) {
  const active = row.key === data.activeKey ? " active" : "";
  const where = row.chapterLabel +
    (row.title ? " " + row.title : "") + "　" + row.line + "行目";
  return '<div class="memo' + active + '">' +
    '<span class="dot ' + escapeHtml(row.tagClass) + '"></span>' +
    '<span class="main">' +
      '<button class="go" data-key="' + escapeHtml(row.key) + '">' +
        '<span class="tag">' + escapeHtml(row.tag) + "</span>" +
        escapeHtml(row.text || "（中身がありません）") +
        '<span class="where">' + escapeHtml(where) + "</span>" +
      "</button>" +
    "</span>" +
    '<button class="done" data-key="' + escapeHtml(row.key) +
      '" title="この行を本文から消します">済み</button>' +
    "</div>";
}

function render() {
  if (!data) return;
  el.title.textContent = data.title;
  el.counts.textContent = data.countsLabel;
  el.notice.textContent = data.notice;
  el.onlyCurrent.classList.toggle("on", data.onlyCurrent === true);
  el.onlyCurrent.disabled = !data.hasCurrent;
  el.prev.disabled = data.totalCount === 0;
  el.next.disabled = data.totalCount === 0;
  el.exportMd.disabled = data.rows.length === 0;
  if (el.query.value !== data.query) el.query.value = data.query;

  renderTags();

  el.empty.textContent = data.rows.length === 0 ? data.emptyMessage : "";

  const html = [];
  let section = null;
  for (const row of data.rows) {
    if (row.section !== section) {
      section = row.section;
      html.push("<h2>" + escapeHtml(section) + "</h2>");
    }
    html.push(renderRow(row));
  }
  el.list.innerHTML = html.join("");

  // 光っている行が画面の外にあると、追従している意味が無い
  const activeEl = el.list.querySelector(".memo.active");
  if (activeEl && activeEl.scrollIntoView) {
    activeEl.scrollIntoView({ block: "nearest" });
  }
}

window.addEventListener("message", function (event) {
  const message = event.data;
  if (!message || message.type !== "memos") return;
  data = message.data;
  if (data.colors) {
    for (const key of Object.keys(data.colors)) {
      document.documentElement.style.setProperty(
        "--novelai-" + key,
        data.colors[key]
      );
    }
  }
  render();
});

// HTMLを流し込んだ直後は、まだこの script が走っていない。
// 受け手が居ることを知らせてから送ってもらう
post("ready");
</script>
</body>
</html>`;
}
