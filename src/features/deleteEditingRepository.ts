import * as vscode from "vscode";
import type { WorkEntry } from "../models/types";
import { isEditorMode } from "../core/actorContext";
import { runGit, type GitCommandRunner } from "../core/git";
import { FileLockStore } from "../core/fileLockStore";
import { ProposalStore } from "../core/proposalStore";
import { runSerialized } from "../core/ledgerQueue";
import { describeLockRange, editingQueueKey } from "../core/editingRepo";
import {
  deleteRepository,
  repositoryWebUrl,
  type DeleteRepositoryResult,
} from "../core/githubCollaboration";
import type { GithubRepoRef } from "../core/githubRepoRef";
import { findAction } from "../core/actionTree";
import { logFailure, logStep, useLogFile } from "../core/logger";
import { withProgress } from "../views/progress";
import { whenNoticePicked } from "../views/notify";
import { forgetPointer, forgetRemoteUrl, readPointer, readSite } from "./shareWithEditor";
import { remoteRef } from "./revokeEditorAccess";

/**
 * 編集用リポジトリを GitHub から消す（作者モード専用。設計書5.7.5.4、作者の決定 2026-11-07
 * 「解除の終わりに聞くのと、そのリポジトリを消すメニューを用意してください」）。
 *
 * 入口は2つで、守りは同じ。
 * - 「編集者連携を解除」の終わりに訊く（`afterRevoke`）
 * - 「編集者連携」のメニューの「リポジトリを消す」（幅の都合で「編集用」は括弧の補足へ）
 *
 * **消すのは GitHub の編集用リポジトリだけ。** 作者の原稿・設定資料・作品の台帳には触らない。
 * 手元の編集用フォルダーも消さず、場所を知らせるだけにする（作者のファイルが入っている）。
 * 消したあとは `.aiwriter/editing.json` の送り先（`remoteUrl`）とこの端末の場所の覚えを外し、
 * 次の「編集者へ渡す」が新しく作る道へ進むようにする。
 */

export const DELETE_EDITING_REPOSITORY_COMMAND = "novelai.deleteEditingRepository";

/** 確認の窓のボタン */
const DELETE = "消す";
/** 手で消す道（GitHub の Settings の一番下の Danger Zone） */
const OPEN_ON_GITHUB = "GitHubで開く";

/** 消す前の守りに当たった理由 */
export type DeleteBlockReason = "noRemote" | "notRevoked" | "locks" | "pending";

export interface DeleteRepoDeps {
  run?: GitCommandRunner;
  /** 確認。`true` で進む */
  confirm?: (summary: {
    fullName: string;
    folder: string | undefined;
    afterRevoke: boolean;
    needsSignIn: boolean;
  }) => Promise<boolean>;
  /** 削除の権限（`delete_repo`）を持つ鍵が、もう VS Code にあるか（窓を出さずに確かめる） */
  hasDeleteScope?: () => Promise<boolean>;
  /** 削除の権限を足した鍵（取れなければ `undefined`） */
  token?: () => Promise<string | undefined>;
  /** 消す口 */
  remove?: (token: string, ref: GithubRepoRef) => Promise<DeleteRepositoryResult>;
}

export type DeleteRepoResult =
  | { kind: "notAuthorMode" }
  | { kind: "blocked"; reason: DeleteBlockReason }
  | { kind: "cancelled" }
  | { kind: "noToken" }
  | { kind: "failed"; detail: string }
  | { kind: "deleted"; fullName: string };

/** 削除に要る GitHub の権限。ふだんの `repo` に `delete_repo` を足す（消す道でだけ） */
const DELETE_SCOPES = ["repo", "delete_repo"];

export async function deleteEditingRepositoryFlow(
  work: WorkEntry,
  options: { afterRevoke?: boolean } = {},
  deps: DeleteRepoDeps = {}
): Promise<DeleteRepoResult> {
  const afterRevoke = options.afterRevoke === true;
  if (isEditorMode()) {
    void vscode.window.showWarningMessage(
      "編集用リポジトリを消せるのは作者です（編集者モードでは使えません）。"
    );
    return { kind: "notAuthorMode" };
  }
  const run = deps.run ?? runGit;
  const pointer = await readPointer(work);
  const site = await readSite(work);

  // **守り**（どちらの入口でも同じ）。当たったら消さずに理由を出す
  const ref = await remoteRef(site, pointer?.folderPath, run);
  if (!ref) {
    // 解除の終わりに訊く道では黙る（まだ一度も GitHub へ送れていない作品で、訊くものが無い）
    if (!afterRevoke) {
      void vscode.window.showInformationMessage(
        `「${work.title}」の編集用リポジトリの場所が分かりません。` +
          "まだ編集者へ渡していないか、送り先の記録が無い見込みです。消すものはありません。"
      );
    }
    return { kind: "blocked", reason: "noRemote" };
  }
  const revokeLabel = findAction("novelai.revokeEditorAccess")?.label ?? "編集者連携を解除";
  if (site.editorLogin) {
    void vscode.window.showWarningMessage(
      `${site.editorLogin} さんとの連携が、まだ解除されていません。` +
        `先に「${revokeLabel}」を押してから、もう一度押してください。`
    );
    return { kind: "blocked", reason: "notRevoked" };
  }
  const locks = [...(await new FileLockStore(work).load()).values()].filter(
    (lock) => lock.holderKind === "editor"
  );
  if (locks.length > 0) {
    const range = describeLockRange(locks.map((lock) => lock.file));
    void vscode.window.showWarningMessage(
      `編集者の校閲中の印が残っています（${range}）。` +
        `先に「${revokeLabel}」で外してから、もう一度押してください。`
    );
    return { kind: "blocked", reason: "locks" };
  }
  const pending = (await new ProposalStore(work).load()).filter(
    (entry) => entry.status === "pending"
  ).length;
  if (pending > 0) {
    const viewLabel = findAction("novelai.viewEditorProposals")?.label ?? "編集者の提案を見る";
    void vscode.window.showWarningMessage(
      `まだ決めていない編集者の提案が ${pending} 件あるため、編集用リポジトリは消していません。` +
        `「${viewLabel}」で採るか見送るかを決めてから、もう一度押してください。`
    );
    return { kind: "blocked", reason: "pending" };
  }

  const fullName = `${ref.owner}/${ref.repo}`;
  const needsSignIn = !(await (deps.hasDeleteScope ?? hasDeleteScope)());
  const summary = { fullName, folder: pointer?.folderPath, afterRevoke, needsSignIn };
  const confirmed = deps.confirm ? await deps.confirm(summary) : await confirmWithModal(summary);
  if (!confirmed) return { kind: "cancelled" };

  const token = await (deps.token ?? deleteScopedToken)();
  if (!token) {
    showManualGuide(
      work,
      ref,
      "GitHub の削除の許可が得られなかったため、編集用リポジトリは消していません。"
    );
    return { kind: "noToken" };
  }

  const remove = deps.remove ?? ((key: string, target: GithubRepoRef) => deleteRepository(key, target));
  let forgetProblem: string | undefined;
  const act = async (): Promise<DeleteRepositoryResult> => {
    const result = await remove(token, ref);
    if (!result.ok) return result;
    // **送り先の項目だけを外す**（ほかは残す）。場所の覚えも消して、次の「渡す」を新しく作る道へ。
    // 外せなくても、消したことは消したこととして知らせる（GitHub の側はもう戻らない）
    try {
      await forgetRemoteUrl(work);
      await forgetPointer(work);
    } catch (error) {
      forgetProblem = error instanceof Error ? error.message : String(error);
    }
    return result;
  };
  const result = await withProgress("編集用リポジトリを消しています…", () =>
    pointer ? runSerialized(editingQueueKey(pointer.folderPath), act) : act()
  );

  useLogFile(work.folderPath);
  if (!result.ok) {
    logFailure("編集用リポジトリを消す", {
      作品: work.title,
      リポジトリ: fullName,
      理由: result.reason,
      詳細: result.detail,
    });
    showManualGuide(
      work,
      ref,
      result.reason === "network"
        ? "ネットにつながっていないようです。編集用リポジトリは消していません。つながってから、もう一度押してください。"
        : `編集用リポジトリを消せませんでした（${result.detail}）。`
    );
    return { kind: "failed", detail: result.detail };
  }

  logStep(`編集用リポジトリを消した（${work.title}／${fullName}）`);
  if (forgetProblem) {
    logFailure("編集用リポジトリを消したあとの、送り先の記録を外す", {
      作品: work.title,
      詳細: forgetProblem,
    });
    void vscode.window.showWarningMessage(
      `編集用のリポジトリ（${fullName}）は GitHub から消しましたが、${forgetProblem}` +
        "次に「編集者へ渡す」を押す前に、`.aiwriter/editing.json` の remoteUrl の行を手で消してください。"
    );
    return { kind: "deleted", fullName };
  }
  void vscode.window.showInformationMessage(
    `編集用のリポジトリ（${fullName}）を GitHub から消しました。` +
      (pointer
        ? `このパソコンの編集用フォルダーは残してあります（${pointer.folderPath}）。要らなければ手で消してください。`
        : "")
  );
  return { kind: "deleted", fullName };
}

/** 削除の権限を持つ鍵が、もう VS Code にあるか（窓を出さない）。確かめられなければ「無い」 */
async function hasDeleteScope(): Promise<boolean> {
  try {
    return (
      (await vscode.authentication.getSession("github", DELETE_SCOPES, { silent: true })) !==
      undefined
    );
  } catch {
    return false;
  }
}

/**
 * 削除の権限を足した鍵を取る（**消す道でだけ**）。ふだんの鍵（`repo`）では 403 になる。
 * 作者が承認を取りやめると VS Code は例外を投げるので、「取れなかった」として吸収する
 */
async function deleteScopedToken(): Promise<string | undefined> {
  try {
    const session = await vscode.authentication.getSession("github", DELETE_SCOPES, {
      createIfNone: true,
    });
    return session?.accessToken;
  } catch {
    return undefined;
  }
}

/** 消せなかったとき：GitHub の Settings の Danger Zone で手で消す道を案内する */
function showManualGuide(work: WorkEntry, ref: GithubRepoRef, head: string): void {
  whenNoticePicked(
    vscode.window.showWarningMessage(
      head +
        "手で消すときは、GitHub のリポジトリの「Settings」を開き、一番下の「Danger Zone」の" +
        "「Delete this repository」を押してください。",
      OPEN_ON_GITHUB
    ),
    async (picked) => {
      if (picked !== OPEN_ON_GITHUB) return;
      await vscode.env.openExternal(vscode.Uri.parse(`${repositoryWebUrl(ref)}/settings`));
    },
    { label: "編集用リポジトリを消す", workFolder: work.folderPath }
  );
}

async function confirmWithModal(summary: {
  fullName: string;
  folder: string | undefined;
  afterRevoke: boolean;
  needsSignIn: boolean;
}): Promise<boolean> {
  const lines = [
    "消すと元に戻せません。",
    "",
    `【消すもの】GitHub の ${summary.fullName}（編集者とやり取りした提案・校閲中の印・編集履歴の記録を含む）`,
    "【消さないもの】作品の原稿・設定資料・作品の台帳" +
      (summary.folder ? `、このパソコンの編集用フォルダー（${summary.folder}）` : ""),
    ...(summary.afterRevoke ? ["", "閉じれば、リポジトリは残します。"] : []),
    ...(summary.needsSignIn
      ? [
          "",
          "次に VS Code の［許可］と、ブラウザで GitHub の承認を求められます。" +
            "消すための許可（削除の権限）を足すためです。どちらも［許可］／［Authorize］を押してください。",
        ]
      : []),
  ];
  const answer = await vscode.window.showWarningMessage(
    summary.afterRevoke
      ? `編集用のリポジトリ（${summary.fullName}）も GitHub から消しますか。`
      : `編集用のリポジトリ（${summary.fullName}）を GitHub から消しますか。`,
    { modal: true, detail: lines.join("\n") },
    DELETE
  );
  return answer === DELETE;
}
