import * as vscode from "vscode";
import type { WorkEntry } from "../models/types";
import { postingSiteInfo, type PostingLedger } from "../models/posting";
import { PostingStore, PostingStoreError } from "../core/postingStore";
import { logFailure, logLine, useLogFile } from "../core/logger";
import {
  isPostingKitActive,
  planPendingSettlement,
  prunePendingOfUnknownWorks,
  settlePendingUpdates,
  storedPostingUpdatesOf,
  workIdsWithPendingUpdates,
  type QueuedPostingUpdate,
  type StoredPostingUpdate,
} from "./postingKitSession";

/**
 * 保管庫に残した預かり（ヘルパーから届いた番号）を台帳へ入れて片づける（設計書6.68.8）。
 *
 * 呼ばれるのは2か所：投稿キットの案内を終えるとき（案内が最後に持っていた台帳と店で）と、
 * VS Code を開いたとき（`settlePendingOnStartup`）。決まりは `postingKitSession.ts` の冒頭。
 *
 * **台帳の保存が済んでから保管庫を片づける**——先に消すと、保存が止まったときに番号を失う。
 */
export async function settlePendingForWork(input: {
  work: WorkEntry;
  store: PostingStore;
  ledger: PostingLedger;
  /** 何のときか（ログと知らせの言い方） */
  trigger: "kitEnd" | "startup";
  stored?: readonly StoredPostingUpdate[];
  /** 台帳を保存する（投稿キットは自分の保存の道を通す。失敗を知らせるのも保存の側） */
  save(ledger: PostingLedger): Promise<boolean>;
}): Promise<boolean> {
  const stored = input.stored ?? storedPostingUpdatesOf(input.work.id);
  if (stored.length === 0) return false;
  const plan = planPendingSettlement(input.ledger, stored);
  useLogFile(input.work.folderPath);
  if (plan.changed) {
    if (!(await input.save(plan.ledger))) {
      // 保存が止まった。保管庫は変えない（次の機会にもう一度当てる）
      logLine(`ヘルパーから届いた番号を投稿の記録へ入れられませんでした（保存できなかったため、預かったままにします）。`);
      return false;
    }
  }
  await settlePendingUpdates(input.work.id, stored, plan.keep);

  const written = stored.length - plan.keep.length - plan.dropped.length;
  if (plan.changed && written > 0) {
    logLine(
      `ヘルパーから届いた番号を${written}件、投稿の記録へ入れました（${input.work.title}、` +
        (input.trigger === "kitEnd" ? "投稿キットを終えるとき" : "VS Code を開いたとき") +
        "）。"
    );
    if (input.trigger === "startup") {
      void vscode.window.showInformationMessage(
        `「${input.work.title}」に、前に受け取った投稿した話の番号を${written}件入れました。`
      );
    }
  }
  if (plan.dropped.length > 0) {
    for (const entry of plan.dropped) logLine(`ヘルパーから届いた${describe(entry.update)}を消しました：${entry.reason}`);
    void vscode.window.showWarningMessage(
      `ヘルパーから届いた番号のうち${plan.dropped.length}件は、投稿の記録へ入れずに預かりから外しました` +
        `（${plan.dropped.map((entry) => entry.reason).slice(0, 2).join("／")}。出力パネルに記録しました）。` +
        "入れたいときは、その話の画面でヘルパーのボタンをもう一度押してください。"
    );
  }
  if (plan.keep.length > 0) {
    for (const row of plan.keep) logLine(`ヘルパーから届いた${describe(row.update)}を預かったままにします：投稿の記録がまだありません。`);
    if (input.trigger === "kitEnd") {
      void vscode.window.showInformationMessage(
        `ヘルパーから届いた番号のうち${plan.keep.length}件は、まだ投稿の記録がない話のものなので預かっておきます。` +
          "投稿キットで「投稿しました」を選ぶと入ります（14日たっても記録が無ければ外します）。"
      );
    }
  }
  return plan.changed;
}

function describe(update: QueuedPostingUpdate): string {
  return update.kind === "episode"
    ? `${update.label}（${postingSiteInfo(update.site).label}）の話の番号 ${update.episodeId}`
    : `${postingSiteInfo(update.site).label}の小説番号 ${update.number}`;
}

/**
 * VS Code を開いたとき、預かりのある作品の台帳へ入れる。登録の無い作品の古い預かりは消す。
 * 失敗しても起動は止めない（ログに残す）。
 */
export async function settlePendingOnStartup(deps: {
  listWorks(): readonly WorkEntry[];
  afterChange(work: WorkEntry): void;
}): Promise<void> {
  const works = deps.listWorks();
  const pending = workIdsWithPendingUpdates();
  if (pending.length === 0) return;
  try {
    const removed = await prunePendingOfUnknownWorks(works.map((work) => work.id));
    if (removed > 0) {
      useLogFile(undefined);
      logLine(`登録の無い作品の、古い預かり（ヘルパーから届いた番号）を${removed}件消しました。`);
    }
  } catch (error) {
    useLogFile(undefined);
    logLine(`預かりの片づけに失敗しました：${messageOf(error)}`);
  }
  for (const work of works) {
    if (!pending.includes(work.id) || isPostingKitActive(work.id)) continue;
    const store = new PostingStore(work);
    let ledger: PostingLedger;
    try {
      ledger = await store.load();
    } catch (error) {
      // 壊れた台帳は直さずに止める。預かりは残す（直したあとの起動で入る）
      useLogFile(work.folderPath);
      logLine(`預かった番号を入れるために ${work.title} の投稿状態を読めませんでした：${messageOf(error)}`);
      continue;
    }
    const changed = await settlePendingForWork({
      work,
      store,
      ledger,
      trigger: "startup",
      save: async (next) => {
        try {
          await store.save(next);
          return true;
        } catch (error) {
          useLogFile(work.folderPath);
          logFailure("預かった番号の保存（起動時）", {
            作品: work.title,
            種類: error instanceof PostingStoreError ? error.kind : "unknown",
            内容: messageOf(error),
          });
          return false;
        }
      },
    });
    if (changed) deps.afterChange(work);
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
