import * as vscode from "vscode";
import * as path from "../core/paths";
import type { WorkEntry } from "../models/types";
import { syncLogPlace } from "../core/syncTarget";
import { logFailure, useLogFile } from "../core/logger";

/**
 * 同期の記録の書き先を、その置き場のログへ向ける（設計書5.7.9「書庫のログ」）。
 *
 * 書き先の決め方は `core/syncTarget.ts` の `syncLogPlace`（1か所）。ここは
 * 書庫のときに**ログの置き場をGitから外す**下ごしらえだけを足す。
 *
 * ## なぜ外す必要があるか
 *
 * 作品の `.aiwriter/logs/` は、作品ごとの `.gitignore` が外している
 * （`workRegistry.ts` の `IGNORED_PATHS`）。**書庫の直下には、こちらが整える
 * `.gitignore` が無い。** 何もせずに書庫の直下へ書くと、同期の記録そのものが
 * 未記録の変更になり、起動のたびに「送り残しあり」と判定される
 * （`handoffSync` の `pending`、自動の送り直しの `dirty`）。記録すれば
 * GitHub へログが出ていく。
 *
 * ## なぜ書庫の `.gitignore` に足さないか
 *
 * 書庫の `.gitignore` は作者が記録している（または、まだ無い）ファイルで、
 * 1行足すだけでもそれ自体が未記録の変更になる。代わりに
 * **`.aiwriter/logs/` の中に、中身が `*` だけの `.gitignore` を置く。**
 * `*` はその `.gitignore` 自身にも当たるので、置き場の外からは何も
 * 増えて見えない。どの機械でも、最初に書く前に置かれる。
 *
 * **既にあれば触らない**（作者が置いたものかもしれない。上書きしない）。
 */
export async function useSyncLog(
  root: string,
  works: readonly WorkEntry[]
): Promise<void> {
  const place = syncLogPlace(root, works);
  if (!place) return;
  if (!place.library) {
    useLogFile(place.folder);
    return;
  }
  try {
    await ensureLogFolderIgnored(place.folder);
    useLogFile(place.folder);
  } catch (error) {
    // **外せないまま書庫の直下へ書かない**（上の「送り残しあり」になる）。
    // 先頭の作品のログへ倒す——これまでの書き先で、そこはGitから外れている
    useLogFile(works[0]?.folderPath);
    logFailure("書庫のログの置き場を用意できなかった（作品のログへ書きます）", {
      置き場: root,
      詳細: error instanceof Error ? error.message : String(error),
    });
  }
}

/** 書庫のログの置き場に置く、Gitから外すための印の中身 */
export const LIBRARY_LOG_IGNORE = "*\n";

async function ensureLogFolderIgnored(root: string): Promise<void> {
  const logs = path.join(root, ".aiwriter", "logs");
  const ignore = path.toUri(path.join(logs, ".gitignore"));
  try {
    await vscode.workspace.fs.stat(ignore);
    return;
  } catch {
    // 無い。下で置く
  }
  await vscode.workspace.fs.createDirectory(path.toUri(logs));
  await vscode.workspace.fs.writeFile(
    ignore,
    new TextEncoder().encode(LIBRARY_LOG_IGNORE)
  );
}
