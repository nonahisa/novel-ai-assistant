import { escapeHtml } from "../core/htmlEscape";
import { reportFocusWithoutPointerScript } from "./focusReportScript";

/**
 * 編集者モードの「作者の採否」パネル（作者の答え 2026-11-07「閉じないパネルにする」。設計書5.7.5.9）。
 *
 * 0.135.0 までは一覧を QuickPick で出していたので、本文の場所へ飛ぶと一覧が閉じ、
 * 本文と見比べながら1件ずつ見られなかった。横に残るパネルにして、行を押しても閉じないようにする。
 *
 * **行の中身は QuickPick のときと同じ**（`proposalListRows` の label・description・detail を
 * そのまま受け取る）。言い方を2か所で持つと、片方だけ変わる日が来る。
 * ここは VS Code に依らない（単体テストで中身を確かめるため）。
 */

/** パネルの1行。`proposalListRows` の行から、画面に要る分だけを写したもの */
export interface AuthorDecisionRowHtml {
  label: string;
  description: string;
  detail: string;
  /** 左の線の色分けに使う（文字の印に加えて色でも見分けられるように） */
  kind: "accepted" | "rejected" | "read";
}

/** 行を押したときに WebView から拡張機能へ送る通信。`index` は並べた行の何番目か */
export interface AuthorDecisionsOpenMessage {
  type: "open";
  index: number;
}

/** WebView から届いたものが「行を押した」かを確かめる（届くものは信用しない） */
export function isOpenMessage(message: unknown): message is AuthorDecisionsOpenMessage {
  if (typeof message !== "object" || message === null) return false;
  const record = message as { type?: unknown; index?: unknown };
  return (
    record.type === "open" &&
    typeof record.index === "number" &&
    Number.isInteger(record.index) &&
    record.index >= 0
  );
}

export function buildAuthorDecisionsHtml(
  nonce: string,
  cspSource: string,
  heading: string,
  rows: readonly AuthorDecisionRowHtml[]
): string {
  /*
    本文の語・作者のひと言は作者と編集者が書いたものなので、**必ず逃がしてから** HTML に入れる。
    行の番号だけを data-index に持たせ、押されたら番号を送る（語そのものを台本へ渡さない）
  */
  const items = rows
    .map(
      (row, index) =>
        `<li><button type="button" class="row ${row.kind}" data-index="${index}">` +
        `<span class="label">${escapeHtml(row.label)}</span>` +
        `<span class="where">${escapeHtml(row.description)}</span>` +
        `<span class="detail">${escapeHtml(row.detail)}</span>` +
        `</button></li>`
    )
    .join("\n");

  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
body {
  font-family: var(--vscode-font-family);
  color: var(--vscode-foreground);
  background: var(--vscode-editor-background);
  padding: 12px 14px;
  font-size: 13px;
  margin: 0;
  overflow-x: hidden;
}
h1 { font-size: 14px; margin: 0 0 4px; }
.subtitle { color: var(--vscode-descriptionForeground); margin: 0 0 10px; font-size: 12px; }
ul { list-style: none; margin: 0; padding: 0; }
li { margin: 0 0 6px; }
/* 行は押せるボタン。幅が狭くても横へはみ出さないよう、折り返して全幅に収める */
.row {
  display: block;
  width: 100%;
  box-sizing: border-box;
  text-align: left;
  font: inherit;
  color: inherit;
  background: transparent;
  border: none;
  border-left: 3px solid var(--vscode-panel-border, rgba(128,128,128,0.35));
  padding: 5px 8px;
  cursor: pointer;
  overflow-wrap: anywhere;
  word-break: break-word;
}
.row:hover { background: var(--vscode-list-hoverBackground); }
.row:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
/* 見た行が分かるように、最後に押した行へ印を付ける */
.row.current { background: var(--vscode-list-inactiveSelectionBackground); }
.row.accepted { border-left-color: var(--vscode-charts-green, #6a8f3d); }
.row.rejected { border-left-color: var(--vscode-charts-red, var(--vscode-errorForeground)); }
.row.read { border-left-color: var(--vscode-charts-blue, var(--vscode-focusBorder)); }
.label { display: block; font-weight: 600; }
.where {
  display: block;
  color: var(--vscode-descriptionForeground);
  font-size: 11px;
  margin-top: 1px;
}
.detail {
  display: block;
  color: var(--vscode-descriptionForeground);
  font-size: 12px;
  margin-top: 2px;
  white-space: pre-wrap;
}
</style>
</head>
<body>
<h1>${escapeHtml(heading)}</h1>
<p class="subtitle">行を押すと、本文のその場所を開きます。このパネルは閉じません。</p>
<ul id="rows">
${items}
</ul>
<script nonce="${nonce}">
(function () {
  const vscode = acquireVsCodeApi();
  ${reportFocusWithoutPointerScript("vscode")}
  const list = document.getElementById("rows");
  list.addEventListener("click", function (event) {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const button = target.closest("button.row");
    if (!button) return;
    const index = Number(button.getAttribute("data-index"));
    if (!Number.isInteger(index)) return;
    list.querySelectorAll("button.row.current").forEach(function (other) {
      other.classList.remove("current");
    });
    button.classList.add("current");
    vscode.postMessage({ type: "open", index: index });
  });
})();
</script>
</body>
</html>`;
}
