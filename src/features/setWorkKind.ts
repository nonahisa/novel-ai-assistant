import * as vscode from "vscode";
import type { WorkEntry } from "../models/types";
import { WORK_KINDS, workKindDef, type WorkKindKey } from "../core/workKind";
import { readWorkKind, writeWorkKind } from "../core/workKindStore";
import { cancelItem, isCancelItem } from "../views/dialogs";

/**
 * 作品の種類をあとから変える（設計書6.109）。
 *
 * **本文は1字も書き換えない。** 変わるのは、これから作る話の雛形・
 * 字数の横の目安・原稿エディタとPDF・EPUBの組み方だけ。書いたものを
 * 台本の形へ直したり、雛形を差し込んだりはしない（規則1）。
 *
 * @returns 変えたら新しい種類。取りやめ・同じ種類なら undefined
 */
export async function setWorkKind(
  work: WorkEntry
): Promise<WorkKindKey | undefined> {
  const current = await readWorkKind(work);

  const picked = await vscode.window.showQuickPick(
    [
      ...WORK_KINDS.map((kind) => ({
        label: kind.label,
        description: kind.key === current ? "いまの種類" : undefined,
        detail: kind.description,
        // `kind` という名前は使えない——QuickPickItem の区切り線の指定と重なる
        workKind: kind.key as WorkKindKey | undefined,
      })),
      { ...cancelItem(), workKind: undefined } as never,
    ],
    {
      title: `「${work.title}」の種類`,
      placeHolder: "本文は書き換えません。雛形・字数の目安・組み方だけが変わります",
      ignoreFocusOut: true,
    }
  );
  if (!picked || isCancelItem(picked) || !picked.workKind) return undefined;
  if (picked.workKind === current) return undefined;

  try {
    await writeWorkKind(work, picked.workKind);
  } catch (error) {
    // **壊れた設定ファイルは直さずに止める**（規則2）。理由はそのまま出す
    void vscode.window.showErrorMessage(
      `種類を変えられませんでした。${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return undefined;
  }

  void vscode.window.showInformationMessage(
    `「${work.title}」の種類を「${workKindDef(picked.workKind).label}」にしました。` +
      "本文は変えていません。これから作る話の雛形・字数の目安・組み方が変わります" +
      "（開いている原稿は、開き直すと新しい組み方になります）。"
  );
  return picked.workKind;
}
