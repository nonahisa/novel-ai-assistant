import * as vscode from "vscode";
import type { WorkEntry } from "../models/types";
import { isEditorMode } from "../core/actorContext";
import { shouldReturnDecisions } from "../core/editingRepo";
import { ProposalStore } from "../core/proposalStore";
import {
  describeDecisionCounts,
  summarizeDecisions,
  type DecisionCounts,
} from "../models/proposal";
import { logFailure, logStep, useLogFile } from "../core/logger";
import { notifyDone, whenNoticePicked } from "../views/notify";
import { primeEditorProposalsInPanel } from "./reviewProposals";
import type { ProposalView } from "../models/proposal";
import {
  decisionKey,
  globalDecisionMemory,
  type DecisionMemory,
} from "./decisionMemory";
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
 * - 同期のあと、編集部から提案が届いていれば、提案パネルの選び欄へ静かに足し、
 *   ［提案を見る］の付いた知らせを出す（作者の判断 2026-11-01）
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
  /**
   * 送り返した採否の内訳（採用・見送り・読まれた。作者の決定 2026-11-01）。
   * 渡さなければ内訳を添えない（試験で差し替えないときの形）
   */
  decisionCounts?: (work: WorkEntry) => Promise<DecisionCounts>;
}

const defaultReturnDeps: ReturnDeps = {
  hasPointer: async (work) => (await readPointer(work)) !== undefined,
  pendingCount: (work) => new ProposalStore(work).pendingCount(),
  decisionCounts: async (work) =>
    summarizeDecisions(await new ProposalStore(work).load()),
  isEditorMode,
  resend: (work) => resendDecisionsQuietly(work),
  notifyDone: (text) => notifyDone(text),
  notifyFailure: (work, detail) => {
    // **記録の直前に書き先を向ける**（0.43.3 と同じ）
    useLogFile(work.folderPath);
    logFailure("採否の送り返し", { 作品: work.title, 詳細: detail });
    void vscode.window.showWarningMessage(
      "採否を編集者へ送り返せませんでした。採否そのものは記録してあります。" +
        `（${detail}）あとで「編集者へ渡す」を押すと送り直せます。`
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
    // **意見を読んだものは採用に数えない**（作者の決定 2026-11-01）。内訳が読めなくても
    // 送り返しは済んでいるので、知らせは内訳なしで出す
    let breakdown = "";
    try {
      const counts = deps.decisionCounts ? await deps.decisionCounts(work) : undefined;
      if (counts) breakdown = `（${describeDecisionCounts(counts)}）`;
    } catch {
      breakdown = "";
    }
    logStep(`採否を編集者へ送り返した（${work.title}）${breakdown}`);
    deps.notifyDone(`採否を編集者へ送り返しました${breakdown}。`);
    return "sent";
  } catch (error) {
    deps.notifyFailure(
      work,
      error instanceof Error ? error.message : String(error)
    );
    return "failed";
  }
}

/** 知らせのボタン（押すと「編集部の提案を見る」と同じく並べる） */
export const VIEW_PROPOSALS_BUTTON = "提案を見る";

/** 試験で差し替えられる口 */
export interface InboxDeps {
  isEditorMode: () => boolean;
  importProposals: (work: WorkEntry) => Promise<ImportResult>;
  notify: (text: string) => void;
  /**
   * 提案が届いた知らせ。［提案を見る］を押したら `onView` を呼ぶ。
   * **答えを待たない**（同期の後始末を作者の返事まで止めない）
   */
  offer: (work: WorkEntry, text: string, onView: () => Promise<void>) => void;
  /** 届いた作品の未決を、提案パネルの選び欄へ静かに足す（開いていなければ何もしない） */
  primePanel: (work: WorkEntry) => Promise<void>;
  /** 「編集部の提案を見る」をその作品で走らせる */
  viewProposals: (work: WorkEntry) => Promise<void>;
  /** 編集者モード：作品の提案と採否の今の状態（同期で届いた作者の採否を数える） */
  loadProposals: (work: WorkEntry) => Promise<ProposalView[]>;
  /** 編集者モード：もう知らせた採否の覚え */
  decisionMemory: DecisionMemory;
  /**
   * 編集者モード：作者の採否が届いた知らせ。［採否を見る］を押したら `onView` を呼ぶ
   * （作者の頼み 2026-11-07「採否はパネルで見せたほうがいい」→「知らせのボタンで開く」）。
   * **答えを待たない**（同期の後始末を編集者の返事まで止めない）
   */
  offerDecisions: (work: WorkEntry, text: string, onView: () => Promise<void>) => void;
  /** 編集者モード：その作品の作者の採否の一覧（編集者メニューの「7. 作者の採否を見る」と同じ）を開く */
  viewDecisions: (work: WorkEntry) => Promise<void>;
  /**
   * 編集者モード：新しい採否が届いたとき、その作品の採否のパネルが開いていれば描き直す
   * （0.136.0。パネルは閉じないので、開いたままだと古い一覧が残る）。開いていなければ何もしない
   */
  refreshDecisions: (work: WorkEntry) => Promise<void>;
}

/** 採否が届いた知らせのボタン */
export const DECISIONS_BUTTON = "採否を見る";

const defaultInboxDeps: InboxDeps = {
  isEditorMode,
  importProposals: (work) => importEditorProposalsQuietly(work),
  notify: (text) => void vscode.window.showInformationMessage(text),
  offerDecisions: (work, text, onView) => {
    whenNoticePicked(
      vscode.window.showInformationMessage(text, DECISIONS_BUTTON),
      async (picked) => {
        if (picked === DECISIONS_BUTTON) await onView();
      },
      { label: "作者の採否を見る", workFolder: work.folderPath }
    );
  },
  viewDecisions: async (work) => {
    const { showAuthorDecisionsPanel } = await import("./authorDecisionsPanel.js");
    await showAuthorDecisionsPanel(work, defaultInboxDeps.decisionMemory);
  },
  refreshDecisions: async (work) => {
    const { refreshAuthorDecisionsPanel } = await import("./authorDecisionsPanel.js");
    await refreshAuthorDecisionsPanel(work);
  },
  offer: (work, text, onView) => {
    whenNoticePicked(
      vscode.window.showInformationMessage(text, VIEW_PROPOSALS_BUTTON),
      async (picked) => {
        if (picked === VIEW_PROPOSALS_BUTTON) await onView();
      },
      { label: "編集者の提案を見る", workFolder: work.folderPath }
    );
  },
  primePanel: async (work) => {
    await primeEditorProposalsInPanel(work);
  },
  viewProposals: async (work) => {
    // 作品を渡す。引数無しだと作品選択からやり直させる
    await vscode.commands.executeCommand("novelai.viewEditorProposals", {
      type: "work",
      work,
    });
  },
  loadProposals: (work) => new ProposalStore(work).load(),
  decisionMemory: globalDecisionMemory,
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
  // 編集者モードの環境は、提案を受け取る側ではなく出す側。同期で届いた作者の採否を知らせる
  if (deps.isEditorMode()) {
    await noticeArrivedDecisions(works, deps);
    return 0;
  }

  let total = 0;
  for (const work of works) {
    try {
      const result = await deps.importProposals(work);
      if (result.status !== "done") continue;
      if (result.pullFailed) {
        useLogFile(work.folderPath);
        logStep(`編集者の提案の取り寄せに失敗（手元の分だけ取り込み）: ${work.title}`);
      }
      // 鍵が動いたら知らせる（校閲が始まった／終わった）
      for (const text of describeLockChanges(result)) deps.notify(text);
      if (result.added <= 0) continue;
      total += result.added;
      /*
        **パネルを勝手に開かない**（作者の判断 2026-11-01「知らせに［提案を見る］を付ける」を
        受けた実装の判断。0.120.2）。窓の読み込み直しの最中に
        開いても作者は見ておらず、知らせが2枚（届いた・N件あります）重なるだけだった。
        選び欄へ静かに足し（知らせが流れても選び欄から辿れる）、知らせのボタンで並べる
      */
      await deps.primePanel(work);
      deps.offer(
        work,
        `編集者から提案が ${result.added} 件届きました` +
          (works.length > 1 ? `（「${work.title}」）。` : "。"),
        () => deps.viewProposals(work)
      );
    } catch (error) {
      useLogFile(work.folderPath);
      logFailure("編集者の提案の取り込み（同期のあと）", {
        作品: work.title,
        詳細: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return total;
}

/**
 * 編集者モード：同期で届いた作者の採否を知らせる（作者の判断 2026-11-01「届いたら知らせる」）。
 *
 * 編集者の写しは作品そのものが編集用リポジトリなので、採否（decision の行）は開いたときの
 * 点検・同期の取り込みでそのまま台帳へ入る。**新しく届いた分だけ**を数え、同じものを
 * 二度知らせない（`decisionMemory`）。
 *
 * **覚えが空のとき（初めて動いたとき）は、今ある採否を全部「届いた」として1回知らせる。**
 * 黙って全部を既読にすると、この版へ上げた直後に入った作者の採否が、知らされないまま消える
 * （実装の判断。0.120.2）。**例外は外へ出さない。**
 */
async function noticeArrivedDecisions(
  works: readonly WorkEntry[],
  deps: InboxDeps
): Promise<void> {
  for (const work of works) {
    try {
      const views = await deps.loadProposals(work);
      const seen = deps.decisionMemory.seen(work.id);
      const arrived: ProposalView[] = [];
      const keys: string[] = [];
      for (const view of views) {
        const key = decisionKey(view);
        if (!key || seen.has(key)) continue;
        arrived.push(view);
        keys.push(key);
      }
      if (arrived.length === 0) continue;
      deps.offerDecisions(
        work,
        "作者が提案を決めました" +
          (works.length > 1 ? `（「${work.title}」）` : "") +
          `（${describeDecisionCounts(summarizeDecisions(arrived))}）。`,
        () => deps.viewDecisions(work)
      );
      await deps.decisionMemory.add(work.id, keys);
      await deps.refreshDecisions(work);
      useLogFile(work.folderPath);
      logStep(`作者の採否が届いた（${work.title}・${arrived.length}件）`);
    } catch (error) {
      useLogFile(work.folderPath);
      logFailure("届いた採否の知らせ", {
        作品: work.title,
        詳細: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
