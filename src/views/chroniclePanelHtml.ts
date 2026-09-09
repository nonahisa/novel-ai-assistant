/**
 * 年表の画面（設計書6.39.4）。
 *
 * 執筆量パネル・人物相関図と同じ作りにしてある——外部ライブラリを使わず、
 * 値はすべて `postMessage` で渡し、HTMLへ文字列として埋め込まない
 * （人物名や題に引用符が入ると画面が壊れるため）。
 *
 * **計算はしない。** 行の組み立て（`core/chronicle.ts`）も並べ替えも
 * 拡張機能側で済ませてある。ここが描くのは受け取った表だけで、
 * 押したことは拡張機能へ返す。
 *
 * **この画面は `timeline.json` を書き換えない**（6.39.3・6.39.5）。
 * 時期と系統を作るのは選択画面の流れ（`features/chronicleEdit.ts`）で、
 * ここにあるのは、そちらを呼び出すボタンだけである。
 */
export function buildChroniclePanelHtml(
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
<title>年表</title>
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
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding: 10px 16px;
  border-bottom: 1px solid var(--vscode-panel-border);
}
h1 { font-size: 1.15em; margin: 0; flex: 1 1 100%; }
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
select {
  background: var(--vscode-dropdown-background);
  color: var(--vscode-dropdown-foreground);
  border: 1px solid var(--vscode-dropdown-border);
  padding: 3px 6px;
  font-family: inherit;
  font-size: inherit;
}
.group-label {
  font-size: 12px;
  color: var(--vscode-descriptionForeground);
}
.kinds { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
.kinds label { display: inline-flex; align-items: center; gap: 3px; }
#notice {
  padding: 6px 16px;
  color: var(--vscode-descriptionForeground);
  border-bottom: 1px solid var(--vscode-panel-border);
}
#notice:empty { display: none; }
#body { flex: 1; min-height: 0; overflow: auto; padding: 8px 16px 32px; }
#empty { padding: 24px 4px; color: var(--vscode-descriptionForeground); }
h2 {
  font-size: 1.05em;
  margin: 18px 0 4px;
  padding-bottom: 3px;
  border-bottom: 1px solid var(--vscode-panel-border);
}
h3 {
  font-size: 0.95em;
  margin: 12px 0 4px;
  color: var(--vscode-descriptionForeground);
}
table { border-collapse: collapse; width: 100%; margin-bottom: 8px; }
th, td {
  text-align: left;
  vertical-align: top;
  padding: 4px 8px;
  border-bottom: 1px solid var(--vscode-panel-border);
}
th { font-weight: 600; color: var(--vscode-descriptionForeground); }
td.when { white-space: nowrap; color: var(--vscode-descriptionForeground); }
td.who, td.what { width: 22%; }
.link {
  background: none;
  border: none;
  padding: 0;
  color: var(--vscode-textLink-foreground);
  cursor: pointer;
  text-align: left;
  font: inherit;
}
.link:hover { text-decoration: underline; }
/* 題まで1つのボタンに入れたので、折り返しは許す。
   折らせたくないのは見出し（「第1話」）だけである */
.chapter .label { white-space: nowrap; }
.title { color: var(--vscode-descriptionForeground); }
.event { display: block; margin-bottom: 2px; }
.tag {
  display: inline-block;
  min-width: 5.5em;
  margin-right: 4px;
  padding: 0 4px;
  border-radius: 2px;
  font-size: 11px;
  text-align: center;
  background: var(--vscode-badge-background);
  color: var(--vscode-badge-foreground);
}
details summary { cursor: pointer; color: var(--vscode-descriptionForeground); }
details p { margin: 4px 0 0; white-space: pre-wrap; }
</style>
</head>
<body>
<header>
  <h1 id="title">年表</h1>
  <button id="byChapter">話数順</button>
  <button id="byTimeline">時系列順</button>
  <span class="group-label">人物で絞る</span>
  <select id="character"></select>
  <span class="kinds" id="kinds"></span>
  <button id="export">Markdownで書き出す</button>
  <button id="edit">時期・系統を編集</button>
</header>
<div id="notice"></div>
<div id="body">
  <div id="empty"></div>
  <div id="sections"></div>
</div>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();

/** 拡張機能から届いた年表。画面はこれを描くだけで、作り替えはしない */
let data = null;

const el = {
  title: document.getElementById("title"),
  byChapter: document.getElementById("byChapter"),
  byTimeline: document.getElementById("byTimeline"),
  character: document.getElementById("character"),
  kinds: document.getElementById("kinds"),
  exportMd: document.getElementById("export"),
  edit: document.getElementById("edit"),
  notice: document.getElementById("notice"),
  empty: document.getElementById("empty"),
  sections: document.getElementById("sections"),
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

el.byChapter.addEventListener("click", function () { post("order", { order: "chapter" }); });
el.byTimeline.addEventListener("click", function () { post("order", { order: "timeline" }); });
el.exportMd.addEventListener("click", function () { post("export"); });
el.edit.addEventListener("click", function () { post("edit"); });
el.character.addEventListener("change", sendFilter);

/** いま画面に出ている絞り込みを、そのまま拡張機能へ返す */
function sendFilter() {
  const kinds = [];
  const boxes = el.kinds.querySelectorAll("input[type=checkbox]");
  for (const box of boxes) {
    if (box.checked) kinds.push(box.dataset.kind);
  }
  post("filter", { characterId: el.character.value, kinds: kinds });
}

/**
 * 押したものを拡張機能へ返す。
 *
 * 行は絞り込みのたびに作り直すので、1つずつ耳を付けると付け直しが要る。
 * 表の外側で受けて、押されたものを見る
 */
el.sections.addEventListener("click", function (event) {
  const target = event.target.closest("[data-character], [data-file]");
  if (!target) return;
  if (target.dataset.character) {
    post("openCharacter", { characterId: target.dataset.character });
    return;
  }
  post("openEpisode", { filePath: target.dataset.file });
});

function renderKinds() {
  // 選択の状態は画面に残っているので、選択肢が変わらないなら作り直さない
  const signature = data.kindOptions.map(function (entry) {
    return entry.key + ":" + (data.kinds.indexOf(entry.key) >= 0 ? "1" : "0");
  }).join(",");
  if (el.kinds.dataset.signature === signature) return;
  el.kinds.dataset.signature = signature;

  el.kinds.innerHTML = data.kindOptions.map(function (entry) {
    return '<label><input type="checkbox" data-kind="' + escapeHtml(entry.key) + '"' +
      (data.kinds.indexOf(entry.key) >= 0 ? " checked" : "") + ">" +
      escapeHtml(entry.label) + "</label>";
  }).join("");
  const boxes = el.kinds.querySelectorAll("input[type=checkbox]");
  for (const box of boxes) box.addEventListener("change", sendFilter);
}

function renderCharacters() {
  const signature = data.characters.map(function (entry) {
    return entry.id;
  }).join(",") + "|" + data.characterId;
  if (el.character.dataset.signature === signature) return;
  el.character.dataset.signature = signature;

  const options = ['<option value="">全員</option>'];
  for (const entry of data.characters) {
    options.push(
      '<option value="' + escapeHtml(entry.id) + '"' +
        (entry.id === data.characterId ? " selected" : "") + ">" +
        escapeHtml(entry.name) + "</option>"
    );
  }
  el.character.innerHTML = options.join("");
}

function renderRow(row) {
  // **題までボタンの中へ入れる。** 作者は「第1話 気がついたら幽霊に」を
  // ひとつづきのリンクとして押す。題をボタンの外（兄弟の span）に置くと、
  // 題を押したときだけ closest("[data-file]") が空振りし、拡張機能へ何も
  // 届かないまま終わる——通知もログも出ないので、追いようがない
  // （実機で発見、2026-09-05）
  const chapter = '<button class="link chapter" data-file="' +
    escapeHtml(row.filePath) + '"><span class="label">' +
    escapeHtml(row.chapterLabel) + "</span>" +
    (row.title ? ' <span class="title">' + escapeHtml(row.title) + "</span>" : "") +
    "</button>";

  const who = row.appeared.map(function (entry) {
    return '<button class="link" data-character="' + escapeHtml(entry.id) + '">' +
      escapeHtml(entry.name) + "</button>";
  }).join("、");

  const what = row.events.map(function (event) {
    const text = '<span class="tag">' + escapeHtml(event.kindLabel) + "</span>" +
      escapeHtml(event.text);
    // 人物に紐づかない出来事（伏線）は押せない。押しても行き先が無い
    if (!event.characterId) return '<span class="event">' + text + "</span>";
    return '<button class="link event" data-character="' +
      escapeHtml(event.characterId) + '">' + text + "</button>";
  }).join("");

  // あらすじは長い。畳んでおき、読みたい行だけ開く
  const synopsis = row.synopsis
    ? "<details><summary>あらすじ</summary><p>" +
      escapeHtml(row.synopsis) + "</p></details>"
    : "";

  return "<tr>" +
    '<td class="when">' + escapeHtml(row.timepoint) + "</td>" +
    "<td>" + chapter + "</td>" +
    '<td class="who">' + who + "</td>" +
    '<td class="what">' + what + "</td>" +
    "<td>" + synopsis + "</td>" +
    "</tr>";
}

function renderTable(rows) {
  return "<table><thead><tr>" +
    "<th>時期</th><th>話数・題</th><th>登場</th><th>出来事</th><th>あらすじ</th>" +
    "</tr></thead><tbody>" +
    rows.map(renderRow).join("") +
    "</tbody></table>";
}

function render() {
  if (!data) return;
  el.title.textContent = data.title;
  el.byChapter.classList.toggle("on", data.order === "chapter");
  el.byTimeline.classList.toggle("on", data.order === "timeline");
  // 時系列で並べられないときも、話数順は出す（6.39.2）
  el.byTimeline.disabled = !data.canTimeline;
  el.exportMd.disabled = data.sections.length === 0;

  renderCharacters();
  renderKinds();

  el.notice.textContent = data.notice;
  el.empty.textContent = data.sections.length === 0 ? data.emptyMessage : "";

  const html = [];
  for (const section of data.sections) {
    if (section.label) html.push("<h2>" + escapeHtml(section.label) + "</h2>");
    if (section.note) html.push("<p>" + escapeHtml(section.note) + "</p>");
    for (const group of section.groups) {
      if (group.label) html.push("<h3>" + escapeHtml(group.label) + "</h3>");
      html.push(renderTable(group.rows));
    }
  }
  el.sections.innerHTML = html.join("");
}

window.addEventListener("message", function (event) {
  const message = event.data;
  if (message && message.type === "chronicle") {
    data = message.data;
    render();
  }
});

// HTMLを流し込んだ直後は、まだこの script が走っていない。
// 受け手が居ることを知らせてから送ってもらう
post("ready");
</script>
</body>
</html>`;
}
