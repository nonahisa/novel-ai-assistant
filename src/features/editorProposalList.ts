import * as vscode from "vscode";
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
    return {
      label: `${statusWord(view)}　${what}`,
      description: `${path.basename(view.file)} ${view.line}行`,
      detail: `${categoryLabel(view.category)}：${view.reason}${when ? `（${when}）` : ""}${note}`,
      view,
    };
  });
}

export async function showEditorProposalList(
  work: WorkEntry,
  mode: ProposalListMode,
  memory: DecisionMemory
): Promise<void> {
  const views = await new ProposalStore(work).load();
  const who = (await tryGitUserName(work.folderPath)) ?? "";
  const rows = proposalListRows(views, mode, who);
  const mine = views.filter((view) => who === "" || view.proposer === who);

  if (rows.length === 0) {
    void vscode.window.showInformationMessage(
      mode === "decided"
        ? mine.length > 0
          ? `「${work.title}」の作者の採否は、まだ届いていません（作者の返事待ち ${mine.length}件）。` +
            "作者が決めると、「1. 作者の最新の原稿を受け取る」で届きます。"
          : `「${work.title}」には、まだ提案を置いていません。`
        : `「${work.title}」には、まだ提案を置いていません。` +
          "「3. 機械に探させる」か「4. 直しを提案する・メモ（意見）を書く」で置けます。"
    );
    return;
  }

  // 採否の一覧を開いたら、並べた採否は「見た」として覚える（7の印が「済み」になる）
  if (mode === "decided") {
    const keys = rows
      .map((row) => decisionKey(row.view))
      .filter((key): key is string => key !== undefined);
    await memory.add(work.id, keys);
  }

  const counts = summarizeDecisions(mine);
  const title =
    mode === "decided"
      ? `作者の採否（${describeDecisionCounts(counts)}）`
      : `置いた提案 ${rows.length}件（作者の返事待ち ${counts.pending}）`;
  const picked = await vscode.window.showQuickPick(
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

/** 本文のその行を開く。**開くだけで、書き換えない** */
async function revealProposal(work: WorkEntry, view: ProposalView): Promise<void> {
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
  });
}
