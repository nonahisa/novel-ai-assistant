import * as vscode from "vscode";
import type { WorkEntry } from "../models/types";
import { isEditorMode, recordEdit } from "../core/actorContext";
import { editHistoryFile } from "../core/editHistoryFormat";
import * as paths from "../core/paths";
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
import { notifyDone, whenNoticePicked } from "../views/notify";
import { findAction } from "../core/actionTree";
import { CHOOSE_TEXT_TO_KEEP } from "../core/gitSyncMenuText";
import { globalFetchTroubleMemory } from "./fetchTroubleMemory";
import { keysForHost } from "../core/keyLabels";
import { findMissingWorksAt, noticeMissingWorksForEditor } from "./missingWorksNotice";

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
  /** 登録済みの作品すべて（同じ置き場に、フォルダーが無い作品が無いかを見る） */
  works?: readonly WorkEntry[];
  /** 送る前の確認。`true` で進む */
  confirm?: (summary: { locks: number; proposals: number }) => Promise<boolean>;
  /** 誰の名前で鍵を押さえていたか */
  whoAmI?: (work: WorkEntry) => Promise<string>;
  /**
   * 送れなかったときの理由の見分けと知らせ（試験の差し替え口）。省けば GitHub の API で
   * 見分ける（`editorFetchTrouble.ts`）。知らせを出したら `shown: true`
   */
  noticeFetchTrouble?: (
    work: WorkEntry
  ) => Promise<{ trouble: "revoked" | "offline" | "unknown"; shown: boolean }>;
}

export type FinishReviewResult =
  | { kind: "done"; released: number; proposals: number }
  | { kind: "notEditor" }
  | { kind: "notTracked" }
  /** 写し（または同じ置き場の登録済みの作品）のフォルダーが見つからない（題名） */
  | { kind: "missing"; works: string[] }
  | { kind: "unmerged" }
  | { kind: "bodyChanged"; files: string[] }
  | { kind: "cancelled" }
  | {
      kind: "failed";
      detail: string;
      /** GitHub の API で見分けた理由（専用の知らせを出したときだけ） */
      trouble?: "revoked" | "offline" | "unknown";
    };

/** 本文の書き換えを見つけたときの知らせのボタン（VS Code のソース管理を開く） */
export const OPEN_SOURCE_CONTROL = "ソース管理を開く";

/**
 * 本文の書き換えの戻し方（1文）。ソース管理の「変更を破棄」は VS Code の標準の操作で、
 * 押す前に VS Code が確かめる
 */
export const BODY_CHANGE_UNDO_HINT =
  keysForHost("［ソース管理を開く］で開く一覧で、戻す話を右クリックして「変更を破棄」を選ぶと元に戻せます。") +
  "戻してから、もう一度押してください。";

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

  /*
    **写し（作品のフォルダー）が見つからなければ、git を呼ぶ前に止める**（2026-11-14。
    設計書5.5.14）。無いフォルダーでは git が起動せず「まだ GitHub とつながっていません」と
    事実と違う案内になり、記録の書き先を写しへ向けると写しのフォルダーを作り直すおそれがある
    （記録係は 0.152.7 から無い作品へ書かないが、ここでも向けない）。同じ置き場の登録済みの
    作品が無いときも止める（台帳の記録は `.aiwriter` だけだが、送る置き場は同じ）
  */
  const gone = await findMissingWorksAt(work.folderPath, deps.works ?? [work], run);
  if (gone.length > 0) {
    const present = (deps.works ?? []).find(
      (one) => !gone.some((missing) => missing.id === one.id)
    );
    noticeMissingWorksForEditor(present?.folderPath, gone);
    return { kind: "missing", works: gone.map((one) => one.title) };
  }

  const status = await readSyncStatus(work.folderPath, run);
  if (status.kind !== "tracked") {
    // 「GitHubと同期」は詳細メニューから外した（作者の判断 2026-11-01）。編集者が
    // 作品を受け取る入口は「編集者として参加」
    void vscode.window.showWarningMessage(
      "この作品はまだ GitHub とつながっていません。" +
        `先に「${findAction("novelai.joinAsEditor")?.label ?? "編集者として参加"}」で受け取ってください。`
    );
    return { kind: "notTracked" };
  }
  if (status.unmerged > 0) {
    // 「競合解決」は詳細メニューから外したので、残す文を選ぶ画面をボタンで開く。
    // **答えは待たない**（押さずに置かれても、この操作は終わっている）
    whenNoticePicked(
      vscode.window.showWarningMessage(
        "どちらの文を残すか決まっていない原稿があります。残す文を選んでから、もう一度押してください。",
        CHOOSE_TEXT_TO_KEEP
      ),
      async (picked) => {
        if (picked !== CHOOSE_TEXT_TO_KEEP) return;
        await vscode.commands.executeCommand("novelai.resolveConflicts", {
          type: "work",
          work,
        });
      },
      { label: "校閲を終えて返す", workFolder: work.folderPath }
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
    /*
      **戻し方まで言う**（作者の判断 2026-11-01、洗い出しの3）。以前は「変更を元に
      戻してから」とだけ言い、戻す道が無かった。

      **ここでは戻さない**——戻すのは作者の原稿の本文の書き換えを捨てることで、
      取り消せない。未追跡のファイルなら消すことになる。どの話を戻すかは編集者が
      見て決められるよう、VS Code のソース管理（変更の一覧と「変更を破棄」がある）を
      ボタンで開き、戻し方を1文で言う
    */
    whenNoticePicked(
      vscode.window.showWarningMessage(
        "本文に未記録の変更があるため、送らずに止めました" +
          `（${shown}${outside.length > 5 ? " ほか" : ""}）。` +
          "編集者モードは本文を書き換えない作りです。" +
          BODY_CHANGE_UNDO_HINT,
        OPEN_SOURCE_CONTROL
      ),
      async (picked) => {
        if (picked === OPEN_SOURCE_CONTROL) {
          await vscode.commands.executeCommand("workbench.view.scm");
        }
      },
      { label: "校閲を終えて返す", workFolder: work.folderPath }
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
          // 名前だけにしない（ほかの章の同じ名前の話と取り違える。0.130.4）。
          // ロックの台帳の file は作品からの相対（`normalizeFile` 済み）
          file: editHistoryFile(
            work.folderPath,
            paths.join(work.folderPath, ...lock.file.split("/").filter(Boolean))
          ),
          detail: "校閲を終えて返す",
        });
      }
    }

    return runSerialized(editingQueueKey(work.folderPath), () =>
      publishLedgerResult(work, "校閲を終えて返す", run)
    );
  });
  if (done) {
    // **GitHub とのやり取りで止まったなら、理由を GitHub の API で見分けて知らせる**
    // （設計書5.7.5.4。作者の決定 2026-11-07）。git の文はログへだけ残し、画面へは出さない。
    // 分からなければ今までの文のまま
    if (done.remote) {
      const notice =
        deps.noticeFetchTrouble ??
        (async (target: WorkEntry) =>
          (await import("./editorFetchTrouble.js")).noticeManualFetchFailure(target, { run }));
      try {
        const { shown, trouble } = await notice(work);
        if (shown) {
          useLogFile(work.folderPath);
          logFailure("校閲を終えて返す", { 作品: work.title, 詳細: done.detail });
          return { kind: "failed", detail: done.detail, trouble };
        }
      } catch (error) {
        useLogFile(work.folderPath);
        logFailure("校閲を終えて返す：受け取れなかった理由の見分け", {
          作品: work.title,
          詳細: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return fail(work, done.detail);
  }

  // 届いたので、「置き場に届きません」の覚えを消す（次にまた届かなくなったら、また知らせる）
  await globalFetchTroubleMemory.clear(work.id);
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
  return (await publishLedgerResult(work, message, run))?.detail;
}

/**
 * 台帳だけを記録して送った失敗。`remote` は GitHub とのやり取り（送信・合わせ直しの取り寄せ）で
 * 止まったか——手元の記録の失敗まで「ネットにつながっていない」と見分けに回さないため
 */
interface PublishFailure {
  detail: string;
  remote: boolean;
}

async function publishLedgerResult(
  work: WorkEntry,
  message: string,
  run: GitCommandRunner
): Promise<PublishFailure | undefined> {
  const local = (detail: string): PublishFailure => ({ detail, remote: false });
  // **頭で、本文などの未記録の変更が無いか確かめる**（「返す」の確認と同じ検査）。
  // 「校閲の範囲を知らせる」など、ほかの入口から呼ばれても、台帳の外には触れない
  const working = await run(
    ["status", "--porcelain", "-z", "--untracked-files=all"],
    work.folderPath,
    15_000
  );
  if (working.code !== 0) return local("作業フォルダーの状態を読めませんでした");
  const outside = changesOutsideLedger(parseStatusPorcelainPaths(working.stdout));
  if (outside.length > 0) {
    return local(
      `本文などに未記録の変更があるため、送りませんでした（${outside.slice(0, 3).join("、")}）`
    );
  }

  const committed = await commitLedger(work, message, run);
  if (committed) return local(committed);

  let sent = await push(work.folderPath, run);
  if (!sent.ok && (await pushWasRejected(work.folderPath, run))) {
    logStep(`送信が断られたので、台帳を混ぜて合わせ直して送り直す（${work.title}）`);
    // 台帳3本以外に変更か送れていない記録があれば、reset せずに止める（黙って消さない）
    const reconciled = await reconcileDiverged(work.folderPath, run, { ledgerOnly: true });
    if (!reconciled.ok) return { detail: reconciled.detail, remote: true };
    const again = await commitLedger(work, message, run);
    if (again) return local(again);
    sent = await push(work.folderPath, run);
  }
  if (!sent.ok) {
    return { detail: `送信に失敗しました: ${sent.detail ?? "（詳細なし）"}`, remote: true };
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
        `・校閲中にしているファイルのロック ${locks} 件を外します`,
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
