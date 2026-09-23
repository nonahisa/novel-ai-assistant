import * as vscode from "vscode";
import type { WorkEntry } from "../models/types";
import { cancelItem, isCancelItem } from "../views/dialogs";

/**
 * 相談パネルへ落とされたもの（バックアップ・Word 原稿）を、どの作品へ入れるか
 * 選ばせる（設計書6.99.7）。候補を先に、その下に残りの作品と「新しい作品として」
 * を並べる。
 *
 * **全部の作品を出す。** 候補の読み違いで正しい作品が漏れていても、作者が
 * ここで拾えるようにしておく。バックアップと Word 原稿で**同じ選び方**にする
 * （2つに分けると、片方だけ並びや言葉が変わる）。
 *
 * @returns 選んだ作品、「新しい作品として」なら "new"、閉じたら undefined
 */
export async function pickDropTarget(
  candidates: readonly WorkEntry[],
  works: readonly WorkEntry[],
  title: string,
  newLabel = "新しい作品として取り込む"
): Promise<WorkEntry | "new" | undefined> {
  type Item = vscode.QuickPickItem & { work?: WorkEntry; isNew?: boolean };
  const candidateIds = new Set(candidates.map((work) => work.id));
  const items: Item[] = [
    ...candidates.map((work) => ({
      label: work.title,
      description: "候補",
      detail: work.folderPath,
      work,
    })),
    ...works
      .filter((work) => !candidateIds.has(work.id))
      .map((work) => ({ label: work.title, detail: work.folderPath, work })),
    { label: `$(add) ${newLabel}`, isNew: true },
  ];
  // 閉じる道は呼び出しの中で足す（`quickPickCancel.test.ts` が呼び出しごとに見る）
  const picked = await vscode.window.showQuickPick<Item>([...items, cancelItem()], {
    title,
    placeHolder: "取り込み先の作品を選んでください",
    matchOnDetail: true,
  });
  if (!picked || isCancelItem(picked)) return undefined;
  if (picked.isNew) return "new";
  return picked.work;
}
