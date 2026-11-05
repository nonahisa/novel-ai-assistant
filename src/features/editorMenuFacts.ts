import * as vscode from "vscode";
import * as path from "../core/paths";
import type { WorkEntry } from "../models/types";
import type { GitSyncStatus } from "../core/git";
import { FileLockStore } from "../core/fileLockStore";
import { ProposalStore } from "../core/proposalStore";
import { tryGitUserName } from "../core/gitAttribution";
import {
  describeLockRange,
  EDITING_SITE_FILE,
  EDITOR_SHARE_MANIFEST_FILE,
} from "../core/editingRepo";
import { workPaths } from "../core/workRegistry";
import { isJoinedWork, type EditorCopyMark } from "../core/editorWorks";
import {
  lastReceivedFromReflog,
  type EditorProgressFacts,
} from "../core/editorProgress";
import type { DecisionMemory } from "./decisionMemory";

/**
 * 編集者メニューの進み具合に使う事実を、既にある台帳から読み集める（設計書5.6.6）。
 *
 * **判定はしない**（`core/editorProgress.ts` の `judgeEditorProgress`）。ここは読むだけで、
 * 作品フォルダーにも保管にも何も書かない。
 *
 * **ブラウザ版でも動く形で書く**（実装ルール7）。git は呼ばず、同期の見張りが持っている
 * 控え（`statusFor`）と、`.git/logs/HEAD` をファイルとして読むだけにする
 */
export interface EditorMenuFactsDeps {
  /** 同期の見張りの控え（`GitSyncMonitorLike.statusFor`） */
  syncStatus: (work: WorkEntry) => GitSyncStatus | undefined;
  /** もう知らせた採否の覚え */
  decisionMemory: DecisionMemory;
  /** 自分の名前（git の user.name）。試験で差し替える */
  whoAmI?: (work: WorkEntry) => Promise<string | undefined>;
}

export interface EditorMenuFacts {
  facts: EditorProgressFacts;
  /** 校閲中の話の範囲（「第3話〜第5話」など）。鍵が無ければ undefined */
  rangeText?: string;
}

/** 名前は作品ごとに1回だけ訊く（git を毎回起こさない）。読めなければ空で覚える */
const nameCache = new Map<string, string>();

async function cachedName(
  work: WorkEntry,
  whoAmI: (work: WorkEntry) => Promise<string | undefined>
): Promise<string> {
  const known = nameCache.get(work.folderPath);
  if (known !== undefined) return known;
  const name = (await whoAmI(work).catch(() => undefined)) ?? "";
  nameCache.set(work.folderPath, name);
  return name;
}

export async function readEditorMenuFacts(
  work: WorkEntry,
  deps: EditorMenuFactsDeps
): Promise<EditorMenuFacts> {
  const who = await cachedName(work, deps.whoAmI ?? ((target) => tryGitUserName(target.folderPath)));
  const [locks, proposals] = await Promise.all([
    new FileLockStore(work).load().catch(() => new Map()),
    new ProposalStore(work).load().catch(() => []),
  ]);
  /*
    **自分のものだけを数える**（「校閲を終えて返す」が外す鍵と同じ見方。`finishReview.ts`）。
    名前が読めないとき（ブラウザ版・git の名前が未設定）は、編集者の鍵と台帳の提案を
    すべて自分のものとして数える——編集者の写しの台帳に提案を置くのは編集者だけで、
    たいていは1人である
  */
  const myLocks = [...locks.values()].filter(
    (lock) => lock.holderKind === "editor" && (who === "" || lock.holder === who)
  );
  const myProposals = proposals.filter((view) => who === "" || view.proposer === who);

  const status = deps.syncStatus(work);
  const sync =
    status?.kind === "tracked"
      ? { behind: status.behindHere, ahead: status.aheadHere, dirty: status.dirtyHere }
      : undefined;
  const root = status && "root" in status ? status.root : work.folderPath;

  return {
    facts: {
      sync,
      myLocks,
      myProposals,
      seenDecisions: deps.decisionMemory.seen(work.id),
      lastReceivedAt: await readLastReceived(root),
    },
    rangeText: myLocks.length > 0 ? describeLockRange(myLocks.map((lock) => lock.file)) : undefined,
  };
}

/** `.git/logs/HEAD` を読む。置き場が作業場（`.git` がファイル）などで読めなければ undefined */
async function readLastReceived(root: string): Promise<string | undefined> {
  try {
    const bytes = await vscode.workspace.fs.readFile(
      path.toUri(path.join(root, ".git", "logs", "HEAD"))
    );
    return lastReceivedFromReflog(new TextDecoder().decode(bytes));
  } catch {
    return undefined;
  }
}

/**
 * 作品フォルダーの写しの印を読む（`core/editorWorks.ts` の `isJoinedWork` へ渡す）。
 * 写しの印（`.aiwriter/editor-share-manifest.json`）が在り作者の印（`.aiwriter/editing.json`）が無ければ
 * `present`、写しの印が無いと確かめられれば `absent`、どちらとも言えなければ `unknown`（出す側に倒す）
 */
export async function editorCopyMarkOf(work: WorkEntry): Promise<EditorCopyMark> {
  const state = async (name: string): Promise<"present" | "absent" | "unreadable"> => {
    try {
      const stat = await vscode.workspace.fs.stat(
        path.toUri(path.join(workPaths(work).aiwriter, name))
      );
      return stat.type === vscode.FileType.File ? "present" : "unreadable";
    } catch (error) {
      return error instanceof vscode.FileSystemError && error.code === "FileNotFound"
        ? "absent"
        : "unreadable";
    }
  };
  const copy = await state(EDITOR_SHARE_MANIFEST_FILE);
  if (copy === "absent") return "absent";
  if (copy === "unreadable") return "unknown";
  return (await state(EDITING_SITE_FILE)) === "present" ? "unknown" : "present";
}

/** 編集者メニューに出す作品（参加した作品だけ。自分の作品は出さない。設計書5.6.6） */
export async function joinedWorksOf(works: readonly WorkEntry[]): Promise<WorkEntry[]> {
  const marks = await Promise.all(
    works.map((work) =>
      work.joinedAsEditor ? Promise.resolve<EditorCopyMark>("present") : editorCopyMarkOf(work)
    )
  );
  return works.filter((work, index) => isJoinedWork(work, marks[index]));
}
