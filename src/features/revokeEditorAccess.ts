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
  forgetEditorLogin,
  hasOrigin,
  readPointer,
  readSite,
  sendToEditor,
  writePointer,
  type EditingPointer,
  type EditingSite,
} from "./shareWithEditor";

/**
 * 編集部との連携を解除する（作者モード専用。作者の裁定、2026-10-28）。
 *
 * 基本は「校閲中の話は書けなくする」だが、編集部と決裂したときのために、
 * 作者の側から解く手段を置く。
 *
 * 1. 編集部の鍵を、作者の名で release する（鍵の台帳に解除の行を足し、編集履歴にも残す）
 * 2. 解除の行を編集用リポジトリへ送る（編集部の側に、鍵が解けたことが届く）。
 *    **権利を外す前に送る**（作者の決定 2026-11-07）。送れなくても次へ進む
 * 3. GitHub で編集部の権利を外す（共同編集者なら DELETE collaborators、
 *    招待を受ける前なら DELETE invitations）。**外せなくても、鍵は外す。**
 *    その場合は「GitHub の Settings→Collaborators で手で外してください」と案内する
 * 4. `.aiwriter/editing.json` の `editorLogin` を消す（次に渡すとき、相手の名前を訊き直す。
 *    名前は `formerEditorLogin` に写し、訊く欄の初めの値にする。0.138.0）
 * 5. 権利を外せたら、編集用リポジトリも GitHub から消すかを訊く（`deleteEditingRepository.ts`）
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
  /** 解除の行を編集用リポジトリへ送る口（試験用。省けば `sendToEditor`） */
  send?: typeof sendToEditor;
  /** 解除の終わりに、編集用リポジトリも消すかを訊く口（試験用。省けば `deleteEditingRepositoryFlow`） */
  offerDelete?: (work: WorkEntry) => Promise<void>;
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
      "編集者との連携を解除できるのは作者です（編集者モードでは使えません）。"
    );
    return { kind: "notAuthorMode" };
  }
  const run = deps.run ?? runGit;
  const pointer = await readPointer(work);
  const site = await readSite(work);
  if (!pointer && !site.remoteUrl && !site.editorLogin) {
    void vscode.window.showInformationMessage(
      `「${work.title}」はまだ編集者へ渡していません。解除するものがありません。`
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
        "編集者との連携を解除"
      );
      await recordEdit(work, {
        actor: "author",
        action: "編集者との連携を解除（校閲の鍵を外した）",
        file: range ?? "",
        detail: login ? `${login} さんの権利を外します` : "",
      });
    }

    // 2. 解除の行を編集用リポジトリへ送る。**権利を外す前に送る**（作者の決定 2026-11-07
    // 「先に送ってから権利を外す」）。外したあとでは、編集者の側へ「校閲中の印が外れた」が
    // 届く前に置き場が見えなくなる。送れなくても権利は外す（決裂したときの解除なので止めない）
    if (pointer && (await hasOrigin(pointer.folderPath, run))) {
      const sent = await (deps.send ?? sendToEditor)(work, pointer.folderPath, {
        run,
        pointer,
        site,
        allowCreate: false,
        message: `${work.title} の編集部との連携を解除`,
      });
      if (!sent.ok) {
        useLogFile(work.folderPath);
        logFailure("連携の解除を編集用リポジトリへ送る", { 作品: work.title, 詳細: sent.detail });
        void vscode.window.showWarningMessage(
          "解除の記録を編集用リポジトリへ送れませんでした。あとで「編集者へ渡す」を押すと送れます。" +
            `（${sent.detail}）`
        );
      }
    }

    // 3. GitHub で権利を外す。外せなくても、鍵は外した
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
          logStep(`編集者の権利を外した: ${login}（${ref.owner}/${ref.repo}／${result.outcome}）`);
        } else {
          github = "failed";
          reportRevokeFailure(work, ref, login, result.detail);
        }
      }
    } else if (login) {
      reportRevokeFailure(work, undefined, login, "送り先のリポジトリが分かりません");
      github = "failed";
    }

    // 4. 相手の名前を忘れる（次に渡すとき訊き直す）。**読み直してから外す**——送りの途中で
    // 送り先（`remoteUrl`）が書き足されていることがある（`sendToEditor` の `onCreated`）
    // **名前は「前の編集者」として残す**（`formerEditorLogin`。作者の答え 2026-11-07）。次に渡すとき
    // 訊く欄の初めの値になる。ほかの項目は、知らないものも含めて残す（`forgetEditorLogin`）
    try {
      await forgetEditorLogin(work, login);
    } catch (error) {
      useLogFile(work.folderPath);
      logFailure("編集者の名前の記録を外す", {
        作品: work.title,
        詳細: error instanceof Error ? error.message : String(error),
      });
    }
    // 古い版はこの端末の場所の覚えにも名前を書いていた。残すと次の「渡す」が名前を訊かず、
    // 招待も送らない（`site.editorLogin ?? pointer?.editorLogin`）ので、ここでも外す
    if (pointer?.editorLogin) {
      const rest: EditingPointer = { ...pointer };
      delete rest.editorLogin;
      await writePointer(work, rest);
    }
    return { kind: "done", released: mine.length, github };
  };

  // 同じ編集用フォルダーの作業は1本ずつ（自動の送り返し・取り込みと重ならない）
  const result = await withProgress("編集者との連携を解除しています…", () =>
    pointer ? runSerialized(editingQueueKey(pointer.folderPath), work1) : work1()
  );

  useLogFile(work.folderPath);
  if (result.kind === "done" && result.github !== "failed") {
    notifyDone(
      "編集者との連携を解除しました。" +
        (range ? `${range}の校閲中の印を外しました。` : "")
    );
    // **解除の終わりに、編集用リポジトリも消すかを訊く**（作者の決定 2026-11-07）。権利を
    // 外せなかったときは訊かない（手で外す案内が先に出ており、窓を重ねると読み落とす。
    // 消すのは「編集者連携」のメニューの「リポジトリを消す」からいつでもできる）
    const offer =
      deps.offerDelete ??
      (async (target: WorkEntry) => {
        const { deleteEditingRepositoryFlow } = await import("./deleteEditingRepository.js");
        await deleteEditingRepositoryFlow(target, { afterRevoke: true });
      });
    try {
      await offer(work);
    } catch (error) {
      useLogFile(work.folderPath);
      logFailure("解除のあとの、編集用リポジトリを消すかの問い", {
        作品: work.title,
        詳細: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return result;
}

/** 送り先のリポジトリ（覚えている URL、なければ編集用フォルダーの origin） */
export async function remoteRef(
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
  logFailure("編集者の権利を外す", { 作品: work.title, 相手: login, 詳細: detail });
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
      : "・編集者の名前が分からないため、GitHub の権利は外せません（GitHub の Settings で手で外してください）",
    "・編集者はこの作品に提案を返せなくなります",
    "・解除の記録は編集用リポジトリへも送ります",
  ];
  const answer = await vscode.window.showWarningMessage(
    `「${work.title}」の編集者との連携を解除しますか。`,
    {
      modal: true,
      detail:
        (range && login
          ? `${range}の校閲中の印を外し、${login} さんの書き込みの権利を外します。編集者はこの作品に提案を返せなくなります。\n\n`
          : "") + lines.join("\n"),
    },
    "解除する"
  );
  return answer === "解除する";
}
