import * as vscode from "vscode";
import * as path from "../core/paths";
import { fromUri } from "../core/paths";
import type { WorkEntry } from "../models/types";
import type { ConfirmPresave } from "../views/notify";

/**
 * 検知・抽出の前の「未保存の変更」を、**実行の確認の窓へまとめる**ための部品
 * （作者の判断 2026-11-02。設計書6.80）。
 *
 * それまでは、範囲を選ぶ前に右下の知らせで「未保存の変更が N 件あります。
 * 保存してから実行しますか？」と訊いていた。範囲・保存・実行の確認で3回訊かれる。
 * いまは確認の窓に「未保存の N 件を保存してから実行します」と1行書き、［実行］を
 * 押したときにここで保存する（`views/notify.ts` の `confirmRunOrChoose` が呼ぶ）。
 *
 * **保存は VS Code の保存の道（`TextDocument.save()`）だけを通す。** 本文を
 * こちらで書き直すわけではないので、`writeTextFilePreservingFormat` は通らない
 * （打った字を、打った人の保存と同じ形で書き出すだけである）。
 *
 * **取りやめたら保存しない。** 数えるのは作るときの1回だけで、［実行］の前に
 * 増えた分は保存したあとの見直しで拾う（残っていたら止める）。
 */
export interface Presave extends ConfirmPresave {
  readonly work: WorkEntry;
}

/** 作品のフォルダーの中で、未保存の文書（本文・設定資料の JSON・プロットなど） */
export function dirtyDocumentsInside(folderPath: string): vscode.TextDocument[] {
  return vscode.workspace.textDocuments.filter(
    (document) => document.isDirty && path.isPathInside(folderPath, fromUri(document.uri))
  );
}

/**
 * 作品の中の未保存を数え、［実行］で保存する口を作る。
 *
 * @param actionLabel 保存できなかったときの文に入れる処理名（「推敲」など）
 */
export function preparePresave(work: WorkEntry, actionLabel: string): Presave {
  const count = dirtyDocumentsInside(work.folderPath).length;
  return {
    work,
    count,
    save: () => saveDirtyDocumentsOf(work, actionLabel),
  };
}

/**
 * 作品の中の未保存を全部保存し、残っていないことを確かめる。
 *
 * **黙って進まない。** 保存できない文書がある・保存のあとも残っているときは、
 * 理由を出して false を返す（呼んだ側は走らせずに戻る）。未保存のまま読むと、
 * 画面と違う本文を検知してしまう。
 */
export async function saveDirtyDocumentsOf(
  work: WorkEntry,
  actionLabel: string
): Promise<boolean> {
  for (const document of dirtyDocumentsInside(work.folderPath)) {
    if (!document.save || !(await document.save())) {
      await vscode.window.showWarningMessage(
        `保存できない文書があるため、${actionLabel}を中止しました。`
      );
      return false;
    }
  }
  if (dirtyDocumentsInside(work.folderPath).length > 0) {
    await vscode.window.showWarningMessage(
      `保存後も未保存の文書が残っているため、${actionLabel}を中止しました。`
    );
    return false;
  }
  return true;
}
