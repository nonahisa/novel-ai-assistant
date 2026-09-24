import type * as vscode from "vscode";
import { cancelTaskByToken } from "../views/progress";

/**
 * いま動いている一括処理の進捗（設計書6.76.1）。`features/aiTurn.ts` が積み、
 * 手元のAIの門（`features/localAiGate.ts`）が読む。
 *
 * 待ち文言を**その処理の進捗へ**出し、GPU の負荷の警告で［やめる］を選んだとき
 * **その処理の中止ボタンと同じ道**で止めるために使う。単発の呼び出しには無い
 * （門が自前の進捗を出す）。
 *
 * 門の本体から切り離してあるのは、`aiTurn.ts` が門の重い依存
 * （接続先の判定・通信）まで引き込まないため。
 */

type ProgressReporter = vscode.Progress<{ message?: string; increment?: number }>;

export interface RunControl {
  readonly report: (message: string) => void;
  readonly cancel: () => void;
}

const runControls: RunControl[] = [];

/**
 * 一括処理の進捗を積む。戻り値で降ろす。
 *
 * **積み重ねで持つ。** 校正のまとめ実行（6.80）は外側が札を持ち、内側の
 * 機能もそれぞれ進捗を出すので、いちばん内側（いま動いているもの）へ出す。
 */
export function pushRunControl(
  progress: ProgressReporter,
  token: vscode.CancellationToken
): () => void {
  const control: RunControl = {
    report: (message) => progress.report({ message }),
    cancel: () => cancelTaskByToken(token),
  };
  runControls.push(control);
  return () => {
    const at = runControls.lastIndexOf(control);
    if (at >= 0) runControls.splice(at, 1);
  };
}

export function currentRunControl(): RunControl | undefined {
  return runControls[runControls.length - 1];
}
