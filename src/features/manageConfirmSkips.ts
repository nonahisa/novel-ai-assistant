import * as vscode from "vscode";
import { describeRemembered, withoutAll, withoutRemembered } from "../core/confirmMemory";
import {
  readConfirmMemory,
  saveConfirmMemory,
} from "../core/confirmMemoryStore";
import { notifyDone } from "../views/notify";

/**
 * 「以降は訊かない」にした確認を、また訊くように戻す（設計書6.89）。
 *
 * **解除の場所を、押した場所の近くに置く。** 覚え書きは設定
 * （`novelai.confirm.remembered`）に入っているので設定管理画面から手で
 * 消すこともできるが、鍵の名前（`ai.run.checkTypos`）を見て何の確認か
 * 分かるのは書いた側だけである。ここでは**作者の言葉で並べて選ばせる。**
 *
 * 一覧から外した確認（`REMEMBERABLE_CONFIRMS` に無い id）も並べる。
 * 設定を手で書き換えた作者が、「消したいのに一覧に出ない」で詰まらない
 * ようにするため。
 */
export async function manageConfirmSkips(): Promise<void> {
  const memory = readConfirmMemory();
  const entries = describeRemembered(memory);

  if (entries.length === 0) {
    void vscode.window.showInformationMessage(
      "「以降は訊かない」にした確認はありません。"
    );
    return;
  }

  const ALL = "__all__";
  const picked = await vscode.window.showQuickPick(
    [
      {
        label: "$(clear-all) すべて忘れる",
        detail: `${entries.length}件すべてを、また訊くように戻します`,
        id: ALL,
      },
      ...entries.map((entry) => ({
        label: `$(question) ${entry.label}`,
        description: `いまの答え: ${entry.answer}`,
        detail: entry.id,
        id: entry.id,
      })),
    ],
    {
      title: `訊かないことにした確認（${entries.length}件）`,
      placeHolder: "また訊くようにするものを選んでください",
      canPickMany: true,
      ignoreFocusOut: true,
    }
  );

  // **何も選ばずに閉じたときは、何もしない。** 空の配列で「全部忘れる」と
  // 読むと、見に来ただけの作者の設定が消える
  if (!picked || picked.length === 0) return;

  const ids = picked.map((item) => item.id);
  const next = ids.includes(ALL)
    ? withoutAll()
    : ids.reduce((acc, id) => withoutRemembered(acc, id), memory);
  const forgotten = ids.includes(ALL) ? entries.length : ids.length;

  try {
    await saveConfirmMemory(next);
  } catch (error) {
    void vscode.window.showErrorMessage(
      `設定を書き換えられませんでした: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return;
  }

  notifyDone(`${forgotten}件を、また訊くようにしました。`);
}
