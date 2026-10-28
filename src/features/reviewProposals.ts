import * as vscode from "vscode";
import { fromUri } from "../core/paths";
import * as path from "../core/paths";
import type { WorkEntry } from "../models/types";
import { ProposalStore } from "../core/proposalStore";
import type { ProposalView } from "../models/proposal";
import { FileLockStore } from "../core/fileLockStore";
import { describeLock, normalizeFile } from "../models/fileLock";
import { isEditorMode, recordEdit } from "../core/actorContext";
import { tryGitUserName } from "../core/gitAttribution";
import {
  readTextFile,
  writeTextFilePreservingFormat,
} from "../core/textFile";
import { cancelItem, isCancelItem } from "../views/dialogs";
import type { ProposalPanel, ProposalViewItem } from "./proposalPanel";
import { notifyDone } from "../views/notify";
import { logFailure, useLogFile } from "../core/logger";
import { canRunProcesses } from "../core/runtime";
import { activeTabFileUri } from "./manuscriptTab";

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
  // **前に出ているタブから取る。** 原稿エディタ（既定の開き方）は
  // `TextEditor` を持たないので、`activeTextEditor` だけでは話を開いていても
  // 空になる（2026-10-12）。タブが読めない環境のために素のエディタへも落とす
  const uri =
    activeTabFileUri() ?? vscode.window.activeTextEditor?.document.uri;
  if (!uri) {
    void vscode.window.showWarningMessage(
      "校閲するファイルを開いてから実行してください。"
    );
    return;
  }

  const filePath = fromUri(uri);
  // 「中にあるか」は共通の判定に任せる（2026-09-23）。`startsWith("..")` の
  // 写しは、`..下書き` のようなフォルダーを外と誤り、別のドライブのファイル
  // （`relative` が絶対の場所を返す）を中と誤っていた
  if (!path.isPathInside(work.folderPath, filePath)) {
    void vscode.window.showWarningMessage(
      "この作品のファイルではありません。"
    );
    return;
  }
  const relative = normalizeFile(path.relative(work.folderPath, filePath));

  const store = new FileLockStore(work);
  const current = await store.lockFor(relative);
  const who = (await tryGitUserName(work.folderPath)) ?? "";
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
    // 済んだ記録も、この作品のログへ（直前に触った作品へ流さない。0.81.4）
    useLogFile(work.folderPath);
    notifyDone(
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

  const who = (await tryGitUserName(work.folderPath)) ?? "";
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
  startReturnIfFinished(work);
  return { ok: true };
}

/**
 * 採否を決め終えていれば、編集部へ静かに送り返す（作者の裁定、2026-10-28）。
 *
 * **待たない。** 送り返しは回線を使うので、提案パネルの操作を待たせない。
 * 失敗は中で知らせてログへ残し、**採否そのものは成功のまま**にする。
 * `shareWithEditor` は Node（git）を使うので、ブラウザ版の束に入れないよう
 * 動的 import にする（実装ルール7）。
 */
function startReturnIfFinished(work: WorkEntry): void {
  if (isEditorMode() || !canRunProcesses()) return;
  void import("./editingAutomation.js")
    .then((module) => module.returnDecisionsIfFinished(work))
    .catch((error: unknown) => {
      useLogFile(work.folderPath);
      logFailure("採否の送り返し", {
        作品: work.title,
        詳細: error instanceof Error ? error.message : String(error),
      });
    });
}

/** 却下する。**本文には触らない** */
export async function rejectProposal(
  work: WorkEntry,
  proposalIdValue: string,
  fileName: string
): Promise<void> {
  const who = (await tryGitUserName(work.folderPath)) ?? "";
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
  startReturnIfFinished(work);
}
