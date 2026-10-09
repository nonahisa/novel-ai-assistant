import { noteToneClasses } from "../core/sceneMemoRows";

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
 *
 * ## 作者の付箋とAIの指摘が、同じ一覧に並ぶ（設計書6.96.5）
 *
 * 並びは**話数 → 行**で、種類では分けない。**同じ行に何件来ても、
 * 場所は1度だけ出す**（`sameLine`）。どちらの行かは `kind` で分かれ、
 * 押せるものも分かれる——付箋は「済み」（本文から消す）、指摘は
 * 修正案があれば「直す」（拡張機能が提案パネルの［適用］と同じ関数で
 * 本文へ当てる。作者の裁定 2026-10-03）、無ければ「本文へ」（原稿のその行へ
 * 飛ぶ。作者の裁定 2026-10-04——以前は「提案へ」だった）と、「見送る」（記録を
 * 足す）である。修正案の無い推敲の指摘には「AIに相談」も出る（その行の
 * すぐ下に短い助言が出る。P-47。相談パネルへは「相談パネルで続ける」を押したときだけ）。提案パネルへ移る口は上の「提案パネル」1つだけ。**この画面は本文を直に書かない**
 * ——頼むだけで、当てるのも戻すのも拡張機能の側である。
 */
/**
 * 種類の印ごとの規則（`.tone-finding-typo { --note-color: … }` など）。
 *
 * 印の一覧は `core/sceneMemoRows.ts` の `noteToneClasses`（付箋と指摘の色の表）
 * から取る。色の値はここに書かない——拡張機能が `--novelai-<印>` として届ける
 */
function toneRules(): string {
  return noteToneClasses()
    .map((name) => `.tone-${name} { --note-color: var(--novelai-${name}); }`)
    .join("\n");
}

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
<title>校正・メモパネル</title>
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
/* ［直す］で当てた・［済み］で消した直近の1手と［戻す］（設計書6.96.5・6.40.4）。
   当てた指摘も済ませたメモも一覧から消えるので、戻す口は一覧の外のここに置く */
#fixed {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  border-bottom: 1px solid var(--vscode-panel-border);
}
#fixed[hidden] { display: none; }
#fixedText { flex: 1 1 auto; min-width: 0; overflow-wrap: break-word; }
/* ボタンは縮めない。縮められると、長い修正案のとき［戻す］が「戻／す」と縦に
   折れていた（実機確認リスト 95 の写真、2026-10-09）。狭いときは文のほうが折り返す */
#undoFix { flex: 0 0 auto; white-space: nowrap; }
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
  padding: 5px 12px 5px 9px;
  border-bottom: 1px solid var(--vscode-panel-border);
  /* 種類の色の細い帯（作者の要望 2026-10-04）。流し見で種類を拾うため */
  border-left: 3px solid var(--note-color, transparent);
}
/* 付箋は点線の帯。指摘と色相が近い種類（TODO の赤と誤字脱字の赤など）が
   あっても、作者が書いたものか機械が挙げたものかを形で見分けられる */
.memo.is-memo { border-left-style: dashed; }
/* 種類ごとの色の印（設計書6.96.5）。**規則は色の表から組む**——色の値は
   core（付箋は sceneMemo.ts、指摘は sceneMemoRows.ts）にだけ置き、拡張機能が
   --novelai-<印> として届ける。手で並べると、種類を足したときに規則が抜ける */
${toneRules()}
/* いまカーソルのある場所にいちばん近い付箋（設計書6.40.4）。
   **光らせるだけで、本文は動かさない** */
/* 色の決め方は原稿エディターの飛んだ行の光り（.mark-reveal）と同じ focusBorder。
   リストの選択色だと暗いテーマで灰色の帯になり、左の青い枠と結びつかなかった
   （作者の裁定 2026-10-10）。枠は内側に引く（行どうしが隣り合うため） */
.memo.active {
  background: rgba(0, 120, 215, 0.25);
  background: color-mix(in srgb, var(--vscode-focusBorder, #0078d4) 25%, transparent);
  outline: 2px solid var(--vscode-focusBorder, #0078d4);
  outline-offset: -2px;
}
.dot {
  flex: 0 0 auto;
  width: 8px;
  height: 8px;
  margin-top: 6px;
  border-radius: 50%;
  background: var(--note-color, var(--vscode-descriptionForeground));
}
/* 同じ行に続く2件目から。場所を繰り返さないので、**区切り線も引かない**
   ——線が入ると別の場所の指摘に見える（設計書6.96.5） */
.memo.same-line { padding-top: 0; }
.memo:has(+ .memo.same-line) { border-bottom: none; padding-bottom: 1px; }
.main { flex: 1 1 auto; min-width: 0; }
/* 指摘の理由。主文（直し方）より控えめに */
.note {
  display: block;
  margin-top: 2px;
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
  white-space: pre-wrap;
  overflow-wrap: break-word;
}
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
/* 上の button:hover:enabled が行の本文に灰色の四角を重ねていた。押した行の青い光りの
   中に灰色が混ざらないよう、行の本文は下線だけで示す（2026-10-10） */
.memo .go:hover:enabled { background: none; }
/* 種類の札。**字はそのまま残す**（色だけで見分けさせない）。地は塗らず、
   枠と字を種類の色にする——塗ると、明るいテーマの黄や緑の上で字が読めない */
.tag {
  display: inline-block;
  margin-right: 5px;
  padding: 0 4px;
  border-radius: 2px;
  font-size: 11px;
  border: 1px solid var(--note-color, var(--vscode-badge-background));
  color: var(--note-color, var(--vscode-badge-foreground));
}
/* 選び口で選んでいる種類の色。項目にも同じ印（● と字の色）を付ける */
select#tag { border-left: 3px solid var(--note-color, transparent); }
select#tag option { color: var(--note-color, var(--vscode-dropdown-foreground)); }
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
/* 押せるものは縦に積む。**幅を取らない**のが作者の指定なので、
   横へ並べると一覧の文が細くなる（設計書6.96.5） */
.acts {
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
/* ［AIに相談］の答え（P-47）。**押した指摘の行のすぐ下**に、小さく出す
   （作者の報告 2026-10-04「表示される位置が離れすぎています」） */
.advice {
  margin-top: 4px;
  padding: 4px 6px;
  font-size: 12px;
  border-left: 2px solid var(--note-color, var(--vscode-panel-border));
  background: var(--vscode-textBlockQuote-background, transparent);
  overflow-wrap: break-word;
}
.advice .point { display: block; }
.advice .examples { margin: 3px 0 0; padding-left: 1.2em; }
.advice .examples li { margin: 1px 0; }
.advice .from { color: var(--vscode-descriptionForeground); }
.advice .advice-acts {
  display: flex;
  gap: 6px;
  align-items: center;
  flex-wrap: wrap;
  margin-top: 4px;
}
.advice .advice-acts button { padding: 1px 8px; font-size: 11px; }
/* 「相談パネルで続ける」は控えめに（押したときだけ相談パネルへ渡す） */
.advice .linkish {
  background: none;
  padding: 0;
  color: var(--vscode-textLink-foreground);
  text-decoration: underline;
}
.advice .linkish:hover:enabled { background: none; }
.advice .muted { color: var(--vscode-descriptionForeground); }
</style>
</head>
<body>
<header>
  <h1 id="title">校正・メモパネル</h1>
  <div id="counts"></div>
  <div class="row-controls">
    <button id="prev" title="ひとつ前のメモへ飛びます（話をまたぎます）">← 戻る</button>
    <button id="next" title="次のメモへ飛びます（話をまたぎます）">次へ →</button>
    <button id="onlyCurrent" title="いま開いている話のメモだけを出します">この話だけ</button>
    <select id="tag" title="付箋のタグやAIの指摘の種類で絞り込みます"></select>
    <input type="search" id="query" placeholder="文字で探す">
    <button id="export" title="いま出ているメモをMarkdownで書き出します">書き出す</button>
    <button id="openProposals" hidden title="提案パネルを開きます（矛盾の再チェック・伏線として登録・まとめて適用など、提案パネルにしか無い操作はこちら）">提案パネル</button>
  </div>
</header>
<div id="notice"></div>
<div id="fixed" hidden>
  <span id="fixedText"></span>
  <button id="undoFix" title="直す前の本文へ戻します（指摘はまた一覧に並びます）">戻す</button>
</div>
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
  openProposals: document.getElementById("openProposals"),
  notice: document.getElementById("notice"),
  fixed: document.getElementById("fixed"),
  fixedText: document.getElementById("fixedText"),
  undoFix: document.getElementById("undoFix"),
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
el.openProposals.addEventListener("click", function () { post("openProposals"); });
el.undoFix.addEventListener("click", function () { post("undoFix"); });

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
  const act = target.dataset.act;
  if (act === "done") {
    // **1件ずつ確認しない**（設計書6.40.4）。付箋が消えても原稿は無傷で、
    // 取り消しは原稿エディタの Ctrl+Z か Git の復元でできる
    post("done", { filePath: row.filePath, line: row.line, raw: row.raw });
    return;
  }
  if (act === "fix") {
    // 修正案のある指摘（設計書6.96.5）。当てるのは拡張機能の側で、
    // 提案パネルの［適用］と同じ関数を通る。この画面は頼むだけ
    post("fix", { findingId: row.findingId });
    return;
  }
  if (act === "consult") {
    // 修正案の無い推敲の指摘。その行の下に短い助言を出す（拡張機能の側が
    // AIへ頼み、答えを一覧に添えて返す。この画面は頼むだけ）
    post("consult", { findingId: row.findingId });
    return;
  }
  if (act === "stopAdvice" || act === "closeAdvice" || act === "consultInChat") {
    post(act, { findingId: row.findingId });
    return;
  }
  if (act === "dismiss") {
    post("dismissFinding", { findingId: row.findingId });
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

  // 付箋のタグと、AIの指摘の種類が同じ一覧に並ぶ（設計書6.96.5）。
  // 項目ごとに、一覧の行と同じ色の印（● と字の色）を付ける（作者の要望 2026-10-04）
  const tones = data.tagTones || {};
  const options = ['<option value="">すべて</option>'];
  for (const tag of data.tags) {
    const tone = tones[tag] || "";
    options.push(
      '<option class="tone-' + escapeHtml(tone) + '" value="' + escapeHtml(tag) + '"' +
        (tag === data.tag ? " selected" : "") + ">" +
        (tone ? "● " : "") + escapeHtml(tag) + "</option>"
    );
  }
  el.tag.innerHTML = options.join("");
  // 選び口の枠にも、選んでいる種類の色を出す（「すべて」なら出さない）
  el.tag.className = data.tag && tones[data.tag] ? "tone-" + tones[data.tag] : "";
}

/**
 * 押せるものを組む。**付箋と指摘で違う**（設計書6.96.5）。
 *
 * 付箋は本文から消せる。指摘は、修正案があれば［直す］（拡張機能が
 * 提案パネルと同じ道で当てる）、無ければ［本文へ］（行の場所を押したときと
 * 同じ道で原稿のその行へ飛ぶ）、修正案の無い推敲には［AIに相談］、それと［見送る］。
 */
function renderActions(row) {
  const key = escapeHtml(row.key);
  if (row.kind === "finding") {
    const buttons = [];
    // 修正案があれば［直す］（1手で本文へ当てる）、無ければ［本文へ］。
    // ［本文へ］の data-act="reveal" は、下の受け口で行の場所を押したときと
    // 同じ「reveal」へ落ちる（飛ぶ道を1本にする。設計書6.25.11）
    if (row.fixAction === "apply") {
      buttons.push(
        '<button class="done" data-act="fix" data-key="' + key +
          '" title="修正案を本文へ当てます（上に出る［戻す］で元に戻せます）">直す</button>'
      );
    } else {
      buttons.push(
        '<button class="done" data-act="reveal" data-key="' + key +
          '" title="原稿のこの行へ飛びます（直し方は作者が決めます。本文は変わりません）">本文へ</button>'
      );
    }
    // 口が無ければ出さない（押しても何も起きない口を作らない）
    if (row.canConsult) {
      buttons.push(
        '<button class="done" data-act="consult" data-key="' + key +
          '" title="何が引っかかっているかと、その箇所の言い換え例を、この行のすぐ下に短く出します（推敲に割り当てたAIを使います。本文は変わりません）">AIに相談</button>'
      );
    }
    buttons.push(
      '<button class="done" data-act="dismiss" data-key="' + key +
        '" title="この指摘を見送ります（本文は変わりません）">見送る</button>'
    );
    return '<span class="acts">' + buttons.join("") + "</span>";
  }
  return '<button class="done" data-act="done" data-key="' + key +
    '" title="この行を本文から消します">済み</button>';
}

/**
 * 行のすぐ下に出す助言（P-47）。**中身は拡張機能が持ち、一覧に添えて届く**
 * ——画面は一覧のたびに作り直すので、ここに置くと消える。
 *
 * 考えている間は「考えています…」と［止める］。答えが出たら、何が引っかかって
 * いるか1文と言い換え例（「本文の部分 → 言い換え」）を小さく並べ、［閉じる］と
 * 「相談パネルで続ける」を1つずつ置く。言い換えは読むだけ（当てる口は無い）。
 */
function renderAdvice(row) {
  const advice = row.advice;
  if (!advice) return "";
  const key = escapeHtml(row.key);
  const close = '<button data-act="closeAdvice" data-key="' + key + '">閉じる</button>';
  if (advice.status === "thinking") {
    return '<div class="advice"><span class="muted">考えています…</span>' +
      '<div class="advice-acts"><button data-act="stopAdvice" data-key="' + key +
      '" title="AIへの問い合わせを止めます">止める</button></div></div>';
  }
  if (advice.status === "failed") {
    return '<div class="advice"><span class="muted">' + escapeHtml(advice.reason) +
      '</span><div class="advice-acts">' + close + "</div></div>";
  }
  const parts = [];
  if (advice.point) parts.push('<span class="point">' + escapeHtml(advice.point) + "</span>");
  if (advice.examples && advice.examples.length > 0) {
    const items = advice.examples.map(function (example) {
      return '<li><span class="from">「' + escapeHtml(example.from) + "」</span> → 「" +
        escapeHtml(example.to) + "」</li>";
    });
    parts.push('<ul class="examples">' + items.join("") + "</ul>");
  }
  const acts = [close];
  if (row.canConsultInChat) {
    acts.push(
      '<button class="linkish" data-act="consultInChat" data-key="' + key +
        '" title="この一文と指摘を、相談パネルへ渡して続けて相談します">相談パネルで続ける</button>'
    );
  }
  return '<div class="advice">' + parts.join("") +
    '<div class="advice-acts">' + acts.join("") + "</div></div>";
}

function renderRow(row) {
  const active = row.key === data.activeKey ? " active" : "";
  // **同じ行に続く2件目からは、場所を出さない**（設計書6.96.5）
  const same = row.sameLine ? " same-line" : "";
  const where = row.chapterLabel +
    (row.title ? " " + row.title : "") + "　" + row.line + "行目";
  // 種類の色の印。帯・札・丸の3つが、この印の色（--note-color）で塗られる
  const tone = " " + escapeHtml("tone-" + row.tagClass);
  const isMemo = row.kind === "memo" ? " is-memo" : "";
  return '<div class="memo' + tone + isMemo + active + same + '">' +
    '<span class="dot"></span>' +
    '<span class="main">' +
      '<button class="go" data-act="go" data-key="' + escapeHtml(row.key) + '">' +
        '<span class="tag">' + escapeHtml(row.tag) + "</span>" +
        escapeHtml(row.text || "（中身がありません）") +
        (row.note ? '<span class="note">' + escapeHtml(row.note) + "</span>" : "") +
        (row.sameLine
          ? ""
          : '<span class="where">' + escapeHtml(where) + "</span>") +
      "</button>" +
      renderAdvice(row) +
    "</span>" +
    renderActions(row) +
    "</div>";
}

function render() {
  if (!data) return;
  el.title.textContent = data.title;
  el.counts.textContent = data.countsLabel;
  el.notice.textContent = data.notice;
  // 戻せる直近の1手（［直す］か［済み］）。無ければ帯ごと隠す。
  // ボタンの説明は手の種類で変わるので、拡張機能から受け取る
  el.fixed.hidden = !data.fixed;
  el.fixedText.textContent = data.fixed ? data.fixed.text : "";
  if (data.fixed && data.fixed.undoTitle) el.undoFix.title = data.fixed.undoTitle;
  el.onlyCurrent.classList.toggle("on", data.onlyCurrent === true);
  el.onlyCurrent.disabled = !data.hasCurrent;
  el.prev.disabled = data.totalCount === 0;
  el.next.disabled = data.totalCount === 0;
  // **書き出すのは付箋だけ**（AIの指摘は作者が書いたものではない）。
  // 指摘しか出ていないときに押せると、空の1枚が開く
  el.exportMd.disabled = !data.hasMemosToExport;
  el.openProposals.hidden = data.canOpenProposals !== true;
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
