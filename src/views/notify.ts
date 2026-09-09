import * as vscode from "vscode";
import { logStep, showLog } from "../core/logger";

/**
 * 知らせの出し方をそろえる入口（作者の裁定 2026-09-06）。
 *
 * **「確認はモーダル、完了はステータスバー」。**
 *
 * きっかけは、1回の検知で「完了しました」「AIを設定しました」
 * 「解消を確認しました」「中止しました」が通知センターへ積み上がり、
 * **押したい確認カード（「実行」）が下へ押し出された**こと。
 * 通知は出た順に積まれるので、**読み捨ててよい報告が、返事を待っている
 * 問いかけを隠してしまう。**
 *
 * そこで、行き先を4つに分ける。
 *
 * 1. **実行してよいかの確認** → モーダル（`confirmRun`）。
 *    ほかの通知に埋もれないし、答えるまで先へ進まない。
 *    モーダルは `Esc` で閉じられるので「中止」ボタンは置かない
 *    （VS Codeがモーダルへ「キャンセル」を必ず付けるので、
 *    出口が無くなることもない）。
 *    **取り消しにくい操作は `kind: "warning"` で警告の顔にする**
 * 2. **その場限りの完了** → ステータスバー＋操作ログ（`notifyDone`）。
 *    「コピーした」「設定した」「中止した」「解消を確認した」「切り替えた」
 *    「登録した」のように、**件数・理由・保存先を伴わない**もの。
 *    見えたら用が済むので、数秒で消えてよい
 * 3. **あとで読み返す価値のあるもの** → 通知のまま。
 *    件数（「3件を…しました」）・失敗の理由・保存先・
 *    ボタンで次の操作へ進むもの。消えると困る
 * 4. **エラー・警告** → 通知のまま（`warnWithLog` / `errorWithLog`）。
 *    作者が気づかないと困るし、ログへの入口も要る
 *
 * **文言は変えないこと。** 行き先を変えるだけでも作者は戸惑うので、
 * 覚えている言葉まで一緒に変えない。
 */

/**
 * ステータスバーに完了を出しておく長さ（ミリ秒）。
 *
 * 目を離していても拾える程度に長く、次の操作の邪魔にならない程度に短く。
 */
export const DONE_MESSAGE_TIMEOUT_MS = 6000;

/**
 * その場限りの完了を知らせる。
 *
 * ステータスバーは数秒で消えるので、**同じ文言を操作ログにも残す。**
 * 「さっき何をしたか」をあとから追えるようにするため（`showLog`）。
 */
export function notifyDone(text: string): void {
  vscode.window.setStatusBarMessage(`$(check) ${text}`, DONE_MESSAGE_TIMEOUT_MS);
  logStep(text);
}

/**
 * 確認カードの顔つき。
 *
 * **取り消しにくい操作を、情報の顔で訊かない。** 人物をまとめる・
 * GitHubへ送信する・履歴に記録するは、押したあとで戻すのが難しい。
 * もともと `showWarningMessage` で出していたものが、0.35.3 で
 * `confirmRun` へ移った拍子に情報アイコンになっていた（0.35.4で戻す）。
 */
export type ConfirmKind = "info" | "warning";

export interface ConfirmOptions {
  /** 既定は `"info"`。取り消しにくい操作だけ `"warning"` にする */
  kind?: ConfirmKind;
}

/**
 * 実行してよいかを確かめる。**モーダルで出す。**
 *
 * 戻りは「押したかどうか」。`Esc` で閉じられたときは false になるので、
 * 呼び出し側に「中止」ボタンを足す必要はない。VS Codeはモーダルへ
 * 「キャンセル」を必ず付けるため、押して閉じる道も残っている。
 */
export async function confirmRun(
  message: string,
  runLabel = "実行",
  options: ConfirmOptions = {}
): Promise<boolean> {
  // 顔つきが違うだけで、訊き方（モーダル・ボタン1つ）は同じにする。
  // 揃えておかないと、警告のときだけ操作の手順が変わって見える。
  // **関数を変数へ取り出さずに呼ぶ**——`vscode.window` から外すと
  // 受け手（this）が外れる実装があり得るため
  const answer =
    options.kind === "warning"
      ? await vscode.window.showWarningMessage(message, { modal: true }, runLabel)
      : await vscode.window.showInformationMessage(
          message,
          { modal: true },
          runLabel
        );
  return answer === runLabel;
}

/**
 * 警告と、ログへの入口をまとめて出す。
 *
 * **ボタンの名前は呼び出し側が渡す。** 既存の文言が「ログを見る」と
 * 「ログを表示」に割れており、そろえると作者が覚えている言葉が変わる。
 */
export async function warnWithLog(
  message: string,
  logLabel = "ログを見る"
): Promise<void> {
  const answer = await vscode.window.showWarningMessage(message, logLabel);
  if (answer === logLabel) showLog();
}

/** `warnWithLog` のエラー版。出す先が違うだけで扱いは同じ */
export async function errorWithLog(
  message: string,
  logLabel = "ログを見る"
): Promise<void> {
  const answer = await vscode.window.showErrorMessage(message, logLabel);
  if (answer === logLabel) showLog();
}
