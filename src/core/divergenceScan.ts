import {
  isAppendOnlyPath,
  isAutoWrittenPath,
  mergeTreeArgs,
  parseMergeTree,
} from "./mergePreview";
import { isSettingsJsonPath } from "./settingsConflictRule";
import type { DivergenceConflicts, GitCommandRunner } from "./git";

/**
 * 分かれている置き場で、**同じ箇所の衝突が何件あるか**を先に数える（設計書5.5.18）。
 *
 * 作者の指摘（2026-09-10）：「競合解決があるかないかわからない。件数が出ない」。
 *
 * `git merge-tree --write-tree` は作業ツリーにもブランチにも触らずに、
 * 畳んだ結果を算出する。**ローカルだけで完結するので速く、押す前に出せる。**
 *
 * 衝突を分けて数えるのは、**作者が次に何をすることになるか**が
 * 種類で変わるからである。
 *
 * | 種類 | 誰が決めるか |
 * |---|---|
 * | 自動で書かれるもの | 機械（この端末の側を残す） |
 * | 追記型（履歴・提案・ロック） | 機械（**どちらも捨てず、両方の行を残す**） |
 * | 設定資料のJSON | 機械（`settingsConflictRule.ts` の規則）。決まらなければ作者 |
 * | 本文 | 作者（1件ずつ見比べて選ぶ） |
 */

/** merge-tree の判定にかける上限。ローカルだけなのですぐ返るはず */
const MERGE_TREE_TIMEOUT_MS = 60_000;

/** 衝突したファイル名を、誰が決めるかで分ける。**純粋関数** */
export function classifyConflicts(
  conflicts: readonly string[]
): DivergenceConflicts {
  const autoWritten = conflicts.filter(isAutoWrittenPath);
  const rest = conflicts.filter((file) => !isAutoWrittenPath(file));
  // 追記型は、片側を残すのではなく**両方の行を残して混ぜる**ので、
  // 自動で書かれるものとは別に数える（`mergePreview.ts`）
  const appendOnly = rest.filter(isAppendOnlyPath);
  const authored = rest.filter((file) => !isAppendOnlyPath(file));
  return {
    autoWritten,
    appendOnly,
    settings: authored.filter(isSettingsJsonPath),
    manuscripts: authored.filter((file) => !isSettingsJsonPath(file)),
  };
}

/**
 * 分かれている置き場の衝突を、机上で数える。
 *
 * **落ちても黙って undefined を返す。** これは表示のための数字であって、
 * 取れなかったからといって同期を止める理由にはならない（古いgitでは
 * `--write-tree` が無い）。
 */
export async function readDivergenceConflicts(
  root: string,
  upstream: string,
  run: GitCommandRunner
): Promise<DivergenceConflicts | undefined> {
  const preview = parseMergeTree(
    await run(mergeTreeArgs("HEAD", upstream), root, MERGE_TREE_TIMEOUT_MS)
  );
  if (preview.kind === "unsupported" || preview.kind === "failed") {
    return undefined;
  }
  return classifyConflicts(preview.conflicts);
}

/**
 * 作者が1件ずつ選ぶことになる件数。0なら同期の中で自動で合わせられる。
 *
 * **追記型は数えない。** 両方の行を残すだけなので、作者は何も選ばない。
 */
export function authoredConflictCount(
  conflicts: DivergenceConflicts | undefined
): number {
  if (!conflicts) return 0;
  return conflicts.settings.length + conflicts.manuscripts.length;
}
