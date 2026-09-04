/**
 * プロットモードのパネル（設計書6.4.8）。
 *
 * シーンメモ・年表・執筆量パネルと同じ作りにしてある——外部ライブラリを
 * 使わず、値はすべて `postMessage` で渡し、HTMLへ文字列として埋め込まない
 * （作品名や見出しに引用符や `<` が入ると画面が壊れるため）。
 *
 * ## この画面は plot.md の中身を持たない
 *
 * **文書を欄に閉じ込めない**（設計書6.4.3）。ここに出るのは
 * 「どこに何があるか」——節の目次・まだ立てていない見出しの名前・
 * 話の見取り図——だけで、書くのは左に開いた普通のエディタである。
 * 中身を写す欄（`textarea`）を置いた時点で、この機能は記入用紙に戻る。
 *
 * 押したことは拡張機能へ返すだけで、書き込みは向こうが既存の道
 * （`updatePlotMarkdown`・`createEpisodePlot`・既存コマンド）を通る。
 */
export function buildPlotModePanelHtml(
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
<title>プロットモード</title>
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
h1 { font-size: 1.05em; margin: 0 0 2px; }
#where { color: var(--vscode-descriptionForeground); font-size: 12px; }
#notice {
  padding: 6px 12px;
  color: var(--vscode-descriptionForeground);
  border-bottom: 1px solid var(--vscode-panel-border);
}
#notice:empty { display: none; }
#body { flex: 1; min-height: 0; overflow: auto; padding: 0 0 32px; }
h2 {
  font-size: 0.9em;
  margin: 14px 0 4px;
  padding: 0 12px 3px;
  color: var(--vscode-descriptionForeground);
  border-bottom: 1px solid var(--vscode-panel-border);
}
.note {
  padding: 2px 12px 4px;
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
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
/* 目次。押すと左のエディタのその行へ飛ぶ（片方向。本文は書き換えない） */
.jump {
  display: block;
  width: 100%;
  background: none;
  border: none;
  border-bottom: 1px solid var(--vscode-panel-border);
  padding: 5px 12px;
  text-align: left;
  font: inherit;
  color: inherit;
  cursor: pointer;
}
.jump:hover { background: var(--vscode-list-hoverBackground); }
.jump .line {
  float: right;
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
}
/* 作者が自分で立てた見出しは、決まった項目と見分けが付くようにする */
.jump.own .name { font-style: italic; }
#candidates { display: flex; flex-wrap: wrap; gap: 4px; padding: 4px 12px 0; }
#candidates button { opacity: 0.7; font-size: 12px; padding: 2px 8px; }
#candidates button:hover { opacity: 1; }
#aiActions { display: flex; flex-direction: column; gap: 4px; padding: 4px 12px 0; }
#aiActions button { text-align: left; }
/* AIを使わない入口。同じ並びに置くが、見分けが付くように薄くする */
#syncActions { display: flex; flex-direction: column; gap: 4px; padding: 4px 12px 0; }
#syncActions button { text-align: left; opacity: 0.85; }
.episode {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  padding: 5px 12px;
  border-bottom: 1px solid var(--vscode-panel-border);
}
.episode .main { flex: 1 1 auto; min-width: 0; }
.episode .head { display: block; }
.episode .sub {
  display: block;
  margin-top: 2px;
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
  overflow-wrap: break-word;
}
.chapter {
  padding: 10px 12px 2px;
  font-size: 12px;
  color: var(--vscode-descriptionForeground);
}
.badge {
  display: inline-block;
  margin-left: 5px;
  padding: 0 5px;
  border-radius: 2px;
  font-size: 11px;
  background: var(--vscode-badge-background);
  color: var(--vscode-badge-foreground);
}
.badge.empty { background: transparent; color: var(--vscode-descriptionForeground); }
.open-body {
  display: block;
  width: 100%;
  background: none;
  border: none;
  padding: 0;
  text-align: left;
  font: inherit;
  color: inherit;
  cursor: pointer;
}
.open-body:hover { text-decoration: underline; }
.plot-btn { flex: 0 0 auto; font-size: 11px; padding: 2px 8px; }
</style>
</head>
<body>
<header>
  <h1 id="title">プロットモード</h1>
  <div id="where"></div>
</header>
<div id="notice"></div>
<div id="body">
  <h2>プロットの節</h2>
  <div class="note" id="headingsNote"></div>
  <div id="headings"></div>
  <div id="candidates"></div>
  <h2>AIに頼む</h2>
  <div id="aiActions"></div>
  <div id="syncActions"></div>
  <h2 id="episodesHeading">話の並び</h2>
  <div class="note" id="episodesNote"></div>
  <div id="episodes"></div>
</div>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();

/** 拡張機能から届いた目録。画面はこれを描くだけで、作り替えはしない */
let data = null;

const el = {
  title: document.getElementById("title"),
  where: document.getElementById("where"),
  notice: document.getElementById("notice"),
  headings: document.getElementById("headings"),
  headingsNote: document.getElementById("headingsNote"),
  candidates: document.getElementById("candidates"),
  aiActions: document.getElementById("aiActions"),
  syncActions: document.getElementById("syncActions"),
  episodes: document.getElementById("episodes"),
  episodesHeading: document.getElementById("episodesHeading"),
  episodesNote: document.getElementById("episodesNote"),
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

/**
 * 押されたものを拡張機能へ返す。
 *
 * 一覧は届くたびに作り直すので、1つずつ耳を付けると付け直しが要る。
 * 外側で受けて、押されたものを見る（シーンメモと同じ作り）
 */
el.headings.addEventListener("click", function (event) {
  const target = event.target.closest("[data-line]");
  if (!target) return;
  post("reveal", { line: Number(target.dataset.line) });
});

el.candidates.addEventListener("click", function (event) {
  const target = event.target.closest("[data-key]");
  if (!target) return;
  post("addSection", { key: target.dataset.key });
});

el.aiActions.addEventListener("click", function (event) {
  const target = event.target.closest("[data-command]");
  if (!target) return;
  post("command", { command: target.dataset.command });
});

/**
 * AIを使わない入口（いまは「プロットの人物を資料へ反映」だけ）。
 *
 * 押したことを伝えるだけで、読み書きは向こうが既存の道
 * （承認待ちへ積む）を通る。ここでは資料も plot.md も書き換えない
 */
el.syncActions.addEventListener("click", function (event) {
  const target = event.target.closest("[data-action]");
  if (!target) return;
  post(target.dataset.action);
});

el.episodes.addEventListener("click", function (event) {
  const target = event.target.closest("[data-path]");
  if (!target) return;
  const chapter = target.dataset.chapter === "" ? null : Number(target.dataset.chapter);
  if (target.classList.contains("create-plot")) {
    post("createEpisodePlot", { chapter: chapter });
    return;
  }
  if (target.classList.contains("open-plot")) {
    post("openEpisodePlot", { chapter: chapter });
    return;
  }
  post("openEpisode", { filePath: target.dataset.path });
});

function renderHeadings() {
  const html = [];
  for (const entry of data.headings) {
    html.push(
      '<button class="jump' + (entry.key ? "" : " own") + '" data-line="' +
        escapeHtml(entry.line) + '" title="この節へ移動します">' +
        '<span class="line">' + escapeHtml(entry.line) + "行目</span>" +
        '<span class="name">' + escapeHtml(entry.heading) + "</span>" +
      "</button>"
    );
  }
  el.headings.innerHTML = html.join("");

  const candidates = [];
  for (const entry of data.candidates) {
    candidates.push(
      '<button data-key="' + escapeHtml(entry.key) + '" title="' +
        escapeHtml(entry.title) + '">+ ' + escapeHtml(entry.heading) + "</button>"
    );
  }
  el.candidates.innerHTML = candidates.join("");
}

function renderAiActions() {
  const html = [];
  for (const entry of data.aiActions) {
    html.push(
      '<button data-command="' + escapeHtml(entry.command) + '" title="' +
        escapeHtml(entry.detail) + '">' + escapeHtml(entry.label) + "</button>"
    );
  }
  el.aiActions.innerHTML = html.join("");

  const sync = [];
  for (const entry of data.syncActions || []) {
    sync.push(
      '<button data-action="' + escapeHtml(entry.action) + '" title="' +
        escapeHtml(entry.detail) + '">' + escapeHtml(entry.label) + "</button>"
    );
  }
  el.syncActions.innerHTML = sync.join("");
}

function renderEpisode(row) {
  const chapterAttr = row.chapter === null ? "" : String(row.chapter);
  const plotBadge = row.hasEpisodePlot
    ? '<span class="badge">単話プロット</span>'
    : "";
  const charsText = row.conflicted
    ? "競合あり（数えていません）"
    : row.hasManuscript
      ? row.chars + "字"
      : "本文はまだありません";
  const sub = [charsText];
  if (row.synopsisHead) sub.push(escapeHtml(row.synopsisHead));

  let button = "";
  if (row.hasEpisodePlot) {
    button =
      '<button class="plot-btn open-plot" data-path="' + escapeHtml(row.filePath) +
      '" data-chapter="' + escapeHtml(chapterAttr) +
      '" title="この話の単話プロットを開きます">プロット</button>';
  } else if (row.canCreateEpisodePlot) {
    button =
      '<button class="plot-btn create-plot" data-path="' + escapeHtml(row.filePath) +
      '" data-chapter="' + escapeHtml(chapterAttr) +
      '" title="視点・目標・展開の雛形を作って開きます（AIは書きません）">単話プロットを作る</button>';
  }

  return '<div class="episode">' +
    '<span class="main">' +
      '<button class="open-body" data-path="' + escapeHtml(row.filePath) +
        '" data-chapter="' + escapeHtml(chapterAttr) + '" title="この話を開きます">' +
        '<span class="head">' + escapeHtml(row.label) +
          (row.title ? "　" + escapeHtml(row.title) : "") + plotBadge + "</span>" +
        '<span class="sub">' + sub.join("　") + "</span>" +
      "</button>" +
    "</span>" +
    button +
  "</div>";
}

function renderEpisodes() {
  const html = [];
  let chapterName = null;
  for (const row of data.episodes) {
    if (row.chapterName !== chapterName) {
      chapterName = row.chapterName;
      if (chapterName) {
        html.push('<div class="chapter">' + escapeHtml(chapterName) + "</div>");
      }
    }
    html.push(renderEpisode(row));
  }
  el.episodes.innerHTML =
    html.length > 0 ? html.join("") : '<div class="note">' +
      escapeHtml(data.emptyEpisodes) + "</div>";
}

function render() {
  if (!data) return;
  el.title.textContent = data.title;
  el.where.textContent = data.where;
  el.notice.textContent = data.notice;
  el.headingsNote.textContent = data.headingsNote;
  el.episodesHeading.textContent = data.episodesHeading;
  el.episodesNote.textContent = data.episodesNote;
  renderHeadings();
  renderAiActions();
  renderEpisodes();
}

window.addEventListener("message", function (event) {
  const message = event.data;
  if (!message || message.type !== "plotMode") return;
  data = message.data;
  render();
});

// HTMLを流し込んだ直後は、まだこの script が走っていない。
// 受け手が居ることを知らせてから送ってもらう
post("ready");
</script>
</body>
</html>`;
}
