import * as vscode from "vscode";
import type { WorkEntry } from "../models/types";
import { runGit, type GitCommandRunner } from "../core/git";
import { probeRepository } from "../core/githubCollaboration";
import {
  END_WORK_BUTTON,
  fetchTroubleMessage,
  fetchTroubleOf,
  githubHttpsRef,
  shouldProbeNow,
  type FetchTrouble,
} from "../core/editorFetchTrouble";
import { EDITOR_END_WORK_COMMAND } from "../core/stepDefs";
import { logFailure, logStep, useLogFile } from "../core/logger";
import { whenNoticePicked } from "../views/notify";
import { globalFetchTroubleMemory, type FetchTroubleMemory } from "./fetchTroubleMemory";

/**
 * 編集者の側で、取りに行き（git fetch）が失敗したあとに理由を見分けて知らせる
 * （設計書5.7.5.4。作者の決定 2026-11-07「分けて知らせる」）。
 *
 * 見分けは GitHub の API の返事で決める（`core/editorFetchTrouble.ts`。git の文は当てない）。
 * **API を引くのは取りに行きが失敗したときだけ。** 通ったときは何も引かない。
 *
 * このファイルは git（Node 専用）を使うので、同期の係などから**動的 import** で読む。
 */

export interface FetchTroubleDeps {
  run?: GitCommandRunner;
  /** GitHub の鍵。省けば `acquireGithubToken(false)`（窓を新しく出さない） */
  token?: () => Promise<string | undefined>;
  fetchImpl?: typeof fetch;
  now?: () => number;
  memory?: FetchTroubleMemory;
}

/** 作品ごとの、最後に API を引いた時刻（自動の取りに行きの間引き。端末の中だけで足りる） */
const lastProbedAt = new Map<string, number>();

/** 試験用：間引きの覚えを消す */
export function resetFetchTroubleProbes(): void {
  lastProbedAt.clear();
}

/**
 * 取りに行きが失敗した作品の、受け取れなかった理由を見分ける。
 *
 * @param auto 開いたときの自動の取りに行きか。自動なら作品ごとに10分に1回までしか引かない
 *   （間引いた回は `unknown`）。作者が押した操作（`auto: false`）は毎回引く
 */
export async function diagnoseFetchFailure(
  work: WorkEntry,
  options: { auto: boolean },
  deps: FetchTroubleDeps = {}
): Promise<FetchTrouble> {
  const now = (deps.now ?? Date.now)();
  if (options.auto && !shouldProbeNow(lastProbedAt.get(work.id), now)) return "unknown";
  lastProbedAt.set(work.id, now);

  const run = deps.run ?? runGit;
  try {
    const origin = await run(["remote", "get-url", "origin"], work.folderPath, 15_000);
    if (origin.code !== 0) return "unknown";
    const ref = githubHttpsRef(origin.stdout);
    if (!ref) return "unknown";
    const token = deps.token
      ? await deps.token()
      : await (await import("./shareWithEditor.js")).acquireGithubToken(false);
    const probe = await probeRepository(token, ref, deps.fetchImpl);
    useLogFile(work.folderPath);
    logStep(`受け取れなかった理由を GitHub に確かめた（${work.title}／${ref.owner}/${ref.repo}／${probe}）`);
    return fetchTroubleOf(probe);
  } catch (error) {
    // 見分けに失敗しても、受け取りの失敗の知らせは今までどおり出る（分からない側へ倒す）
    useLogFile(work.folderPath);
    logFailure("受け取れなかった理由の確かめ", {
      作品: work.title,
      詳細: error instanceof Error ? error.message : String(error),
    });
    return "unknown";
  }
}

/**
 * 見分けた理由の知らせを出す。出したら `true`（`unknown` は出さない。呼ぶ側が今までの文を出す）。
 *
 * 置き場に届かないときは［この作品の編集を終える］を付ける。押すと編集者メニューの
 * 同じ行（`EDITOR_END_WORK_COMMAND`）と同じ確認が出る。**ボタンの答えは待たない**
 * （`whenNoticePicked`）。
 */
export function showFetchTrouble(work: WorkEntry, trouble: FetchTrouble): boolean {
  const message = fetchTroubleMessage(trouble, work.title);
  if (!message) return false;
  if (trouble === "revoked") {
    whenNoticePicked(
      vscode.window.showWarningMessage(message, END_WORK_BUTTON),
      async (picked) => {
        if (picked !== END_WORK_BUTTON) return;
        await vscode.commands.executeCommand(EDITOR_END_WORK_COMMAND, { type: "work", work });
      },
      { label: "置き場に届かないときの知らせ", workFolder: work.folderPath }
    );
  } else {
    void vscode.window.showWarningMessage(message);
  }
  return true;
}

/**
 * 作者が押した操作（「1. 作者の最新の原稿を受け取る」「6. 校閲を終えて作者へ返す」）で
 * 取りに行きが失敗したときの見分けと知らせ。出したら `true`。
 *
 * 押した操作なので、もう知らせた作品でも出す。置き場に届かないと分かったら覚える
 * （開いたときの自動の取りに行きで、同じ知らせを重ねない）。
 */
export async function noticeManualFetchFailure(
  work: WorkEntry,
  deps: FetchTroubleDeps = {}
): Promise<{ trouble: FetchTrouble; shown: boolean }> {
  const trouble = await diagnoseFetchFailure(work, { auto: false }, deps);
  if (trouble === "revoked") await (deps.memory ?? globalFetchTroubleMemory).mark(work.id);
  return { trouble, shown: showFetchTrouble(work, trouble) };
}

/**
 * 開いたときの自動の取りに行きが失敗したときの見分け（編集者モードだけ。呼ぶ側が確かめる）。
 *
 * **置き場に届かないときだけ、同じ作品で1回だけ**知らせる。回線や分からないときは今までどおり
 * 黙る（オフラインでの校閲は普通にある）。もう知らせた作品では API も引かない。
 */
export async function noticeAutoFetchFailure(
  work: WorkEntry,
  deps: FetchTroubleDeps = {}
): Promise<FetchTrouble | "alreadyNotified"> {
  const memory = deps.memory ?? globalFetchTroubleMemory;
  if (memory.has(work.id)) return "alreadyNotified";
  const trouble = await diagnoseFetchFailure(work, { auto: true }, deps);
  if (trouble !== "revoked") return trouble;
  await memory.mark(work.id);
  showFetchTrouble(work, trouble);
  return trouble;
}
