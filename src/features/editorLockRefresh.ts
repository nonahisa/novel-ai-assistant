import type { WorkEntry } from "../models/types";
import { isEditorMode } from "../core/actorContext";
import { canRunProcesses } from "../core/runtime";
import { decideLockRefresh, type LockRefreshDecision } from "../core/lockRefreshPolicy";
import { logFailure, logStep, useLogFile } from "../core/logger";
import { readSite } from "./editingSite";

/**
 * 話を開いたときに、その作品の編集者の鍵の台帳を取りに行く（設計書5.7.5.2。作者の裁定 2026-11-07）。
 *
 * 原稿エディター（`manuscriptEditor.ts`）と素のエディター（`editorLockGuard.ts`）が、開いたときに呼ぶ。
 * どちらもブラウザ版の束に入るので、**git を使う `shareWithEditor.ts` は動的に読む**（実装ルール7）。
 *
 * 鍵が届いたら、台帳の書き込み（`FileLockStore`）が開いている面へ知らせる
 * （`onLockLedgerWritten`）。ここでは知らせを出さない。
 */

export interface LockRefreshDeps {
  now(): number;
  editorMode(): boolean;
  canRunProcesses(): boolean;
  /** 作品の `.aiwriter/editing.json` の `editorLogin`（渡していない・解除したなら undefined） */
  editorLogin(work: WorkEntry): Promise<string | undefined>;
  /** 鍵の台帳だけを取りに行く。失敗は投げてよい（ここでログへ残す） */
  fetchLocks(work: WorkEntry): Promise<void>;
}

/**
 * 取りに行く口を作る。**作品ごとに、最後に試した時刻を覚える**（5分の間を空けるため）。
 *
 * 時刻は取りに行く**前に**書く。開いた直後に原稿エディターと素のエディターの両方から
 * 呼ばれても（同じ文書の開く知らせは両方で鳴る）、2回目は取りに行かない。
 */
export function createLockRefresher(
  deps: LockRefreshDeps
): (work: WorkEntry) => Promise<LockRefreshDecision> {
  const lastAttemptAt = new Map<string, number>();
  return async (work) => {
    const now = deps.now();
    const decision = decideLockRefresh({
      editorLogin: deps.editorMode() || !deps.canRunProcesses() ? undefined : await deps.editorLogin(work),
      editorMode: deps.editorMode(),
      canRunProcesses: deps.canRunProcesses(),
      lastAttemptAt: lastAttemptAt.get(work.id),
      now,
    });
    if (!decision.go) return decision;
    lastAttemptAt.set(work.id, now);
    try {
      await deps.fetchLocks(work);
    } catch (error) {
      // 回線が無いなど。手元の台帳のまま（作者へは出さない。開くたびに知らせが出るのを避ける）
      useLogFile(work.folderPath);
      logFailure("編集者の鍵の台帳を取りに行けませんでした（手元の台帳のまま）", {
        作品: work.title,
        詳細: error instanceof Error ? error.message : String(error),
      });
    }
    return decision;
  };
}

const defaultDeps: LockRefreshDeps = {
  now: () => Date.now(),
  editorMode: isEditorMode,
  canRunProcesses,
  editorLogin: async (work) => (await readSite(work)).editorLogin,
  fetchLocks: async (work) => {
    const { refreshEditorLocksQuietly } = await import("./shareWithEditor.js");
    const result = await refreshEditorLocksQuietly(work);
    useLogFile(work.folderPath);
    if (result.status === "fetchFailed") {
      // git の生の文は画面に出さず、ログへ（実装ルール5）
      logFailure("編集者の鍵の台帳を取りに行けませんでした（手元の台帳のまま）", {
        作品: work.title,
        詳細: result.detail,
      });
    } else if (result.status === "done" && (result.locksAcquired.length > 0 || result.locksReleased.length > 0)) {
      logStep(
        `編集者の鍵の台帳を取りに行きました（校閲中になった話 ${result.locksAcquired.length}、` +
          `終わった話 ${result.locksReleased.length}）`
      );
    }
  },
};

/** 話を開いたときに呼ぶ（待たなくてよい。失敗はログだけ） */
export const refreshEditorLocksOnOpen = createLockRefresher(defaultDeps);
