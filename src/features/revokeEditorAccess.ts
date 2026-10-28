import * as vscode from "vscode";
import type { WorkEntry } from "../models/types";
import { isEditorMode, recordEdit } from "../core/actorContext";
import { tryGitUserName } from "../core/gitAttribution";
import { runGit, type GitCommandRunner } from "../core/git";
import { FileLockStore } from "../core/fileLockStore";
import { runSerialized } from "../core/ledgerQueue";
import { describeLockRange, editingQueueKey } from "../core/editingRepo";
import {
  repositoryWebUrl,
  revokeEditorAccess,
  type RevokeResult,
} from "../core/githubCollaboration";
import { parseGithubRepoRef, type GithubRepoRef } from "../core/githubRepoRef";
import { logFailure, logStep, useLogFile } from "../core/logger";
import { withProgress } from "../views/progress";
import { notifyDone } from "../views/notify";
import {
  acquireGithubToken,
  hasOrigin,
  readPointer,
  readSite,
  sendToEditor,
  writeSite,
  type EditingSite,
} from "./shareWithEditor";

/**
 * 編集部との連携を解除する（作者モード専用。作者の裁定、2026-10-28）。
 *
 * 基本は「校閲中の話は書けなくする」だが、編集部と決裂したときのために、
 * 作者の側から解く手段を置く。
 *
 * 1. 編集部の鍵を、作者の名で release する（鍵の台帳に解除の行を足し、編集履歴にも残す）
 * 2. GitHub で編集部の権利を外す（共同編集者なら DELETE collaborators、
 *    招待を受ける前なら DELETE invitations）。**外せなくても、鍵は外す。**
 *    その場合は「GitHub の Settings→Collaborators で手で外してください」と案内する
 * 3. `.aiwriter/editing.json` の `editorLogin` を消す（次に渡すとき、相手の名前を訊き直す）
 * 4. 解除の行を編集用リポジトリへも送る（編集部の側に、鍵が解けたことが届く）
 */

export interface RevokeDeps {
  run?: GitCommandRunner;
  /** 確認。`true` で進む */
  confirm?: (summary: { range: string | undefined; login: string | undefined }) => Promise<boolean>;
  /** GitHub の鍵 */
  token?: () => Promise<string | undefined>;
  /** 権利を外す口 */
  revoke?: (token: string, ref: GithubRepoRef, login: string) => Promise<RevokeResult>;
  /** 誰の名で外すか */
  whoAmI?: (work: WorkEntry) => Promise<string>;
}

export type RevokeFlowResult =
  | { kind: "notAuthorMode" }
  | { kind: "notShared" }
  | { kind: "cancelled" }
  | {
      kind: "done";
      /** 外した鍵の数 */
      released: number;
      /** GitHub での結果。`skipped`＝相手の名前か送り先が分からず試していない */
      github: "removed" | "invitationCancelled" | "notCollaborator" | "failed" | "skipped";
    };

export async function revokeEditorAccessFlow(
  work: WorkEntry,
  deps: RevokeDeps = {}
): Promise<RevokeFlowResult> {
  if (isEditorMode()) {
    void vscode.window.showWarningMessage(
      "編集部との連携を解除できるのは作者です（編集者モードでは使えません）。"
    );
    return { kind: "notAuthorMode" };
  }
  const run = deps.run ?? runGit;
  const pointer = await readPointer(work);
  const site = await readSite(work);
  if (!pointer && !site.remoteUrl && !site.editorLogin) {
    void vscode.window.showInformationMessage(
      `「${work.title}」はまだ編集部へ渡していません。解除するものがありません。`
    );
    return { kind: "notShared" };
  }

  const login = site.editorLogin ?? pointer?.editorLogin;
  const store = new FileLockStore(work);
  const mine = [...(await store.load()).values()].filter(
    (lock) => lock.holderKind === "editor"
  );
  const range = mine.length > 0 ? describeLockRange(mine.map((lock) => lock.file)) : undefined;

  const confirmed = deps.confirm
    ? await deps.confirm({ range, login })
    : await confirmWithModal(work, range, login);
  if (!confirmed) return { kind: "cancelled" };

  const who = deps.whoAmI
    ? await deps.whoAmI(work)
    : ((await tryGitUserName(work.folderPath)) ?? "");

  const work1 = async (): Promise<RevokeFlowResult> => {
    // 1. 鍵を外す（作者の名で）。台帳に解除の行を足し、履歴にも残す
    if (mine.length > 0) {
      await store.release(
        mine.map((lock) => lock.file),
        who,
        "author",
        "編集部との連携を解除"
      );
      await recordEdit(work, {
        actor: "author",
        action: "編集部との連携を解除（校閲の鍵を外した）",
        file: range ?? "",
        detail: login ? `${login} さんの権利を外します` : "",
      });
    }

    // 2. GitHub で権利を外す。外せなくても、鍵は外した
    let github: Extract<RevokeFlowResult, { kind: "done" }>["github"] = "skipped";
    const ref = await remoteRef(site, pointer?.folderPath, run);
    if (login && ref) {
      const token = deps.token
        ? await deps.token()
        : await acquireGithubToken(false);
      if (!token) {
        github = "failed";
        reportRevokeFailure(work, ref, login, "GitHub のサインインがありません");
      } else {
        const result = await (deps.revoke ?? revokeEditorAccess)(token, ref, login);
        if (result.ok) {
          github = result.outcome;
          logStep(`編集部の権利を外した: ${login}（${ref.owner}/${ref.repo}／${result.outcome}）`);
        } else {
          github = "failed";
          reportRevokeFailure(work, ref, login, result.detail);
        }
      }
    } else if (login) {
      reportRevokeFailure(work, undefined, login, "送り先のリポジトリが分かりません");
      github = "failed";
    }

    // 3. 相手の名前を忘れる（次に渡すとき訊き直す）
    const nextSite: EditingSite = { ...site };
    delete nextSite.editorLogin;
    await writeSite(work, nextSite);

    // 4. 解除の行を編集用リポジトリへも送る
    if (pointer && (await hasOrigin(pointer.folderPath, run))) {
      const sent = await sendToEditor(work, pointer.folderPath, {
        run,
        pointer,
        site: nextSite,
        allowCreate: false,
        message: `${work.title} の編集部との連携を解除`,
      });
      if (!sent.ok) {
        useLogFile(work.folderPath);
        logFailure("連携の解除を編集用リポジトリへ送る", { 作品: work.title, 詳細: sent.detail });
        void vscode.window.showWarningMessage(
          "解除の記録を編集用リポジトリへ送れませんでした。あとで「編集部へ渡す」を押すと送れます。" +
            `（${sent.detail}）`
        );
      }
    }
    return { kind: "done", released: mine.length, github };
  };

  // 同じ編集用フォルダーの作業は1本ずつ（自動の送り返し・取り込みと重ならない）
  const result = await withProgress("編集部との連携を解除しています…", () =>
    pointer ? runSerialized(editingQueueKey(pointer.folderPath), work1) : work1()
  );

  useLogFile(work.folderPath);
  if (result.kind === "done" && result.github !== "failed") {
    notifyDone(
      "編集部との連携を解除しました。" +
        (range ? `${range}の校閲中の印を外しました。` : "")
    );
  }
  return result;
}

/** 送り先のリポジトリ（覚えている URL、なければ編集用フォルダーの origin） */
async function remoteRef(
  site: EditingSite,
  folder: string | undefined,
  run: GitCommandRunner
): Promise<GithubRepoRef | undefined> {
  if (site.remoteUrl) {
    const ref = parseGithubRepoRef(site.remoteUrl);
    if (ref) return ref;
  }
  if (folder) {
    const origin = await run(["remote", "get-url", "origin"], folder, 15_000);
    if (origin.code === 0) return parseGithubRepoRef(origin.stdout.trim());
  }
  return undefined;
}

/** 権利を外せなかったとき：手で外す案内を出す。失敗は記録に残す */
function reportRevokeFailure(
  work: WorkEntry,
  ref: GithubRepoRef | undefined,
  login: string,
  detail: string
): void {
  useLogFile(work.folderPath);
  logFailure("編集部の権利を外す", { 作品: work.title, 相手: login, 詳細: detail });
  const open = ref ? "GitHubで開く" : undefined;
  void vscode.window
    .showWarningMessage(
      `校閲中の印は外しましたが、${login} さんの権利は GitHub から外せませんでした（${detail}）。` +
        "GitHub の「Settings」→「Collaborators」で手で外してください。",
      ...(open ? [open] : [])
    )
    .then((action) => {
      if (action === open && ref) {
        void vscode.env.openExternal(
          vscode.Uri.parse(`${repositoryWebUrl(ref)}/settings/access`)
        );
      }
    });
}

async function confirmWithModal(
  work: WorkEntry,
  range: string | undefined,
  login: string | undefined
): Promise<boolean> {
  const lines = [
    range ? `・${range}の校閲中の印を外します` : "・校閲中の印はありません",
    login
      ? `・${login} さんの書き込みの権利を GitHub から外します`
      : "・編集部の名前が分からないため、GitHub の権利は外せません（GitHub の Settings で手で外してください）",
    "・編集部はこの作品に提案を返せなくなります",
    "・解除の記録は編集用リポジトリへも送ります",
  ];
  const answer = await vscode.window.showWarningMessage(
    `「${work.title}」の編集部との連携を解除しますか。`,
    {
      modal: true,
      detail:
        (range && login
          ? `${range}の校閲中の印を外し、${login} さんの書き込みの権利を外します。編集部はこの作品に提案を返せなくなります。\n\n`
          : "") + lines.join("\n"),
    },
    "解除する"
  );
  return answer === "解除する";
}
