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
 *
 * ## 矢印をやめて、言葉と数字にした（2026-08-26）
 *
 * 作者の指摘：「未同期の作品がわかりません。横に数字をだせませんか？」
 *
 * それまでは `↓3 ↑2` の形で、**コミットの数だけ**を出していた。2つ足りなかった。
 *
 * 1. **記録していない変更が出ていなかった。** 書いたまま記録も送信もしていない
 *    作品は、印が何も付かず**同期済みに見えていた**
 * 2. **矢印が読み解けなかった。** 印は出ていたのに「どれが未同期か分からない」
 *    と言われた。**印があることと、伝わることは別である**
 *
 * 数は**その作品のぶんだけ**を出す。書庫（1つの置き場に複数の作品）では、
 * 置き場ぜんぶの数を各行に出すことになり、**全部の行に同じ数字が並ぶ**。
 * 実データで確かめたところ、11作品すべてに「送信待ち13」と出た——
 * **これでは、どの作品を送ればよいのか分からない。**
 *
 * 置き場ぜんぶの数は、ホバーの説明に回す（送るのも取り込むのも置き場が単位で、
 * **1つ送れば同じ置き場の作品はまとめて出ていく**。設計書5.7.9）。
 */
export function describeSyncBadge(
  status: GitSyncStatus | undefined
): string | undefined {
  if (!status) return undefined;

  switch (status.kind) {
    case "no_remote":
      // 送り先が無い作品。**記録だけは進められる**ので、その数は出す
      return join([pending("記録待ち", status.dirtyHere)]);
    case "no_upstream":
      // まだ一度も送っていない。件数では表せないので、そのまま書く
      return join([pending("記録待ち", status.dirtyHere), "未送信"]);
    case "tracked":
      return join([
        // **競合はここに出さない。** 作品の行には本文を読んで数えた
        // 「⚠競合 N件」が既に出ており、並べると同じことを2度言うことになる。
        // gitから見た未解決は、ホバーの説明で補う
        pending("記録待ち", status.dirtyHere),
        pending("送信待ち", status.aheadHere),
        pending("受け取り", status.behindHere),
      ]);
    default:
      // gitを使っていない作品には何も出さない（設計書5.5.1）
      return undefined;
  }
}

/**
 * ホバーで読む説明。
 *
 * **一覧の印は短く、意味はここで補う。** 「記録待ち」「送信待ち」が
 * それぞれ何を指すのかは、言葉だけでは伝わりきらない。
 */
export function describeSyncTooltip(
  status: GitSyncStatus | undefined
): string[] {
  if (!status) return [];

  switch (status.kind) {
    case "not_a_repo":
      return ["- Gitで管理していません（同期しません）"];
    case "git_missing":
      return ["- gitが見つかりません"];
    case "no_remote":
      return [
        line("記録待ち", status.dirtyHere, "書いたまま、まだ履歴に残していない"),
        "- 送り先（GitHub）が未設定です",
      ].filter(isText);
    case "no_upstream":
      return [
        line("記録待ち", status.dirtyHere, "書いたまま、まだ履歴に残していない"),
        "- **まだ一度も送信していません**",
      ].filter(isText);
    case "tracked":
      return [
        status.unmerged > 0
          ? `- **未解決の競合が ${status.unmerged} 件あります**（先に解決してください）`
          : undefined,
        line("記録待ち", status.dirtyHere, "書いたまま、まだ履歴に残していない"),
        line("送信待ち", status.aheadHere, "記録したが、まだGitHubへ出していない"),
        line(
          "受け取り",
          status.behindHere,
          "別の環境で書かれた分。まだ取り込んでいない"
        ),
        // **置き場ぜんぶの数は、ここでだけ出す。** 送信は置き場が単位で、
        // 1つ送れば同じ置き場の作品はまとめて出ていく（設計書5.7.9）
        wholeRepository(status),
        isSynced(status) ? "- GitHubと揃っています" : undefined,
      ].filter(isText);
    default:
      return [];
  }
}

/** その作品に、まだ済んでいないことがあるか。並べ替えや印の色に使う */
export function hasPendingSync(status: GitSyncStatus | undefined): boolean {
  return describeSyncBadge(status) !== undefined;
}

function isSynced(status: {
  dirtyHere: number;
  aheadHere: number;
  behindHere: number;
  unmerged: number;
}): boolean {
  return (
    status.dirtyHere === 0 &&
    status.aheadHere === 0 &&
    status.behindHere === 0 &&
    status.unmerged === 0
  );
}

/** 置き場ぜんぶの数。その作品ぶんと違うときだけ添える */
function wholeRepository(status: {
  ahead: number;
  behind: number;
  aheadHere: number;
  behindHere: number;
}): string | undefined {
  if (status.ahead === status.aheadHere && status.behind === status.behindHere) {
    return undefined;
  }
  const parts = [
    status.ahead > 0 ? `送信待ち ${status.ahead}件` : undefined,
    status.behind > 0 ? `受け取り ${status.behind}件` : undefined,
  ].filter(isText);
  if (parts.length === 0) return undefined;
  return `- 同じ置き場ぜんぶでは: ${parts.join("、")}（1つ送ると、まとめて出ていきます）`;
}

function pending(label: string, count: number): string | undefined {
  return count > 0 ? `${label}${count}` : undefined;
}

function line(label: string, count: number, note: string): string | undefined {
  return count > 0 ? `- ${label}: ${count}件（${note}）` : undefined;
}

function join(parts: Array<string | undefined>): string | undefined {
  const kept = parts.filter(isText);
  // **全角の中黒で区切る。** 「/」は文字数の区切りに使っており、
  // 同じ行に2種類の意味で並ぶと読みにくい
  return kept.length > 0 ? kept.join("・") : undefined;
}

function isText(value: string | undefined): value is string {
  return value !== undefined;
}
