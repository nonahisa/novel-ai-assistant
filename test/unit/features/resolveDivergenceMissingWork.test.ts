import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { resolveDivergence } from "../../../src/features/resolveDivergence";
import {
  STOPPED_LINE,
  UNREGISTER_BUTTON,
  present,
  setUpMissingWork,
  type MissingWorkHarness,
} from "../support/missingWorkHarness";

/**
 * 「分岐合流」（`novelai.resolveDivergence`）を直に押したときも、同じ置き場に
 * フォルダーが無い作品があれば合わせない（2026-11-14。設計書5.5.14）。
 *
 * 合わせる本体（`foldDivergence`）は、合わせる前の自動保存で `git add -A` を走らせ、
 * 合流でも作業木へ書き戻す。移した作品の削除まで記録され、送れば GitHub でも消えた形になる。
 */

let harness: MissingWorkHarness;
beforeEach(() => {
  harness = setUpMissingWork();
  // 両方に動きがある（分かれている）
  harness.counts.behind = 1;
  harness.counts.ahead = 1;
});
afterEach(() => harness.restore());

describe("分岐合流：同じ置き場にフォルダーが無い作品があるとき", () => {
  test("取りに行かず・合わせず、作品名入りの知らせと登録を外すボタンを出す", async () => {
    await resolveDivergence({ registry: harness.registry as never, run: harness.run }, present);
    expect(harness.writes()).toEqual([]);
    expect(harness.calls.some((args) => args[0] === "fetch" || args[0] === "merge-tree")).toBe(false);
    const notices = harness.missingNotices();
    expect(notices).toHaveLength(1);
    expect(notices[0].message).toContain(STOPPED_LINE);
    expect(notices[0].buttons).toEqual([UNREGISTER_BUTTON]);
  });

  test("作品が全部そろっていれば、今までどおり取りに行く", async () => {
    harness.bringBack();
    await resolveDivergence({ registry: harness.registry as never, run: harness.run }, present);
    expect(harness.calls.some((args) => args[0] === "fetch")).toBe(true);
    expect(harness.missingNotices()).toEqual([]);
  });
});
