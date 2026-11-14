import * as vscode from "vscode";
import { showQuickPickKeepingFocus } from "../views/pickerFocus";
import * as path from "../core/paths";
import type { WorkEntry } from "../models/types";
import { ProposalStore } from "../core/proposalStore";
import { tryGitUserName } from "../core/gitAttribution";
import {
  categoryLabel,
  decisionKey,
  describeDecisionCounts,
  isOpinionOnly,
  summarizeDecisions,
  type ProposalView,
} from "../models/proposal";
import { formatWhen } from "../core/editorProgress";
import { cancelItem, isCancelItem } from "../views/dialogs";
import type { DecisionMemory } from "./decisionMemory";

/**
 * 編集者メニューの「置いた提案の一覧」「7. 作者の採否を見る」（作者の指示 2026-11-05 夜。設計書5.6.6）。
 *
 * 編集者（kmizu さん）は、前回の作者の採否がどこに出るのか探せなかった。届いた知らせ
 * 「作者が提案を決めました（採用 N・見送り N・読まれた N）」は数だけで、流れると見返せない。
 * そこで、置いた提案と作者の採否を**本文の場所へ飛べる一覧**で見られるようにする。
 *
 * **読むだけ。** 台帳にも本文にも書かない。採否の一覧を開いたら、並べた採否を
 * 「見た」として覚える（`decisionMemory`。届いた知らせと同じ覚え。作品フォルダーには書かない）
 */
export type ProposalListMode = "placed" | "decided";

/** 状態の言い方（作者の画面と同じ言葉。意見に付いた古い「採った」は読まれたと言う） */
export function statusWord(view: ProposalView): string {
  if (view.status === "pending") return "作者の返事待ち";
  if (view.status === "rejected") return "見送り";
  if (view.status === "read" || isOpinionOnly(view)) return "読まれた";
  return "採用";
}

/** 一覧の1行（試験で中身を確かめる） */
export interface ProposalListRow {
  label: string;
  description: string;
  detail: string;
  view: ProposalView;
}

/**
 * 一覧の行を作る。並びは新しい順（採否の一覧は決めた時刻、置いた提案は置いた時刻）。
 * 自分の名前が分かれば、自分の提案だけにする（`readEditorMenuFacts` と同じ見方）
 */
export function proposalListRows(
  views: readonly ProposalView[],
  mode: ProposalListMode,
  who: string,
  now: Date = new Date()
): ProposalListRow[] {
  const mine = views.filter((view) => who === "" || view.proposer === who);
  const shown = mode === "decided" ? mine.filter((view) => view.status !== "pending") : [...mine];
  const timeOf = (view: ProposalView): number =>
    Date.parse(mode === "decided" ? (view.decision?.time ?? view.time) : view.time) || 0;
  shown.sort((a, b) => timeOf(b) - timeOf(a));
  return shown.map((view) => {
    const what = isOpinionOnly(view)
      ? `「${view.target}」への意見`
      : `「${view.target}」→「${view.suggestion}」`;
    const when =
      mode === "decided" && view.decision
        ? formatWhen(view.decision.time, now)
        : formatWhen(view.time, now);
    const note = view.decision?.note ? `・作者のひと言：${view.decision.note}` : "";
    // **決めた作者は GitHub のユーザー名だけで添える**（作者の答え 2026-11-07。設計書5.7.5.9）。
    // `decidedBy` は作者のパソコンの git の名前なので出さない。名前を引けなかった採否と
    // 0.138.0 より前の採否には `decidedByLogin` が無く、そのときは誰が決めたかを書かない
    const decider =
      mode === "decided" && view.decision?.decidedByLogin
        ? `・決めた作者：${view.decision.decidedByLogin}`
        : "";
    return {
      label: `${statusWord(view)}　${what}`,
      description: `${path.basename(view.file)} ${view.line}行`,
      detail: `${categoryLabel(view.category)}：${view.reason}${when ? `（${when}）` : ""}${decider}${note}`,
      view,
    };
  });
}

/** 一覧に並べる行と、件数の見出しに使う自分の提案（QuickPick と採否のパネルで同じ読み方をする） */
export interface ProposalListFacts {
  rows: ProposalListRow[];
  mine: ProposalView[];
}

export async function loadProposalListFacts(
  work: WorkEntry,
  mode: ProposalListMode
): Promise<ProposalListFacts> {
  const views = await new ProposalStore(work).load();
  const who = (await tryGitUserName(work.folderPath)) ?? "";
  return {
    rows: proposalListRows(views, mode, who),
    mine: views.filter((view) => who === "" || view.proposer === who),
  };
}

/** 並べるものが無いときの知らせ（QuickPick とパネルで同じ文にする） */
export function showEmptyProposalListNotice(
  work: WorkEntry,
  mode: ProposalListMode,
  mine: readonly ProposalView[]
): void {
  void vscode.window.showInformationMessage(
    mode === "decided"
      ? mine.length > 0
        ? `「${work.title}」の作者の採否は、まだ届いていません（作者の返事待ち ${mine.length}件）。` +
          "作者が決めると、「1. 作者の最新の原稿を受け取る」で届きます。"
        : `「${work.title}」には、まだ提案を置いていません。`
      : `「${work.title}」には、まだ提案を置いていません。` +
        "「3. 機械に探させる」か「4. 直しを提案する・メモ（意見）を書く」で置けます。"
  );
}

/** 採否の一覧を見せたら、並べた採否は「見た」として覚える（7の印が「済み」になる） */
export async function rememberShownDecisions(
  work: WorkEntry,
  rows: readonly ProposalListRow[],
  memory: DecisionMemory
): Promise<void> {
  const keys = rows
    .map((row) => decisionKey(row.view))
    .filter((key): key is string => key !== undefined);
  await memory.add(work.id, keys);
}

/**
 * QuickPick の一覧。**いまは「置いた提案」（placed）だけがここを通る。**
 * 作者の採否（decided）は 0.136.0 から横に残るパネル（`authorDecisionsPanel.ts`）で見せる
 */
export async function showEditorProposalList(
  work: WorkEntry,
  mode: ProposalListMode,
  memory: DecisionMemory
): Promise<void> {
  const { rows, mine } = await loadProposalListFacts(work, mode);

  if (rows.length === 0) {
    showEmptyProposalListNotice(work, mode, mine);
    return;
  }

  if (mode === "decided") await rememberShownDecisions(work, rows, memory);

  const counts = summarizeDecisions(mine);
  const title =
    mode === "decided"
      ? `作者の採否（${describeDecisionCounts(counts)}）`
      : `置いた提案 ${rows.length}件（作者の返事待ち ${counts.pending}）`;
  const picked = await showQuickPickKeepingFocus(
    [...rows.map((row) => ({ ...row })), cancelItem()],
    {
      title: `${work.title}：${title}`,
      placeHolder: "選ぶと、本文のその場所を開きます",
      matchOnDescription: true,
      matchOnDetail: true,
    }
  );
  if (!picked || isCancelItem(picked) || !("view" in picked)) return;
  await revealProposal(work, picked.view);
}

/**
 * 本文のその行を開く。**開くだけで、書き換えない。**
 * `viewColumn` は採否のパネルから開くときに渡す（パネルの列に本文を重ねないため）
 */
export async function revealProposal(
  work: WorkEntry,
  view: ProposalView,
  viewColumn?: vscode.ViewColumn
): Promise<void> {
  const uri = path.toUri(path.join(work.folderPath, view.file));
  try {
    await vscode.workspace.fs.stat(uri);
  } catch {
    void vscode.window.showWarningMessage(
      `「${view.file}」が見つかりませんでした。作者が話の名前を変えたか、消したのかもしれません。`
    );
    return;
  }
  const line = Math.max(0, view.line - 1);
  await vscode.commands.executeCommand("vscode.open", uri, {
    selection: new vscode.Range(line, 0, line, 0),
    ...(viewColumn !== undefined ? { viewColumn } : {}),
  });
}
