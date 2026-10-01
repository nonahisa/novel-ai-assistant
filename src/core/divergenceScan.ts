import {
  isAppendOnlyPath,
  isAutoWrittenPath,
  mergeTreeArgs,
  parseMergeTree,
} from "./mergePreview";
import { decideSettingsConflict, isSettingsJsonPath } from "./settingsConflictRule";
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
 * 見比べ（`walkConflicts`）の入口をどう始めるか（作者の裁定、2026-10-01 案2）。
 *
 * 確認の窓（［保存・同期］の［同期する］や、分岐合流の［合わせる］）で
 * 先に選んでもらい、**続けて出ていた入口の窓を省く。**
 *
 * - `newest`：設定資料は更新時刻の新しいほうへまとめて寄せ、本文だけ1件ずつ
 * - `oneByOne`：設定資料も本文も1件ずつ
 * - `manuscriptsOnly`：確認の窓では「選ぶ設定資料は無い」と見込んでいた。
 *   **見込みが外れて設定資料が出たら、入口の窓で訊く**（訊いていないことを決めない）
 */
export type ConflictWalkStart = "newest" | "oneByOne" | "manuscriptsOnly";

/**
 * 設定資料の衝突のうち、**規則で決まらず作者が選ぶ見込みのもの**を机上で調べる
 * （作者の裁定、2026-10-01 案2）。
 *
 * 合わせる側（`foldDivergence`）は、合流の途中で索引の3つの版（祖先・こちら・
 * 向こう）を読んで `decideSettingsConflict` にかける。ここでは同じ3つの版を
 * **合流を始めずに**コミットから読む（祖先＝`merge-base`）。判断は同じ関数なので、
 * 見込みと実際は食い違わない（名前を変えたファイルのように版を取れないものは、
 * 選ぶ側に数える）。
 *
 * **落ちたら undefined。** 表示とボタンの出し分けのための数字であって、
 * 取れないことは同期を止める理由にならない。
 */
export async function readUndecidedSettings(
  root: string,
  upstream: string,
  settings: readonly string[],
  run: GitCommandRunner
): Promise<string[] | undefined> {
  if (settings.length === 0) return [];
  const mergeBase = await run(["merge-base", "HEAD", upstream], root, MERGE_TREE_TIMEOUT_MS);
  if (mergeBase.code !== 0) return undefined;
  const baseCommit = mergeBase.stdout.trim();
  if (baseCommit === "") return undefined;

  const show = async (rev: string, file: string): Promise<string | undefined> => {
    const result = await run(["show", `${rev}:${file}`], root, MERGE_TREE_TIMEOUT_MS);
    return result.code === 0 ? result.stdout : undefined;
  };

  const undecided: string[] = [];
  for (const file of settings) {
    const ours = await show("HEAD", file);
    const theirs = await show(upstream, file);
    if (ours === undefined || theirs === undefined) {
      // 片方に無い（名前の変更・削除とぶつかった）。**比べられないものは選ぶ側**
      undecided.push(file);
      continue;
    }
    const base = await show(baseCommit, file);
    if (decideSettingsConflict({ base, ours, theirs }).side === "conflict") {
      undecided.push(file);
    }
  }
  return undecided;
}

/**
 * 作者が選ぶ見込みの設定資料の件数。**調べていなければ全部を数える**（安全な側）
 */
export function settingsToChooseCount(
  conflicts: DivergenceConflicts | undefined
): number {
  if (!conflicts) return 0;
  return (conflicts.undecidedSettings ?? conflicts.settings).length;
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
