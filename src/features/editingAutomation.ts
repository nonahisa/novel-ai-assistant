import * as vscode from "vscode";
import type { WorkEntry } from "../models/types";
import { isEditorMode } from "../core/actorContext";
import { shouldReturnDecisions } from "../core/editingRepo";
import { ProposalStore } from "../core/proposalStore";
import { logFailure, logStep, useLogFile } from "../core/logger";
import { notifyDone } from "../views/notify";
import {
  describeLockChanges,
  importEditorProposalsQuietly,
  readPointer,
  rememberRegisteredWorks,
  resendDecisionsQuietly,
  type ImportResult,
  type PushOutcome,
} from "./shareWithEditor";

/**
 * 編集部連携の自動化（作者の裁定、2026-10-28）。
 *
 * - 採否を決め終えたら、編集部へ自動で送り返す（確認窓なし）
 * - 同期のあと、編集部から提案が届いていれば知らせて提案パネルを開く
 *
 * **Node（git）を使うので、呼ぶ側は `canRunProcesses()` を確かめて動的 import する**
 * （ブラウザ版の束に静的に入れない）。
 * **失敗しても呼び元（採否・同期）を止めない。** ここは例外を外へ出さない。
 */

/** 試験で差し替えられる口。製品は何も渡さない */
export interface ReturnDeps {
  hasPointer: (work: WorkEntry) => Promise<boolean>;
  pendingCount: (work: WorkEntry) => Promise<number>;
  isEditorMode: () => boolean;
  resend: (work: WorkEntry) => Promise<PushOutcome & { skipped?: boolean }>;
  notifyDone: (text: string) => void;
  notifyFailure: (work: WorkEntry, detail: string) => void;
}

const defaultReturnDeps: ReturnDeps = {
  hasPointer: async (work) => (await readPointer(work)) !== undefined,
  pendingCount: (work) => new ProposalStore(work).pendingCount(),
  isEditorMode,
  resend: (work) => resendDecisionsQuietly(work),
  notifyDone: (text) => notifyDone(text),
  notifyFailure: (work, detail) => {
    // **記録の直前に書き先を向ける**（0.43.3 と同じ）
    useLogFile(work.folderPath);
    logFailure("採否の送り返し", { 作品: work.title, 詳細: detail });
    void vscode.window.showWarningMessage(
      "採否を編集部へ送り返せませんでした。採否そのものは記録してあります。" +
        `（${detail}）あとで「編集部へ渡す」を押すと送り直せます。`
    );
  },
};

export type ReturnOutcome = "sent" | "skipped" | "failed";

/**
 * 作品ごとの走りの状態。**待っているのは1本まで**に畳む。
 *
 * 採否をまとめて決めると、決めた回数だけ呼ばれる。走っている間に来た呼び出しは旗
 * （`again`）を立てるだけにし、走り終えたあとに**1回だけ**もう一度走る
 * （走行中に書かれた最後の決定を漏らさず、回数ぶんの送信もしない）。
 */
const returnStates = new Map<
  string,
  { running?: Promise<ReturnOutcome>; again: boolean }
>();

/**
 * 採否を決め終えていれば、編集部へ静かに送り返す。
 *
 * 引き金は `acceptProposal`／`rejectProposal` の `decide()` のあと。
 * 条件は `shouldReturnDecisions`（pointer がある・未決が0件・編集者モードでない）。
 */
export function returnDecisionsIfFinished(
  work: WorkEntry,
  deps: ReturnDeps = defaultReturnDeps
): Promise<ReturnOutcome> {
  let state = returnStates.get(work.id);
  if (!state) {
    state = { again: false };
    returnStates.set(work.id, state);
  }
  const current = state;
  if (current.running) {
    current.again = true;
    return current.running;
  }
  current.running = (async () => {
    let outcome: ReturnOutcome;
    do {
      current.again = false;
      outcome = await runReturn(work, deps);
    } while (current.again);
    return outcome;
  })().finally(() => {
    current.running = undefined;
  });
  return current.running;
}

async function runReturn(work: WorkEntry, deps: ReturnDeps): Promise<ReturnOutcome> {
  try {
    const hasPointer = await deps.hasPointer(work);
    // 編集者モードや pointer なしでは、未決の数を数えるまでもない
    const pendingCount =
      hasPointer && !deps.isEditorMode() ? await deps.pendingCount(work) : -1;
    if (
      !shouldReturnDecisions({
        hasPointer,
        pendingCount,
        editorMode: deps.isEditorMode(),
      })
    ) {
      return "skipped";
    }

    const result = await deps.resend(work);
    if (result.skipped) return "skipped";
    if (!result.ok) {
      deps.notifyFailure(work, result.detail);
      return "failed";
    }
    useLogFile(work.folderPath);
    logStep(`採否を編集部へ送り返した（${work.title}）`);
    deps.notifyDone("採否を編集部へ送り返しました。");
    return "sent";
  } catch (error) {
    deps.notifyFailure(
      work,
      error instanceof Error ? error.message : String(error)
    );
    return "failed";
  }
}

/** 試験で差し替えられる口 */
export interface InboxDeps {
  isEditorMode: () => boolean;
  importProposals: (work: WorkEntry) => Promise<ImportResult>;
  notify: (text: string) => void;
  openPanel: (work: WorkEntry) => Promise<void>;
}

const defaultInboxDeps: InboxDeps = {
  isEditorMode,
  importProposals: (work) => importEditorProposalsQuietly(work),
  notify: (text) => void vscode.window.showInformationMessage(text),
  openPanel: async (work) => {
    await vscode.commands.executeCommand("novelai.reviewProposals", {
      type: "work",
      work,
    });
  },
};

/** 走っている最中にもう一度呼ばれたら、同じ走りを待つ（二重に取り込まない） */
let inboxRunning: Promise<number> | undefined;

/**
 * 同期のあとに、編集部の提案を取り込む。**届いた件数を返す。**
 *
 * 編集用リポジトリは書庫の同期の対象に入っていないので、同期とは別口で
 * pointer のある作品ごとに取り寄せる。**失敗しても本来の同期を止めない**
 * （例外は外へ出さず、ログへ）。0件なら黙る。
 */
export function collectEditorInboxQuietly(
  works: readonly WorkEntry[],
  deps: InboxDeps = defaultInboxDeps
): Promise<number> {
  // 合わせ直し（reset）の前に「置き場が書庫を含まないか」を確かめるため、登録済みの作品を覚えておく
  rememberRegisteredWorks(works);
  if (inboxRunning) return inboxRunning;
  const run = runInbox(works, deps).finally(() => {
    inboxRunning = undefined;
  });
  inboxRunning = run;
  return run;
}

async function runInbox(
  works: readonly WorkEntry[],
  deps: InboxDeps
): Promise<number> {
  // 編集者モードの環境は、提案を受け取る側ではなく出す側
  if (deps.isEditorMode()) return 0;

  let total = 0;
  let opened = false;
  for (const work of works) {
    try {
      const result = await deps.importProposals(work);
      if (result.status !== "done") continue;
      if (result.pullFailed) {
        useLogFile(work.folderPath);
        logStep(`編集部の提案の取り寄せに失敗（手元の分だけ取り込み）: ${work.title}`);
      }
      // 鍵が動いたら知らせる（校閲が始まった／終わった）
      for (const text of describeLockChanges(result)) deps.notify(text);
      if (result.added <= 0) continue;
      total += result.added;
      deps.notify(
        `編集部から提案が ${result.added} 件届きました` +
          (works.length > 1 ? `（「${work.title}」）。` : "。")
      );
      // 提案パネルは1作品ぶんしか開けない。最初に届いた作品を開く
      if (!opened) {
        opened = true;
        await deps.openPanel(work);
      }
    } catch (error) {
      useLogFile(work.folderPath);
      logFailure("編集部の提案の取り込み（同期のあと）", {
        作品: work.title,
        詳細: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return total;
}
