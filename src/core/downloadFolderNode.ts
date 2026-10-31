import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DownloadFolderLister } from "./backupArrivalWatch";

/**
 * ダウンロードのフォルダーを見る口（作者の指示 2026-11-01）。
 *
 * **Node 専用である。** 拡張機能からは `canRunProcesses()` を確かめてから
 * **動的 import** する（実装ルール7。`browserReach.test.ts` が見張る）。ブラウザ版の
 * VS Code には作者のパソコンのダウンロードのフォルダーが見えないので、待ちそのものを出さない。
 *
 * `node:path` を使うのは、ここで扱うのが**作者のパソコンの中の場所だけ**だから
 * （`vscode-vfs://` の作品を指すことは無い）。
 */

/**
 * 既定の場所（Windows の「ダウンロード」）。設定で替えられる（`novelai.ownWorks.downloadFolder`）。
 *
 * 「ダウンロード」を別のドライブへ移していると、ここは空振りする。そのときのために設定を置く
 * （登録簿の既知のフォルダーを読みにいくより、作者が場所を書けるほうが確かめやすい）
 */
export function defaultDownloadFolder(): string {
  return join(homedir(), "Downloads");
}

/**
 * フォルダーの名前を並べ、頼まれた名前の大きさだけを尋ねる。**ファイルの中は開かない。**
 * 名前の一覧ではフォルダー（サブフォルダー）を除く。
 */
export function downloadFolderLister(folder: string): DownloadFolderLister {
  return {
    async names() {
      const entries = await readdir(folder, { withFileTypes: true });
      return entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
    },
    async size(name) {
      try {
        const info = await stat(join(folder, name));
        return info.isFile() ? info.size : undefined;
      } catch {
        // 見ているあいだに消えた・改名された
        return undefined;
      }
    },
  };
}

/** そのファイルの場所（取り込みへ渡す） */
export function downloadFilePath(folder: string, name: string): string {
  return join(folder, name);
}
