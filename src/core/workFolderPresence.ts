import type { WorkEntry } from "../models/types";
import { fileReader } from "./fileRead";

/**
 * 作品のフォルダーが今そこに在るか（`fileSystem.ts` の `isDirectory` と同じ判断）。
 *
 * 起動の整備（`workRegistry.ts`）と同期（`syncAllWorks.ts`・`syncLog.ts`・
 * `gitSync.ts`）が同じ判断を使うために、ここへ1つだけ置く（写しを作らない）。
 *
 * **読むだけなので、手元では Node の `fs` で訊く**（`core/fileRead.ts`、設計書6.107）。
 * 起動直後の `vscode.workspace.fs` は要求が列に並び、**16作品ぶんで
 * 1番目が13.6秒**かかっていた（Node なら16件で合計13ms）。ここは
 * 起動の道のいちばん手前なので、後ろの全部がその列に付き合わされる。
 *
 * 見つからない・読めないは、これまでどおり「無い」に倒す。繋がっていない
 * ドライブや取り寄せ中のクラウドと、消えた作品は見分けられない。
 */
export async function isWorkFolderPresent(folderPath: string): Promise<boolean> {
  try {
    const reader = await fileReader();
    return (await reader.stat(folderPath)).type === "directory";
  } catch {
    return false;
  }
}

/**
 * 並びのうち、フォルダーが見つからない作品（登録の順のまま）。
 *
 * 同期の前に、置き場の作品がそろっているかを確かめるのに使う（設計書5.5.14。
 * 2026-11-14 の事故：移した2作品の削除が「すべて同期」で確認なしに記録・送信された）。
 */
export async function findMissingWorks(
  works: readonly WorkEntry[]
): Promise<WorkEntry[]> {
  const present = await Promise.all(
    works.map((work) => isWorkFolderPresent(work.folderPath))
  );
  return works.filter((_, index) => !present[index]);
}
