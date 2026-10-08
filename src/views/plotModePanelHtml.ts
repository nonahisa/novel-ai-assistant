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
 * 名前の候補（P-45）の欄だけは、人物の説明を1行ずつ添える。どの人物の
 * 候補かを見分けるための写しで、ここで書き換えることはできない。
 *
 * 押したことは拡張機能へ返すだけで、書き込みは向こうが既存の道
 * （`updatePlotMarkdown`・`createEpisodePlot`・既存コマンド）を通る。
 *
 * ## AIとの相談（P-01、設計書6.4.10）
 *
 * 作者が話しかける1行の入力欄を置く。**plot.md の中身を写す欄ではない**
 * （6.4.3 の原則は崩さない）——打った文は相談として送るだけで、プロットへは
 * 書かない。書き込み案の［この案をプロットに書く］は**案の番号だけ**を返し、
 * 何を書くかは拡張機能が控えた案で決める（画面から届いた文を書く道を作らない）。
 * 入力欄は複数行の欄にしない（`textarea` は「本文を書き換える欄」と紛れる）。
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
/* 予定の話（本文がまだ無い）。書いた話と見分けが付くように薄くする */
.episode.planned .head { font-style: italic; opacity: 0.85; }
.badge.planned {
  background: transparent;
  color: var(--vscode-descriptionForeground);
  border: 1px dashed var(--vscode-descriptionForeground);
}
#episodeActions { padding: 6px 12px 0; }
#episodeActions:empty { display: none; }
/* 単話プロットの「この話の目標」（設計書6.4.8）。1行で切る（拡張機能側でも切ってある） */
.episode .goal {
  display: block;
  margin-top: 2px;
  font-size: 11px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
/* 伏線の数（設計書6.35）。押すと伏線の一覧を開く */
.fs-counts {
  display: inline-block;
  margin-top: 2px;
  background: none;
  border: none;
  padding: 0;
  font-size: 11px;
  color: var(--vscode-textLink-foreground);
  cursor: pointer;
}
.fs-counts:hover { text-decoration: underline; background: none; }
/* 予定の話の並べ替え（↑↓・位置）。本文の行には出さない */
.move-btn { flex: 0 0 auto; font-size: 11px; padding: 2px 6px; }
/* 回収予定を過ぎた伏線。話の並びの上に1行だけ出す */
#overdue { padding: 4px 12px 0; }
#overdue:empty { display: none; }
/* 名前の候補（P-45）。人物ごとに1つ選ぶ */
#nameActions { padding: 4px 12px 0; }
#nameActions button { text-align: left; }
#nameResults { padding: 4px 12px 0; }
#nameResults:empty { display: none; }
.name-person {
  border: 1px solid var(--vscode-panel-border);
  border-radius: 2px;
  padding: 6px 8px;
  margin: 6px 0;
}
.name-person .role { font-weight: bold; }
.name-person .summary,
.name-person .unsure,
.name-person .empty {
  display: block;
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
  margin: 2px 0 4px;
}
.name-person label { display: block; padding: 1px 0; cursor: pointer; }
.name-person label .reading,
.name-person label .why { font-size: 11px; color: var(--vscode-descriptionForeground); }
.name-person details { font-size: 11px; color: var(--vscode-descriptionForeground); margin-top: 4px; }
#nameButtons { display: flex; gap: 6px; padding: 6px 0 0; }
#nameButtons .apply {
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
}
#nameButtons .apply:hover:enabled { background: var(--vscode-button-hoverBackground); }
/* AIとの相談（P-01）。会話の並び・入力・書き込み案 */
#advice[hidden] { display: none; }
#adviceLog { padding: 4px 12px 0; }
#adviceLog:empty { display: none; }
.advice-turn { margin: 6px 0; }
.advice-turn .who {
  display: block;
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
}
.advice-turn .text { white-space: pre-wrap; overflow-wrap: break-word; }
.advice-turn.author .text { color: var(--vscode-descriptionForeground); }
.advice-turn.failed .text { color: var(--vscode-errorForeground, var(--vscode-descriptionForeground)); }
.advice-suggestion {
  border: 1px solid var(--vscode-panel-border);
  border-radius: 2px;
  padding: 6px 8px;
  margin-top: 4px;
}
.advice-suggestion .field { font-weight: bold; }
.advice-suggestion .value { white-space: pre-wrap; overflow-wrap: break-word; margin: 4px 0; }
.advice-suggestion .caution {
  display: block;
  font-size: 11px;
  color: var(--vscode-editorWarning-foreground, var(--vscode-descriptionForeground));
}
.advice-suggestion .done { font-size: 11px; color: var(--vscode-descriptionForeground); }
.advice-buttons { display: flex; gap: 6px; padding-top: 4px; }
.advice-buttons .apply,
#adviceSend {
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
}
.advice-buttons .apply:hover:enabled,
#adviceSend:hover:enabled { background: var(--vscode-button-hoverBackground); }
#adviceForm { display: flex; gap: 4px; padding: 6px 12px 0; }
#adviceInput {
  flex: 1 1 auto;
  min-width: 0;
  padding: 3px 6px;
  font: inherit;
  color: var(--vscode-input-foreground);
  background: var(--vscode-input-background);
  border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
}
#adviceStatus { padding: 2px 12px 0; font-size: 11px; color: var(--vscode-descriptionForeground); }
#adviceStatus:empty { display: none; }
#overdue button {
  background: none;
  border: 1px solid var(--vscode-editorWarning-foreground, var(--vscode-descriptionForeground));
  color: var(--vscode-editorWarning-foreground, inherit);
  font-size: 12px;
}
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
  <div id="advice" hidden>
    <h2>AIと相談しながら組み立てる</h2>
    <div class="note">考えていることを書いて送ると、AIが編集者として問いを返します（AIを使う）。プロットへの書き込み案が出たときは、［この案をプロットに書く］を押したときだけ書きます。会話はこの画面を閉じると消えます。</div>
    <div id="adviceLog"></div>
    <div id="adviceStatus"></div>
    <div id="adviceForm">
      <input id="adviceInput" type="text" placeholder="例：主人公をどう動かすか迷っています" aria-label="AIに相談する文">
      <button id="adviceSend" title="打った文をAIに送ります">送る</button>
      <button id="adviceStop" title="答えを待つのをやめます" disabled>止める</button>
      <button id="adviceClear" title="この画面の会話を消します（プロットは変わりません）">会話を消す</button>
    </div>
  </div>
  <h2 id="namesHeading">主要登場人物の名前</h2>
  <div id="nameActions"></div>
  <div class="note" id="namesNote"></div>
  <div id="nameResults"></div>
  <h2 id="episodesHeading">話の並び</h2>
  <div class="note" id="episodesNote"></div>
  <div id="overdue"></div>
  <div id="episodes"></div>
  <div id="episodeActions"></div>
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
  episodeActions: document.getElementById("episodeActions"),
  overdue: document.getElementById("overdue"),
  namesHeading: document.getElementById("namesHeading"),
  nameActions: document.getElementById("nameActions"),
  namesNote: document.getElementById("namesNote"),
  nameResults: document.getElementById("nameResults"),
  advice: document.getElementById("advice"),
  adviceLog: document.getElementById("adviceLog"),
  adviceStatus: document.getElementById("adviceStatus"),
  adviceInput: document.getElementById("adviceInput"),
  adviceSend: document.getElementById("adviceSend"),
  adviceStop: document.getElementById("adviceStop"),
  adviceClear: document.getElementById("adviceClear"),
};

/** 名前の候補（P-45）。目録とは別に届く——目録の読み直しで選びかけを消さない */
let names = { status: "idle", note: "", people: [] };

/**
 * AIとの相談（P-01）。これも目録とは別に届く——保存のたびの読み直しで、
 * 会話の並びや打ちかけの文を消さない。null なら相談の欄を出さない
 */
let advice = null;

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
  // 伏線の数は、伏線の一覧を開く（行の本文を開く道より先に見る）
  if (event.target.closest(".fs-counts")) {
    post("openForeshadows");
    return;
  }
  const target = event.target.closest("[data-path]");
  if (!target) return;
  const chapter = target.dataset.chapter === "" ? null : Number(target.dataset.chapter);
  /*
    予定の話の並べ替え・差し込み（設計書6.4.8）。押したことを返すだけで、
    どう付け替えるかは拡張機能が決め、確認を取ってから単話プロットの
    名前だけを変える（本文のファイルには触れない）
  */
  if (target.classList.contains("move-up")) {
    post("movePlanned", { chapter: chapter, direction: "up" });
    return;
  }
  if (target.classList.contains("move-down")) {
    post("movePlanned", { chapter: chapter, direction: "down" });
    return;
  }
  if (target.classList.contains("move-to")) {
    post("insertPlanned", { chapter: chapter });
    return;
  }
  if (target.classList.contains("create-plot")) {
    post("createEpisodePlot", { chapter: chapter });
    return;
  }
  if (target.classList.contains("open-plot")) {
    post("openEpisodePlot", { chapter: chapter });
    return;
  }
  if (target.classList.contains("check-plot")) {
    post("checkEpisodePlot", { chapter: chapter, check: target.dataset.check });
    return;
  }
  post("openEpisode", { filePath: target.dataset.path });
});

/**
 * 予定の話を足す（設計書6.4.8）。押したことを返すだけで、何話目か・題は
 * 拡張機能が訊き、書くのは単話プロットだけ（本文のファイルは作らない）
 */
el.overdue.addEventListener("click", function (event) {
  if (!event.target.closest("[data-overdue]")) return;
  post("openForeshadows");
});

el.episodeActions.addEventListener("click", function (event) {
  const target = event.target.closest("[data-add-planned]");
  if (!target) return;
  post("addPlannedEpisode");
});

/**
 * 名前の候補（P-45）。押したことと選んだ名前を返すだけで、
 * 書くのは拡張機能（控えと照らし合わせてから plot.md と承認待ちへ）
 */
el.nameActions.addEventListener("click", function (event) {
  if (!event.target.closest("[data-suggest-names]")) return;
  post("suggestNames");
});

el.nameResults.addEventListener("click", function (event) {
  if (event.target.closest("[data-clear-names]")) {
    post("clearNames");
    return;
  }
  if (!event.target.closest("[data-apply-names]")) return;
  const picks = [];
  for (const person of names.people) {
    const checked = el.nameResults.querySelector(
      'input[name="name-' + person.id + '"]:checked'
    );
    if (checked && checked.value !== "") {
      picks.push({ id: person.id, name: checked.value });
    }
  }
  post("applyNames", { picks: picks });
});

/**
 * AIとの相談（P-01）。打った文を送るだけで、プロットへは書かない。
 * 書き込み案は**番号だけ**を返す（何を書くかは拡張機能が控えた案で決める）
 */
function sendAdvice() {
  if (!advice || advice.status === "busy") return;
  const text = el.adviceInput.value.trim();
  if (!text) return;
  post("adviceSend", { text: text });
  el.adviceInput.value = "";
}

el.adviceSend.addEventListener("click", sendAdvice);

el.adviceInput.addEventListener("keydown", function (event) {
  if (event.key !== "Enter") return;
  // **日本語の変換を確定する Enter では送らない**（変換中の Enter は確定の操作）
  if (event.isComposing || event.keyCode === 229) return;
  event.preventDefault();
  sendAdvice();
});

el.adviceStop.addEventListener("click", function () {
  post("adviceStop");
});

el.adviceClear.addEventListener("click", function () {
  post("adviceClear");
});

el.adviceLog.addEventListener("click", function (event) {
  const apply = event.target.closest("[data-advice-apply]");
  if (apply) {
    post("adviceApply", { id: apply.dataset.adviceApply });
    return;
  }
  const dismiss = event.target.closest("[data-advice-dismiss]");
  if (dismiss) post("adviceDismiss", { id: dismiss.dataset.adviceDismiss });
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
  // 予定の話は単話プロットそのものなので、「単話プロット」の印は重ねない
  const plotBadge = row.planned
    ? '<span class="badge planned">予定</span>'
    : row.hasEpisodePlot
      ? '<span class="badge">単話プロット</span>'
      : "";
  const charsText = row.conflicted
    ? "競合あり（数えていません）"
    : row.hasManuscript
      ? row.chars + "字"
      : "本文はまだありません";
  const sub = [charsText];
  if (row.synopsisHead) sub.push(escapeHtml(row.synopsisHead));
  // 単話プロットの「この話の目標」。空・問いかけのままなら届かない
  const goal = row.goalHead
    ? '<span class="goal" title="単話プロットの「この話の目標」">目標：' +
      escapeHtml(row.goalHead) + "</span>"
    : "";
  // 伏線の数（設計書6.35）。**0 は出さない**
  const counts = row.foreshadowCounts || {};
  const fs = [];
  if (counts.planted > 0) fs.push("張った伏線 " + counts.planted);
  if (counts.resolved > 0) fs.push("回収した伏線 " + counts.resolved);
  if (counts.planned > 0) fs.push("回収予定 " + counts.planned);
  const fsLine = fs.length > 0
    ? '<button class="fs-counts" title="伏線の一覧を開きます">' +
      escapeHtml(fs.join("／")) + "</button>"
    : "";

  let button = "";
  if (row.planned) {
    // 行そのものを押すと単話プロットが開くので、同じボタンを横に並べない。
    // 代わりに、予定の話だけ並べ替えの3つを置く（本文のある話は動かせない）
    const attrs = ' data-path="' + escapeHtml(row.filePath) +
      '" data-chapter="' + escapeHtml(chapterAttr) + '"';
    button =
      '<button class="move-btn move-up"' + attrs +
        ' title="1つ前へ動かします（単話プロットの話数だけを付け替えます）">↑</button>' +
      '<button class="move-btn move-down"' + attrs +
        ' title="1つ後ろへ動かします（単話プロットの話数だけを付け替えます）">↓</button>' +
      '<button class="move-btn move-to"' + attrs +
        ' title="話数を指定して差し込みます（本文のある話数へは動かせません）">位置</button>';
  } else if (row.hasEpisodePlot) {
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

  // 単話プロットのAI判定（設計書6.36.3）。**出せるものだけが届く**
  // ——押しても何も起きないボタンは、拡張機能側で落としてある
  for (const entry of row.checks || []) {
    button +=
      '<button class="plot-btn check-plot" data-path="' + escapeHtml(row.filePath) +
      '" data-chapter="' + escapeHtml(chapterAttr) +
      '" data-check="' + escapeHtml(entry.check) +
      '" title="' + escapeHtml(entry.detail) + '">' +
      escapeHtml(entry.label) + "</button>";
  }

  // 予定の話は本文が無い。押すと単話プロットを開く（open-plot として返す）
  const mainClass = row.planned ? "open-body open-plot" : "open-body";
  const mainTitle = row.planned
    ? "この話の単話プロットを開きます（本文はまだありません）"
    : "この話を開きます";
  return '<div class="episode' + (row.planned ? " planned" : "") + '">' +
    '<span class="main">' +
      '<button class="' + mainClass + '" data-path="' + escapeHtml(row.filePath) +
        '" data-chapter="' + escapeHtml(chapterAttr) + '" title="' + mainTitle + '">' +
        '<span class="head">' + escapeHtml(row.label) +
          (row.title ? "　" + escapeHtml(row.title) : "") + plotBadge + "</span>" +
        '<span class="sub">' + sub.join("　") + "</span>" +
        goal +
      "</button>" +
      fsLine +
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

  el.overdue.innerHTML = data.overdue
    ? '<button data-overdue="1" title="' + escapeHtml(data.overdue.detail) + '">' +
      escapeHtml(data.overdue.label) + "</button>"
    : "";

  el.episodeActions.innerHTML = data.addPlanned
    ? '<button data-add-planned="1" title="' + escapeHtml(data.addPlanned.detail) +
      '">' + escapeHtml(data.addPlanned.label) + "</button>"
    : "";
}

/**
 * 相談の会話を描く（P-01）。入力欄はここでは作り直さない（打ちかけの文を消さない）。
 * 書き込み案は、まだ決めていないものにだけボタンを出す
 */
function renderAdvice() {
  if (!advice) {
    el.advice.hidden = true;
    return;
  }
  el.advice.hidden = false;
  const busy = advice.status === "busy";
  el.adviceSend.disabled = busy;
  el.adviceStop.disabled = !busy;
  el.adviceClear.disabled = busy || advice.turns.length === 0;
  el.adviceStatus.textContent = busy ? "AIが答えを考えています…" : "";

  const html = [];
  for (const turn of advice.turns) {
    const who = turn.role === "author" ? "あなた" : "AI";
    let card = "";
    const s = turn.suggestion;
    if (s) {
      const cautions = [];
      if (s.overwrites) {
        cautions.push("いま書いてある文を置き換える案です（書く前に確認します）。");
      }
      if (!s.grounded) {
        cautions.push("あなたの発言に無い言葉が多い案です。確かめてから採ってください。");
      }
      let foot = "";
      if (s.state === "open") {
        foot =
          '<div class="advice-buttons">' +
            '<button class="apply" data-advice-apply="' + escapeHtml(s.id) +
              '" title="この1項目だけをプロットに書きます">この案をプロットに書く</button>' +
            '<button data-advice-dismiss="' + escapeHtml(s.id) +
              '" title="何も書きません">採らない</button>' +
          "</div>";
      } else {
        foot = '<span class="done">' +
          (s.state === "written" ? "プロットに書きました。" : "採りませんでした。") +
          "</span>";
      }
      card =
        '<div class="advice-suggestion">' +
          '<span class="field">書き込み案：' + escapeHtml(s.heading) + "</span>" +
          '<div class="value">' + escapeHtml(s.value) + "</div>" +
          cautions.map(function (text) {
            return '<span class="caution">' + escapeHtml(text) + "</span>";
          }).join("") +
          foot +
        "</div>";
    }
    html.push(
      '<div class="advice-turn ' + (turn.role === "author" ? "author" : "assistant") +
        (turn.failed ? " failed" : "") + '">' +
        '<span class="who">' + who + "</span>" +
        '<div class="text">' + escapeHtml(turn.text) + "</div>" +
        card +
      "</div>"
    );
  }
  el.adviceLog.innerHTML = html.join("");
}

/**
 * 名前の候補（P-45）。人物ごとに「選ばない」を先頭に置き、既定はそれにする
 * ——選ばずに［入れる］を押しても、その人物には何も書かない
 */
function renderNames() {
  const labels = (data && data.nameSuggest) || null;
  if (labels) {
    el.namesHeading.textContent = labels.heading;
    el.nameActions.innerHTML =
      '<button data-suggest-names="1" title="' + escapeHtml(labels.detail) + '"' +
      (names.status === "busy" ? " disabled" : "") + ">" +
      escapeHtml(labels.label) + "</button>";
  }
  el.namesNote.textContent = names.note || "";
  if (names.status !== "ready" || !labels) {
    el.nameResults.innerHTML = "";
    return;
  }

  const html = [];
  for (const person of names.people) {
    const group = "name-" + person.id;
    const rows = [
      '<label><input type="radio" name="' + escapeHtml(group) + '" value="" checked> ' +
        escapeHtml(labels.none) + "</label>",
    ];
    for (const candidate of person.candidates) {
      rows.push(
        '<label><input type="radio" name="' + escapeHtml(group) + '" value="' +
          escapeHtml(candidate.name) + '"> ' + escapeHtml(candidate.name) +
          ' <span class="reading">（' + escapeHtml(candidate.reading) + "）</span>" +
          (candidate.note ? ' <span class="why">' + escapeHtml(candidate.note) + "</span>" : "") +
        "</label>"
      );
    }
    const dropped = person.dropped.length > 0
      ? "<details><summary>" + escapeHtml(labels.droppedLabel) + " " +
        person.dropped.length + "件</summary>" +
        person.dropped.map(function (entry) {
          return "<div>" + escapeHtml(entry.name) + "：" + escapeHtml(entry.reason) + "</div>";
        }).join("") + "</details>"
      : "";
    html.push(
      '<div class="name-person">' +
        '<span class="role">' + escapeHtml(person.role) + "</span>" +
        (person.summary ? '<span class="summary">' + escapeHtml(person.summary) + "</span>" : "") +
        (person.unsure ? '<span class="unsure">' + escapeHtml(person.unsure) + "</span>" : "") +
        (person.ledger ? '<span class="unsure">' + escapeHtml(person.ledger) + "</span>" : "") +
        rows.join("") +
        (person.candidates.length === 0
          ? '<span class="empty">使える候補が残りませんでした。もう一度出すと、違う候補が出ます。</span>'
          : "") +
        dropped +
      "</div>"
    );
  }
  html.push(
    '<div id="nameButtons">' +
      '<button class="apply" data-apply-names="1">' + escapeHtml(labels.apply) + "</button>" +
      '<button data-clear-names="1">' + escapeHtml(labels.clear) + "</button>" +
    "</div>"
  );
  el.nameResults.innerHTML = html.join("");
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
  // 候補の欄は、目録の読み直しでは作り直さない（選びかけの丸が消える）。
  // 入口のボタンだけ最新の文言にする
  if (names.status !== "ready") renderNames();
  else if (data.nameSuggest && !el.nameActions.firstChild) renderNames();
}

window.addEventListener("message", function (event) {
  const message = event.data;
  if (!message) return;
  if (message.type === "plotNames") {
    names = message.data || { status: "idle", note: "", people: [] };
    renderNames();
    return;
  }
  if (message.type === "plotAdvice") {
    advice = message.data || null;
    renderAdvice();
    return;
  }
  if (message.type !== "plotMode") return;
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
