import * as vscode from "vscode";
import { listenForFocusWithoutPointer } from "../views/pickerFocus";
import * as path from "../core/paths";
import type { WorkEntry } from "../models/types";
import {
  describeDecisionCounts,
  isOpinionOnly,
  summarizeDecisions,
  type ProposalView,
} from "../models/proposal";
import { createNonce } from "../core/webviewNonce";
import {
  buildAuthorDecisionsHtml,
  isOpenMessage,
  type AuthorDecisionRowHtml,
} from "../views/authorDecisionsPanelHtml";
import { columnForLocation } from "./editorColumn";
import type { DecisionMemory } from "./decisionMemory";
import {
  loadProposalListFacts,
  rememberShownDecisions,
  revealProposal,
  showEmptyProposalListNotice,
  type ProposalListRow,
} from "./editorProposalList";

/**
 * 編集者モードの「作者の採否」パネル（作者の答え 2026-11-07「閉じないパネルにする」。設計書5.7.5.9）。
 *
 * 呼び口は2つ：編集者メニューの「7. 作者の採否を見る」（`novelai.viewAuthorDecisions`）と、
 * 採否が届いた知らせの［採否を見る］（`editingAutomation.ts`）。
 *
 * **読むだけ。** 台帳にも本文にも書かない。作品ごとに1枚を使い回し、もう開いていれば
 * 前に出して描き直す。行を押すと本文のその場所を**パネルと別の列に**開き、パネルは閉じない。
 */
interface OpenPanel {
  panel: vscode.WebviewPanel;
  /** いま並べている行（押された番号から提案を引く。描き直すたびに入れ替える） */
  rows: ProposalListRow[];
  memory: DecisionMemory;
}

const openPanels = new Map<string, OpenPanel>();

export async function showAuthorDecisionsPanel(
  work: WorkEntry,
  memory: DecisionMemory
): Promise<void> {
  const { rows, mine } = await loadProposalListFacts(work, "decided");
  // 0件ならパネルを開かず、これまでと同じ知らせを出す（空のパネルが横に残っても読む物が無い）
  if (rows.length === 0) {
    showEmptyProposalListNotice(work, "decided", mine);
    return;
  }

  const existing = openPanels.get(work.id);
  if (existing) {
    existing.memory = memory;
    existing.panel.reveal(undefined, false);
    await render(existing, work, rows, mine);
    return;
  }

  const panel = vscode.window.createWebviewPanel(
    "novelai.authorDecisions",
    `作者の採否：${work.title}`,
    // 本文の横に置き、見比べながら1件ずつ見る
    vscode.ViewColumn.Beside,
    { enableScripts: true, localResourceRoots: [] }
  );
  const entry: OpenPanel = { panel, rows: [], memory };
  openPanels.set(work.id, entry);
  panel.onDidDispose(() => {
    if (openPanels.get(work.id) === entry) openPanels.delete(work.id);
  });
  // 窓が出ている間に押さずに焦点を受けたら、窓へ戻す（views/pickerFocus.ts）
  listenForFocusWithoutPointer(panel.webview, "作者の判断の画面");
  panel.webview.onDidReceiveMessage(async (message: unknown) => {
    if (!isOpenMessage(message)) return;
    const row = entry.rows[message.index];
    if (!row) return;
    await revealProposal(work, row.view, columnFor(work, row.view));
  });
  await render(entry, work, rows, mine);
}

/**
 * 同期で新しい採否が届いたとき、その作品のパネルが開いていれば描き直す。
 * **開いていなければ何もしない**（勝手に開かない。開くのは知らせの［採否を見る］）
 */
export async function refreshAuthorDecisionsPanel(work: WorkEntry): Promise<void> {
  const entry = openPanels.get(work.id);
  if (!entry) return;
  const { rows, mine } = await loadProposalListFacts(work, "decided");
  await render(entry, work, rows, mine);
}

async function render(
  entry: OpenPanel,
  work: WorkEntry,
  rows: ProposalListRow[],
  mine: readonly ProposalView[]
): Promise<void> {
  entry.rows = rows;
  // 並べた採否は「見た」として覚える（QuickPick だったときと同じ。7の印が「済み」になる）
  await rememberShownDecisions(work, rows, entry.memory);
  entry.panel.title = `作者の採否：${work.title}`;
  /*
    **描き直しは HTML を入れ替える一番簡単な形にした。** 届く頻度は同期のたびの数件なので、
    台本へ差分を流す仕組みを足すほどではない（入れ替えると並びの位置は上へ戻る）
  */
  entry.panel.webview.html = buildAuthorDecisionsHtml(
    createNonce(),
    entry.panel.webview.cspSource,
    `作者の採否（${describeDecisionCounts(summarizeDecisions([...mine]))}）`,
    rows.map(toHtmlRow)
  );
}

function toHtmlRow(row: ProposalListRow): AuthorDecisionRowHtml {
  return {
    label: row.label,
    description: row.description,
    detail: row.detail,
    kind: decisionKind(row.view),
  };
}

/** 色分けの種類（`statusWord` と同じ分け方。意見に付いた古い「採った」は読まれた） */
export function decisionKind(view: ProposalView): AuthorDecisionRowHtml["kind"] {
  if (view.status === "rejected") return "rejected";
  if (view.status === "read" || isOpinionOnly(view)) return "read";
  return "accepted";
}

/**
 * 本文を開く列。パネル（WebView）が前に出ている列を避ける判断は `columnForLocation` に任せる
 * （シーンメモ・提案パネルと同じ。判断を1か所に集めるため）
 */
function columnFor(work: WorkEntry, view: ProposalView): vscode.ViewColumn | undefined {
  return columnForLocation(path.join(work.folderPath, view.file)).column;
}
