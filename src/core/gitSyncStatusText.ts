import type { GitSyncStatus } from "./git";

/**
 * 同期状態を、ツリーの右側に出す短い印にする（設計書5.5.1）。
 *
 * **`features/gitSync.ts` から切り出した。** あちらは先頭で `node:child_process`
 * を読み込む `core/git.ts` を使うため、importするだけでブラウザ向けビルドが
 * 壊れる。この関数はツリーの各行（作品一覧）を描くたびに呼ぶので、
 * ブラウザでも安全に使える形で独立させる必要があった（設計書5.8.5）。
 *
 * ここで見ているのは `GitSyncStatus` という**型**だけで、
 * gitを実際に呼ぶ処理は一切無い。
 */
export function describeSyncBadge(
  status: GitSyncStatus | undefined
): string | undefined {
  if (!status || status.kind !== "tracked") return undefined;
  const parts: string[] = [];
  if (status.behind > 0) parts.push(`↓${status.behind}`);
  if (status.ahead > 0) parts.push(`↑${status.ahead}`);
  return parts.length > 0 ? parts.join(" ") : undefined;
}
