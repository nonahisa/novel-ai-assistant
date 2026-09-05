import * as vscode from "vscode";
import type { WorkEntry } from "../models/types";
import { withProgress } from "../views/progress";
import { logFailure } from "../core/logger";
import {
  PROOFREADING_CHECKS,
  PROOFREADING_SUITE_SELECTION_KEY,
  describeStep,
  describeSuiteResult,
  outcomeKindOf,
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
 *
 * ## 中止ボタンは持たない（0.33.7のレビュー）
 *
 * ここで `withCancellableProgress` を使うと、**中止ボタンが2つ並ぶ**——
 * まとめ側と、いま走っている検知のものである。作者が選択画面（6.76）で
 * 「まとめ」を選んで止めても、その合図は走っている検知へ届かず、検知は
 * 最後まで走り切っていた。中止は**実行中の検知のもの1つ**に寄せる。
 * 検知が止まれば `cancelled` が返り、まとめもそこで残りを走らせない。
 *
 * ## 失敗しても、残りは走らせる
 *
 * AIの失敗や応答の読み取り失敗は、次の検知を止める理由にならない。
 * 例外を投げるコマンドがあっても内訳ごと失わないよう、1件ずつ包んで
 * 記録し、**通知は必ず出す**（`finally`）。
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

  try {
    await withProgress("校正をまとめて実行", async (progress) => {
      for (const [index, check] of checks.entries()) {
        progress.report({
          message: describeStep(index + 1, checks.length, check.label),
        });

        let outcome: unknown;
        try {
          outcome = await vscode.commands.executeCommand(check.command, ref);
        } catch (error) {
          // **例外で内訳ごと失わない。** ここで抜けると、それまでに走った
          // 機能の結果も作者へ伝わらないまま終わる
          logFailure("校正のまとめ実行", {
            機能: check.label,
            詳細: error instanceof Error ? error.message : String(error),
          });
          done.push({ label: check.label, failed: true });
          continue;
        }

        const kind = outcomeKindOf(outcome);
        // 各機能の中止（進捗の中止・確認での取りやめ・前提不足）で止める
        if (kind === "cancelled") {
          stoppedAt = index;
          return;
        }
        // **失敗は次へ進む。** レート上限も解析の失敗も、次の機能では
        // 起きないことのほうが多い
        if (kind === "failed") {
          done.push({ label: check.label, failed: true });
          continue;
        }

        done.push(countOf(check, deps));
      }
    });
  } finally {
    // **知らせは必ず出す。** ここまでに何が走ったかは、途中で何が起きても
    // 作者へ伝える値がある
    const message = describeSuiteResult({
      done,
      remaining:
        stoppedAt < 0 ? [] : checks.slice(stoppedAt).map((check) => check.label),
    });
    if (message) void vscode.window.showInformationMessage(message);
  }
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
