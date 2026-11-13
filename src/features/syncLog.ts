import type { WorkEntry } from "../models/types";
import { syncLogPlace } from "../core/syncTarget";
import { useLogFiles } from "../core/logger";
import { isSameFolder } from "../core/pathText";
import { findMissingWorks } from "../core/workFolderPresence";

/**
 * 同期の記録の書き先を決める（設計書5.7.9「書庫のログ」）。
 *
 * - 作品ごとに分けたリポジトリ：その作品のログ
 * - 書庫（1つのGitの置き場に作品が複数）：**その同期に関わった作品それぞれのログ**
 *   へ、同じ行を書く（作者の裁定 2026-11-05、残課題 J10）。関わった作品が
 *   分からないとき（`involved` が無い・空）は、書庫の全作品へ書く
 *
 * ## なぜ書庫の直下へ書かなくなったか
 *
 * 2026-10-03 から書庫の直下の `.aiwriter/logs/` へ書いていたが、書庫の直下には
 * 作品ごとの `.gitignore` が無く、Gitから外す印を足す下ごしらえが要った。
 * 作品の `.aiwriter/logs/` は作品ごとの `.gitignore` が最初から外している
 * （`workRegistry.ts` の `IGNORED_PATHS`）ので、作品のログへ書けば何も要らない。
 * 作者が作品を開いたとき、その作品の操作の記録に同期の結果も並ぶ。
 *
 * 書庫の直下に既にあるログと `.gitignore` は作者の記録なので、消さない。
 *
 * 書き先の決め方は `core/syncTarget.ts` の `syncLogPlace`（1か所）。
 */
export async function useSyncLog(
  root: string,
  works: readonly WorkEntry[],
  involved?: readonly WorkEntry[]
): Promise<void> {
  const place = syncLogPlace(root, works);
  if (!place) return;
  const targets = !place.library
    ? works.filter((work) => isSameFolder(work.folderPath, place.folder))
    : involved && involved.length > 0
      ? involved
      : works;
  /*
    **フォルダーが無い作品のログへは向けない**（2026-11-14 の作者の実データ）。
    ログを書くと親フォルダーごと作り直すので、移した作品の元の場所に空のフォルダーが
    でき、起動の整備がそこを「在る作品」と読んで `.gitignore` を書き、次の同期で
    それが記録・送信された。判断は起動の整備と同じもの（`isWorkFolderPresent`）。
    書ける作品が1つも無ければ、作品の決まらない処理と同じ置き場（`useLogFiles([])`）へ。
    早く戻ると、向け先が前の置き場のまま残って別の作品のログへ紛れる
  */
  const missing = new Set((await findMissingWorks(targets)).map((work) => work.id));
  useLogFiles(
    targets.filter((work) => !missing.has(work.id)).map((work) => work.folderPath)
  );
}
