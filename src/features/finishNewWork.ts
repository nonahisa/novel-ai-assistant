import * as vscode from "vscode";
import type { WorkEntry } from "../models/types";
import { withProgress } from "../views/progress";
import { openGeneratedMarkdown } from "../views/openDocument";
import { logFailure, useLogFile } from "../core/logger";
import {
  FINISH_PREREQUISITES,
  buildFinishConfirm,
  describeFinishHalted,
  describeFinishStep,
  planFinish,
  stepsToRun,
  type FinishStep,
  type FinishStepResult,
} from "../core/finishNewWork";
// 結果の紙（Markdown）だけは別のファイルにある。**確認のダイアログと
// 同じ置き場にすると、記号の混入を見張る検査からファイルごと外れる**
import {
  FINISH_REPORT_KIND,
  describeFinishReport,
} from "../core/finishReportDoc";
import {
  outcomeKindOf,
  outcomeNotesOf,
  outcomeReasonOf,
  type CheckRunOptions,
  type SuiteEstimate,
} from "../core/proofreadingSuite";
import { collectPresentPrerequisites } from "./prerequisiteGate";
import type { AIRegistry, AssignableFeature } from "../ai/registry";
import {
  ASSIGNED_FEATURE as PROOFREADING_ASSIGNED_FEATURE,
  collectEstimateForFeatures,
} from "./proofreadingSuite";

/**
 * 新しい作品を、ひと通り仕上げる（作者の指示、2026-09-19）。
 *
 * 取り込んだばかりの作品に対して、**AIでできることを順に全部走らせ、
 * 最後に「何ができたか」を1枚にまとめて見せる**操作である。
 *
 * ## 校正のまとめ実行（設計書6.80）と同じ決まりで作る
 *
 * 決まりの理由はあちらの冒頭に書いてある。ここでも同じように守る。
 *
 * - **処理を持たない。** 各段は既にあるコマンドをそのまま呼ぶ
 * - **札を取らない**（AIの順番待ちの札は各機能が取る）
 * - **1つずつ、順に走らせる。** 中止したら残りは走らせない
 * - **中止ボタンを持たない**（中止は実行中の機能のもの1つに寄せる）
 * - **失敗しても残りは走らせる**（1段ずつ包んで記録し、紙は `finally` で出す）
 *
 * ## 既にあるものは作り直さない
 *
 * 設定資料・各話あらすじ・プロットが既にあるなら、その段は飛ばす。
 * 作り直すと作者のデータを上書きしかねない（実装ルール2）。**飛ばしたことは
 * 結果の1枚に書く**——黙って飛ばすと、作られなかったことに気づけない。
 *
 * ## 原稿を1文字も書き換えない
 *
 * 指摘はすべて提案として溜める。各コマンドがその約束を守っているので、
 * **まとめ側で迂回しない**（本文を触る近道を持たない）。
 */

/**
 * コマンドへ「この作品で」と伝える最小の形（`extension.ts` の `WorkRef`）。
 *
 * **型をimportしない。** `features` から `extension.ts` を参照すると依存が
 * 逆流する。形は `resolveWork` が見る2つだけなので、ここで持つ
 * （校正のまとめ実行と同じ考え方）。
 */
interface FinishWorkRef {
  readonly type: "work";
  readonly work: WorkEntry;
}

export interface FinishNewWorkDeps {
  /** その分類で、提案パネルにまだ手を付けていない件数（設計書6.37.3） */
  remainingIn(category: string): number;
  /**
   * 確認に出す見積もり（本文の量・チャンク数・使うAI）。
   *
   * **取れなくても確認は出す。** モデルの詳細が引けない（サーバーが
   * 止まっている）ときに黙って走り始めるほうが困る。
   */
  estimate?(steps: readonly FinishStep[]): Promise<SuiteEstimate | undefined>;
}

export async function runFinishNewWork(
  work: WorkEntry,
  deps: FinishNewWorkDeps
): Promise<void> {
  /*
    **何を飛ばすかは、走り始める前に決める。** 確認の紙に「飛ばす段」を
    並べるためでもあるし、途中で数え直すと、直前の段が作ったものを見て
    「既にあるから飛ばす」と判断してしまう。
  */
  const present = await collectPresentPrerequisites(work, FINISH_PREREQUISITES);
  const plan = planFinish(present);
  const steps = stepsToRun(plan);

  const confirm = buildFinishConfirm({
    workTitle: work.title,
    plan,
    estimate: steps.length > 0 ? await deps.estimate?.(steps) : undefined,
  });
  if (!confirm) {
    // 走らせる段が1つも無い（すべて既にある）。黙って終わらない
    void vscode.window.showInformationMessage(
      `${work.title} は、走らせる段がありませんでした（必要なものはすべて揃っています）。`
    );
    return;
  }

  const answer = await vscode.window.showInformationMessage(
    confirm.message,
    { modal: true, detail: confirm.detail },
    "実行"
  );
  if (answer !== "実行") return;

  const ref: FinishWorkRef = { type: "work", work };
  /*
    各段へ渡す印。**「確認は済んでいる」だけを伝える。**

    **札は持っていない**ので `holdsRun` は渡さない（渡すと、どの段も札を
    取らないまま走り、他の操作と混ざる）。この印を読むのは校正の段だけで、
    資料やあらすじを作る段は受け取らず、これまでどおり自分の確認を出す。
  */
  const runOptions: CheckRunOptions = { suite: { confirmed: true } };

  const done: FinishStepResult[] = [];
  // 飛ばす段も、走らせた段と同じ並びで紙に載せる
  for (const entry of plan) {
    if (entry.skipReason === undefined) continue;
    done.push({
      label: entry.step.label,
      skipped: true,
      reason: entry.skipReason,
    });
  }
  /** 中止で走らせなかった段の、先頭の位置。走り切ったら -1 */
  let stoppedAt = -1;

  try {
    await withProgress("新しい作品を、ひと通り仕上げる", async (progress) => {
      for (const [index, step] of steps.entries()) {
        progress.report({
          message: describeFinishStep(index + 1, steps.length, step.label),
        });

        let outcome: unknown;
        try {
          outcome = await vscode.commands.executeCommand(
            step.command,
            ref,
            runOptions
          );
        } catch (error) {
          // **例外で内訳ごと失わない。** ここで抜けると、それまでに走った
          // 段の結果も作者へ伝わらないまま終わる。
          // **記録の直前に書き先を向ける**（この作品の決まり）
          useLogFile(work.folderPath);
          logFailure("ひと通り仕上げる", {
            段: step.label,
            詳細: error instanceof Error ? error.message : String(error),
          });
          done.push({ label: step.label, failed: true });
          continue;
        }

        const kind = outcomeKindOf(outcome);
        // 各機能の中止（進捗の中止・確認での取りやめ・前提不足）で止める
        if (kind === "cancelled") {
          stoppedAt = index;
          return;
        }
        // **前提が足りなくて走らせなかったものは、失敗と呼ばない**
        // （設計書6.80と同じ。「失敗しました」を見た作者は不具合を疑う）
        if (kind === "skipped") {
          done.push({
            label: step.label,
            skipped: true,
            reason: outcomeReasonOf(outcome),
            notes: outcomeNotesOf(outcome),
          });
          continue;
        }
        // **失敗は次へ進む。** レート上限も解析の失敗も、次の段では
        // 起きないことのほうが多い
        if (kind === "failed") {
          done.push({
            label: step.label,
            failed: true,
            notes: outcomeNotesOf(outcome),
          });
          continue;
        }

        done.push(countOf(step, deps));
      }
    });
  } finally {
    /*
      **結果は必ず出す。** ここまでに何が走ったかは、途中で何が起きても
      作者へ伝える値がある。

      1段も走っていないとき（1段目で中止した・飛ばす段しか無かった）は、
      表が空の紙を開いても読むものが無いので、1行の知らせに替える。
    */
    const summary = {
      workTitle: work.title,
      done,
      remaining:
        stoppedAt < 0 ? [] : steps.slice(stoppedAt).map((step) => step.label),
    };
    if (done.length === 0) {
      void vscode.window.showInformationMessage(describeFinishHalted(summary));
    } else {
      // **ファイル名には作品名を入れない**（生成文書の置き場は作品ごとに
      // 分かれている。作品名は紙の見出しに入っている）
      await openGeneratedMarkdown(
        FINISH_REPORT_KIND,
        describeFinishReport(summary),
        undefined,
        { work }
      );
    }
  }
}

/**
 * その段のあと、提案パネルに残っている件数。
 *
 * 分類を持たない段（あらすじ・紹介文・冒頭診断）は数えない——数えると、
 * パネルへ出ない結果を「0件」と報告することになる。
 */
function countOf(step: FinishStep, deps: FinishNewWorkDeps): FinishStepResult {
  if (!step.category) return { label: step.label };
  return { label: step.label, count: deps.remainingIn(step.category) };
}

/**
 * 段ごとのAI割当（設計書6.28.9）。**確認に出すAIの名前をここで引く。**
 *
 * 割当は機能ごとに変えられるので、段によっては2つ以上のAIが並ぶ。1つに
 * 丸めると、有料のAIが混ざっていることを隠すことになる。
 *
 * **校正の段の割当は `proofreadingSuite.ts` が持っている**ので、ここには
 * 校正以外だけを書く（同じ表を2つ持つと、片方だけ古くなる）。
 */
const ASSIGNED_FEATURE: Record<string, AssignableFeature> = {
  // **校正の段ぶんは、校正のまとめ実行が持つ表をそのまま広げる。**
  // 同じ表を2つ持つと、割当を足したときに片方だけ古くなる
  ...PROOFREADING_ASSIGNED_FEATURE,
  settings: "extract",
  // あらすじ・紹介文・キャッチコピー・プロット逆算・章立ては、
  // すべて「生成」の割当を使う（`ai/registry.ts` の注釈のとおり）
  synopsis: "generate",
  plot: "generate",
  blurb: "generate",
  catchphrase: "generate",
  chapters: "generate",
};

/**
 * 確認に出す見積もりを集める。
 *
 * **新しい換算を作らない。** 量の数え方は校正のまとめ実行と同じ関数
 * （`collectEstimateForFeatures`）を通す——ここだけ別の数え方にすると、
 * 同じ作品なのに確認に出る字数とチャンク数が食い違う。
 */
export async function collectFinishEstimate(
  work: WorkEntry,
  registry: AIRegistry,
  steps: readonly FinishStep[]
): Promise<SuiteEstimate | undefined> {
  return await collectEstimateForFeatures(
    work,
    registry,
    steps
      .map((step) => ASSIGNED_FEATURE[step.id])
      .filter((feature): feature is AssignableFeature => Boolean(feature))
  );
}
