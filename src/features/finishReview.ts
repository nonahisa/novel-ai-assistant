import * as vscode from "vscode";
import type { WorkEntry } from "../models/types";
import { isEditorMode, recordEdit } from "../core/actorContext";
import { tryGitUserName } from "../core/gitAttribution";
import {
  commitPaths,
  parseStatusPorcelainPaths,
  push,
  readSyncStatus,
  runGit,
  runGitForPaths,
  type GitCommandRunner,
} from "../core/git";
import { FileLockStore } from "../core/fileLockStore";
import { ProposalStore } from "../core/proposalStore";
import {
  changesOutsideLedger,
  editingQueueKey,
  LEDGER_DIRECTORY,
} from "../core/editingRepo";
import { runSerialized } from "../core/ledgerQueue";
import { pushWasRejected, reconcileDiverged } from "./shareWithEditor";
import { logFailure, logStep, useLogFile } from "../core/logger";
import { withProgress } from "../views/progress";
import { notifyDone } from "../views/notify";

/**
 * 校閲を終えて、作者へ返す（編集者モード専用。作者の裁定、2026-10-28）。
 *
 * 1. この編集者が押さえている鍵（校閲のロック）を全部外す
 * 2. `.aiwriter`（提案・鍵・編集履歴）だけを記録して送る
 *
 * **本文は記録に含めない。** 編集者モードは本文を書き換えない作りだが、念のため
 * 本文に未記録の変更があれば、何も送らずに止めて理由を出す（編集部の書きかけを
 * 作者の原稿の履歴へ流さない）。
 *
 * **`GitSyncMonitor.push` は使わない。** あちらは確認を出し、記録(commit)もしない。
 * ここでは記録の対象を `.aiwriter` に限りたいので、`core/git` を直に呼ぶ。
 */
export interface FinishReviewDeps {
  run?: GitCommandRunner;
  /** 送る前の確認。`true` で進む */
  confirm?: (summary: { locks: number; proposals: number }) => Promise<boolean>;
  /** 誰の名前で鍵を押さえていたか */
  whoAmI?: (work: WorkEntry) => Promise<string>;
}

export type FinishReviewResult =
  | { kind: "done"; released: number; proposals: number }
  | { kind: "notEditor" }
  | { kind: "notTracked" }
  | { kind: "unmerged" }
  | { kind: "bodyChanged"; files: string[] }
  | { kind: "cancelled" }
  | { kind: "failed"; detail: string };

export async function finishReviewAndReturn(
  work: WorkEntry,
  deps: FinishReviewDeps = {}
): Promise<FinishReviewResult> {
  const run = deps.run ?? runGit;

  if (!isEditorMode()) {
    void vscode.window.showInformationMessage(
      "「校閲を終えて返す」は、編集者モードで使う操作です。"
    );
    return { kind: "notEditor" };
  }

  const status = await readSyncStatus(work.folderPath, run);
  if (status.kind !== "tracked") {
    void vscode.window.showWarningMessage(
      "この作品はまだ GitHub とつながっていません。先に「GitHubと同期」で取り寄せてください。"
    );
    return { kind: "notTracked" };
  }
  if (status.unmerged > 0) {
    void vscode.window.showWarningMessage(
      "競合が残っています。先に「競合解決」で片づけてください。"
    );
    return { kind: "unmerged" };
  }

  // **本文に未記録の変更があれば、何もせずに止める。**
  const working = await run(
    ["status", "--porcelain", "-z", "--untracked-files=all"],
    work.folderPath,
    15_000
  );
  if (working.code !== 0) {
    return fail(work, "作業フォルダーの状態を読めませんでした");
  }
  const outside = changesOutsideLedger(parseStatusPorcelainPaths(working.stdout));
  if (outside.length > 0) {
    const shown = outside.slice(0, 5).join("、");
    void vscode.window.showWarningMessage(
      "本文に未記録の変更があるため、送らずに止めました" +
        `（${shown}${outside.length > 5 ? " ほか" : ""}）。` +
        "編集者モードは本文を書き換えない作りです。変更を元に戻してからもう一度押してください。"
    );
    return { kind: "bodyChanged", files: outside };
  }

  const who = deps.whoAmI
    ? await deps.whoAmI(work)
    : ((await tryGitUserName(work.folderPath)) ?? "");
  const locks = new FileLockStore(work);
  const mine = [...(await locks.load()).values()].filter(
    (lock) => lock.holderKind === "editor" && lock.holder === who
  );
  const proposals = (await new ProposalStore(work).load()).filter(
    (entry) => entry.status === "pending"
  ).length;

  const confirmed = deps.confirm
    ? await deps.confirm({ locks: mine.length, proposals })
    : await confirmWithModal(work, mine.length, proposals);
  if (!confirmed) return { kind: "cancelled" };

  const done = await withProgress("校閲を終えて、作者へ返しています…", async () => {
    if (mine.length > 0) {
      await locks.release(
        mine.map((lock) => lock.file),
        who,
        "editor"
      );
      for (const lock of mine) {
        await recordEdit(work, {
          actor: "editor",
          action: "校閲のロックを外した",
          file: lock.file.split("/").pop() ?? lock.file,
          detail: "校閲を終えて返す",
        });
      }
    }

    return publishLedgerQuietly(work, "校閲を終えて返す", run);
  });
  if (done) return fail(work, done);

  useLogFile(work.folderPath);
  logStep(`校閲を終えて返した（${work.title}／鍵 ${mine.length}件・提案 ${proposals}件）`);
  notifyDone(`校閲を終えて、提案 ${proposals} 件を作者へ返しました。`);
  return { kind: "done", released: mine.length, proposals };
}

/** `.aiwriter` だけを記録する。変わりが無ければ何もしない。失敗の理由、無ければ `undefined` */
async function commitLedger(
  work: WorkEntry,
  message: string,
  run: GitCommandRunner
): Promise<string | undefined> {
  const staged = await runGitForPaths(
    run,
    ["add", "-A"],
    [LEDGER_DIRECTORY],
    work.folderPath,
    15_000
  );
  if (staged.code !== 0) return `記録の準備に失敗しました: ${staged.stderr.trim()}`;

  // 記録するものがあるときだけ記録する（`.aiwriter` に変わりが無いこともある）
  const quiet = await run(
    ["diff", "--cached", "--quiet", "--", LEDGER_DIRECTORY],
    work.folderPath,
    15_000
  );
  if (quiet.code !== 0) {
    const committed = await commitPaths(
      run,
      message,
      [LEDGER_DIRECTORY],
      work.folderPath,
      15_000
    );
    if (committed.code !== 0) {
      return `記録に失敗しました: ${(committed.stderr || committed.stdout).trim()}`;
    }
  }
  return undefined;
}

/**
 * 台帳（`.aiwriter`）だけを記録して送る。失敗の理由、無ければ `undefined`。
 *
 * **断られたら（fetch して相手が先に進んでいたら）、台帳を混ぜて合わせ直して、
 * もう1回だけ送る。** 編集部の側は本文を書かないので、本文は相手の側をそのまま使う
 * （作者が先に送り直していても、ここで止まったまま分かれない）。
 */
export async function publishLedger(
  work: WorkEntry,
  message: string,
  run: GitCommandRunner = runGit
): Promise<string | undefined> {
  const committed = await commitLedger(work, message, run);
  if (committed) return committed;

  let sent = await push(work.folderPath, run);
  if (!sent.ok && (await pushWasRejected(work.folderPath, run))) {
    logStep(`送信が断られたので、台帳を混ぜて合わせ直して送り直す（${work.title}）`);
    const reconciled = await reconcileDiverged(work.folderPath, run);
    if (!reconciled.ok) return reconciled.detail;
    const again = await commitLedger(work, message, run);
    if (again) return again;
    sent = await push(work.folderPath, run);
  }
  if (!sent.ok) {
    return `送信に失敗しました: ${sent.detail ?? "（詳細なし）"}`;
  }
  return undefined;
}

/** `publishLedger` を、編集用フォルダーの順番待ちに載せて呼ぶ（記録して知らせるだけの静かな口） */
export function publishLedgerQuietly(
  work: WorkEntry,
  message: string,
  run: GitCommandRunner = runGit
): Promise<string | undefined> {
  return runSerialized(editingQueueKey(work.folderPath), () =>
    publishLedger(work, message, run)
  );
}

async function confirmWithModal(
  work: WorkEntry,
  locks: number,
  proposals: number
): Promise<boolean> {
  const answer = await vscode.window.showWarningMessage(
    `「${work.title}」の校閲を終えて、作者へ返します。`,
    {
      modal: true,
      detail: [
        `・押さえている校閲のロック ${locks} 件を外します`,
        `・提案 ${proposals} 件（未決）を含む、提案・ロック・編集履歴を GitHub へ送ります`,
        "・本文は送りません",
      ].join("\n"),
    },
    "返す"
  );
  return answer === "返す";
}

function fail(work: WorkEntry, detail: string): FinishReviewResult {
  useLogFile(work.folderPath);
  logFailure("校閲を終えて返す", { 作品: work.title, 詳細: detail });
  void vscode.window.showErrorMessage(`校閲を終えて返せませんでした: ${detail}`);
  return { kind: "failed", detail };
}
