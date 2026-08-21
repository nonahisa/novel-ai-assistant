import * as vscode from "vscode";
import * as path from "../core/paths";
import type { WorkEntry } from "../models/types";
import { ProposalStore } from "../core/proposalStore";
import type { ProposalView } from "../models/proposal";
import { FileLockStore } from "../core/fileLockStore";
import { describeLock, normalizeFile } from "../models/fileLock";
import { isEditorMode, recordEdit } from "../core/actorContext";
import { gitUserName } from "../core/git";
import {
  readTextFile,
  writeTextFilePreservingFormat,
} from "../core/textFile";
import { cancelItem, isCancelItem } from "../views/dialogs";
import type { ProposalPanel, ProposalViewItem } from "./proposalPanel";

/**
 * 編集部からの提案を、作者が見て決める（設計書5.6）。
 *
 * **編集部は本文を書き換えない。** 届くのは「こう直したい」という
 * 申し出だけで、採るかどうかは作者が決める。
 *
 * **既存の提案パネルへ流し込む。** 誤字脱字の指摘と形が同じなので、
 * 適用・無視の道をそのまま使える。**本文を書き換える処理を新しく作らない**
 * （5.4のとおり、書き込み口を増やさない）。
 */
export async function reviewProposals(
  work: WorkEntry,
  panel: ProposalPanel
): Promise<void> {
  const store = new ProposalStore(work);
  const all = await store.load();
  const pending = all.filter((entry) => entry.status === "pending");

  if (all.length === 0) {
    void vscode.window.showInformationMessage(
      "編集部からの提案はまだありません。" +
        "編集部が校正・校閲を行い、同期すると届きます。"
    );
    return;
  }
  if (pending.length === 0) {
    void vscode.window.showInformationMessage(
      `未決の提案はありません（これまでに ${all.length} 件の提案がありました）。`
    );
    return;
  }

  // **編集者モードでは決められない。** 提案を採るのは作者の判断である
  if (isEditorMode()) {
    void vscode.window.showInformationMessage(
      `未決の提案が ${pending.length} 件あります。` +
        "採るかどうかは作者が決めます（編集者モードでは決められません）。"
    );
    return;
  }

  panel.showProposals(work, pending.map(toViewItem));
  void vscode.window.showInformationMessage(
    `編集部からの提案が ${pending.length} 件あります。` +
      "「提案」パネルで1件ずつご確認ください。"
  );
}

function toViewItem(proposal: ProposalView): ProposalViewItem & {
  proposalId: string;
} {
  return {
    id: `proposal:${proposal.id}`,
    proposalId: proposal.id,
    filePath: proposal.file,
    fileName: path.basename(proposal.file),
    chunkHash: proposal.id,
    line: proposal.line,
    original: proposal.original,
    target: proposal.target,
    suggestion: proposal.suggestion,
    reason: proposal.proposer
      ? `${proposal.reason}（${proposal.proposer} さんの提案）`
      : proposal.reason,
    confidence: "high",
    status: "pending",
  };
}

/**
 * 校閲を始める／終える（編集者モード）。
 *
 * **ファイル単位で押さえる。** 作品全体を止めると、編集部が第3話を
 * 見ている間、作者は第20話も書けない。
 */
export async function toggleReviewLock(work: WorkEntry): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    void vscode.window.showWarningMessage(
      "校閲するファイルを開いてから実行してください。"
    );
    return;
  }

  const relative = normalizeFile(
    path.relative(work.folderPath, editor.document.uri.fsPath)
  );
  if (relative.startsWith("..")) {
    void vscode.window.showWarningMessage(
      "この作品のファイルではありません。"
    );
    return;
  }

  const store = new FileLockStore(work);
  const current = await store.lockFor(relative);
  const who = (await gitUserName(work.folderPath).catch(() => undefined)) ?? "";
  const holderKind = isEditorMode() ? "editor" : "author";

  if (current) {
    const answer = await vscode.window.showWarningMessage(
      `${path.basename(relative)} は押さえられています。`,
      { modal: true, detail: describeLock(current) },
      "外す"
    );
    if (answer !== "外す") return;
    await store.release([relative], who, holderKind);
    await recordEdit(work, {
      actor: holderKind,
      action: "校閲のロックを外した",
      file: path.basename(relative),
      detail: current.holder && current.holder !== who
        ? `${current.holder} が押さえていたものを外しました`
        : "",
    });
    void vscode.window.showInformationMessage(
      `${path.basename(relative)} のロックを外しました。`
    );
    return;
  }

  const note = await pickNote();
  if (note === undefined) return;

  await store.acquire([relative], who, holderKind, note);
  await recordEdit(work, {
    actor: holderKind,
    action: "校閲のロックをかけた",
    file: path.basename(relative),
    detail: note,
  });
  void vscode.window.showInformationMessage(
    `${path.basename(relative)} を押さえました。` +
      "同期すると、作者側にも伝わります。終わったらもう一度押して外してください。"
  );
}

async function pickNote(): Promise<string | undefined> {
  const picked = await vscode.window.showQuickPick(
    [
      { label: "校閲中", note: "校閲中" },
      { label: "誤字脱字を見ています", note: "誤字脱字を見ています" },
      { label: "推敲の提案を作っています", note: "推敲の提案を作っています" },
      cancelItem(),
    ],
    {
      title: "何をしているかを、作者へ伝えます",
      placeHolder: "作者の画面に出ます",
      ignoreFocusOut: true,
    }
  );
  if (!picked || isCancelItem(picked)) return undefined;
  return "note" in picked ? picked.note : "";
}

/**
 * 承認して本文へ反映する。
 *
 * **適用の直前に本文と照合する。** 提案が届いてから作者が本文を
 * 直していることがある。合わなければ、**書き換えずに理由を出す。**
 */
export async function acceptProposal(
  work: WorkEntry,
  proposal: { id: string; file: string; line: number; original: string; target: string; suggestion: string }
): Promise<{ ok: boolean; reason?: string }> {
  const absolute = path.join(work.folderPath, proposal.file);
  let file;
  try {
    file = await readTextFile(absolute);
  } catch {
    return { ok: false, reason: "本文を読み込めませんでした。" };
  }

  const lines = file.text.split("\n");
  const lineText = lines[proposal.line - 1];
  if (lineText === undefined || !lineText.includes(proposal.original)) {
    return {
      ok: false,
      reason:
        "提案が届いてから本文が変わっているため、この提案の位置を特定できませんでした。",
    };
  }

  const originalIndex = lineText.indexOf(proposal.original);
  const targetIndex = proposal.original.indexOf(proposal.target);
  if (targetIndex === -1) {
    return { ok: false, reason: "提案の位置を特定できませんでした。" };
  }
  const at = originalIndex + targetIndex;
  lines[proposal.line - 1] =
    lineText.slice(0, at) +
    proposal.suggestion +
    lineText.slice(at + proposal.target.length);

  const result = await writeTextFilePreservingFormat(
    absolute,
    lines.join("\n"),
    file,
    file.hash
  );
  if (!result.ok) {
    return { ok: false, reason: "本文を書き戻せませんでした。" };
  }

  const who = (await gitUserName(work.folderPath).catch(() => undefined)) ?? "";
  await new ProposalStore(work).decide([
    {
      proposalId: proposal.id,
      time: new Date().toISOString(),
      decidedBy: who,
      status: "accepted",
      note: "",
    },
  ]);
  await recordEdit(work, {
    actor: "author",
    action: "編集部の提案を採り入れた",
    file: path.basename(proposal.file),
    detail: `${proposal.line}行 「${proposal.target}」→「${proposal.suggestion}」`,
  });
  return { ok: true };
}

/** 却下する。**本文には触らない** */
export async function rejectProposal(
  work: WorkEntry,
  proposalIdValue: string,
  fileName: string
): Promise<void> {
  const who = (await gitUserName(work.folderPath).catch(() => undefined)) ?? "";
  await new ProposalStore(work).decide([
    {
      proposalId: proposalIdValue,
      time: new Date().toISOString(),
      decidedBy: who,
      status: "rejected",
      note: "",
    },
  ]);
  await recordEdit(work, {
    actor: "author",
    action: "編集部の提案を見送った",
    file: fileName,
    detail: "",
  });
}
