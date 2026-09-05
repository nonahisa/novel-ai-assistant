import * as vscode from "vscode";
import type { WorkEntry } from "../models/types";
import { withCancellableProgress } from "../views/progress";
import {
  PROOFREADING_CHECKS,
  PROOFREADING_SUITE_SELECTION_KEY,
  describeStep,
  describeSuiteResult,
  isCancelledOutcome,
  parseStoredSelection,
  serializeSelection,
  sortToRunOrder,
  type ProofreadingCheck,
  type ProofreadingCheckId,
  type SuiteStepResult,
} from "../core/proofreadingSuite";

/**
 * 校正をまとめて実行する（設計書6.80）。
 *
 * ## 処理を持たない
 *
 * ここがするのは「どれを・どの順で走らせるか」と「終わったあとに内訳を
 * 数えること」だけである。**各機能は既にあるコマンドをそのまま呼ぶ**——
 * 確認・見積もり・札・通知は各機能のものを通す。処理を写すと、片方だけ
 * 直したときに「メニューからは動くのにまとめ実行では違う」が起きる。
 *
 * ## 札を取らない
 *
 * AIの順番待ち（設計書6.76）の札は各機能が取る。まとめ側でも取ると、
 * **自分の機能が自分を待つ**（永遠に始まらない）。
 *
 * ## 1つずつ、順に走らせる
 *
 * 並べて走らせると、作者は「いま何を見ているのか」を見失う。中止したら
 * 残りは走らせない——止めたのに次が始まるのは、押した意味が無い。
 */

/** 前回の選択の控え。`context.globalState` をそのまま渡せる形だけを要求する */
export interface SelectionMemento {
  get<T>(key: string, defaultValue: T): T;
  update(key: string, value: unknown): Thenable<void>;
}

export interface ProofreadingSuiteDeps {
  readonly memento: SelectionMemento;
  /** その分類で、提案パネルにまだ手を付けていない件数（設計書6.37.3） */
  remainingIn(category: string): number;
}

interface CheckPick extends vscode.QuickPickItem {
  readonly id: ProofreadingCheckId;
}

/**
 * コマンドへ「この作品で」と伝える最小の形（`extension.ts` の `WorkRef`）。
 *
 * **型をimportしない。** `features` から `extension.ts` を参照すると
 * 依存が逆流する。形は `resolveWork` が見る2つだけなので、ここで持つ
 * （簡単ステップメニューと同じ考え方）。
 */
interface SuiteWorkRef {
  readonly type: "work";
  readonly work: WorkEntry;
}

export async function runProofreadingSuite(
  work: WorkEntry,
  deps: ProofreadingSuiteDeps
): Promise<void> {
  const previous = parseStoredSelection(
    deps.memento.get<unknown>(PROOFREADING_SUITE_SELECTION_KEY, undefined)
  );

  const items: CheckPick[] = PROOFREADING_CHECKS.map((check) => ({
    id: check.id,
    label: check.label,
    detail: check.detail,
    picked: previous.includes(check.id),
  }));

  // 複数選択なので「取りやめる」は足さない。VS Code が自分でボタンを出す
  const picked = await vscode.window.showQuickPick(items, {
    canPickMany: true,
    title: `校正をまとめて実行：${work.title}`,
    placeHolder: "走らせるものを選んでください（上から順に実行します）",
  });
  // Esc（取りやめ）。**控えも書き換えない**——選び直しの途中で閉じただけ
  if (!picked) return;

  const checks = sortToRunOrder(picked.map((item) => item.id));
  if (checks.length === 0) {
    // 黙って終わると、押したのに何も起きなかったように見える
    void vscode.window.showInformationMessage(
      "走らせるものが1つも選ばれていないので、何もしませんでした。"
    );
    return;
  }

  await deps.memento.update(
    PROOFREADING_SUITE_SELECTION_KEY,
    serializeSelection(checks)
  );

  const ref: SuiteWorkRef = { type: "work", work };
  const done: SuiteStepResult[] = [];
  /** 中止で走らせなかったものの、先頭の位置。走り切ったら -1 */
  let stoppedAt = -1;

  await withCancellableProgress("校正をまとめて実行", async (progress, token) => {
    for (const [index, check] of checks.entries()) {
      if (token.isCancellationRequested) {
        stoppedAt = index;
        return;
      }
      progress.report({
        message: describeStep(index + 1, checks.length, check.label),
      });

      const outcome = await vscode.commands.executeCommand(check.command, ref);
      // 各機能の中止（進捗の中止・確認での取りやめ）を、まとめ側の中止と読む
      if (isCancelledOutcome(outcome)) {
        stoppedAt = index;
        return;
      }

      done.push(countOf(check, deps));
    }
  });

  const message = describeSuiteResult({
    done,
    remaining:
      stoppedAt < 0 ? [] : checks.slice(stoppedAt).map((check) => check.label),
  });
  if (message) void vscode.window.showInformationMessage(message);
}

/**
 * その機能のあと、提案パネルに残っている件数。
 *
 * 分類を持たない機能（冒頭診断）は数えない——数えると、パネルへ出ない
 * 結果を「0件」と報告することになる。
 */
function countOf(
  check: ProofreadingCheck,
  deps: ProofreadingSuiteDeps
): SuiteStepResult {
  if (!check.category) return { label: check.label };
  return { label: check.label, count: deps.remainingIn(check.category) };
}
