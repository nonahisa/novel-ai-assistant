/**
 * いま走っている操作を覚えておき、同じものの2本目を始めさせない
 * （作者の報告 2026-09-12。理由と対象は `exclusiveCommands.ts` にある）。
 *
 * **覚える箱（`Set`）は呼び出し側が持つ。** ここにモジュール変数として
 * 置くと、テストごとに前の状態が残るうえ、拡張機能の再読み込みで
 * 解けないまま残る余地ができる。箱を渡す形なら、生存期間は
 * `activate` のスコープと一致する。
 *
 * VS Code APIに依存しない。
 */

import { exclusiveLabelOf } from "./exclusiveCommands";

/**
 * 走らせてよいかを決め、よければ「走っている」と記録する。
 *
 * **塞ぐ対象でないIDは、いつでも `true`**（覚えもしない）。画面を開くだけの
 * 操作まで覚えると、解き忘れたときに二度と押せなくなる箱が増えるだけである。
 *
 * @returns 始めてよければ `true`。既に走っていれば `false`
 */
export function beginCommand(running: Set<string>, id: string): boolean {
  if (exclusiveLabelOf(id) === undefined) return true;
  if (running.has(id)) return false;
  running.add(id);
  return true;
}

/**
 * 走り終えた（あるいは失敗・中止した）ことを記録する。
 *
 * **呼び出し側は `finally` で必ず通すこと。** 解き忘れると、その操作が
 * 二度と押せなくなる——重複起動より重い壊れ方である。
 */
export function endCommand(running: Set<string>, id: string): void {
  running.delete(id);
}
