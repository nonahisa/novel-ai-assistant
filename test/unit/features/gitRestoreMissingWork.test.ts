import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { restoreFromHistory } from "../../../src/features/gitRestore";
import {
  STOPPED_LINE,
  UNREGISTER_BUTTON,
  present,
  setUpMissingWork,
  type MissingWorkHarness,
} from "../support/missingWorkHarness";

/**
 * 復元（過去の版に戻す）も、同じ置き場にフォルダーが無い作品があれば始めない
 * （2026-11-14。設計書5.5.14）。
 *
 * 復元は「復元の前に自動保存」と「戻したことの記録」で `git add -A` を2回走らせる。
 * 置き場ぜんぶが入るので、移した作品の削除まで記録される。
 */

let harness: MissingWorkHarness;
beforeEach(() => {
  harness = setUpMissingWork();
});
afterEach(() => harness.restore());

describe("復元：同じ置き場にフォルダーが無い作品があるとき", () => {
  test("履歴を読む前に止め、作品名入りの知らせと登録を外すボタンを出す", async () => {
    await restoreFromHistory(present, { works: harness.registry.list(), run: harness.run });
    expect(harness.writes()).toEqual([]);
    expect(harness.calls.some((args) => args[0] === "log")).toBe(false);
    const notices = harness.missingNotices();
    expect(notices).toHaveLength(1);
    expect(notices[0].message).toContain(STOPPED_LINE);
    expect(notices[0].buttons).toEqual([UNREGISTER_BUTTON]);
  });

  test("作品が全部そろっていれば、今までどおり履歴を読む", async () => {
    harness.bringBack();
    await restoreFromHistory(present, { works: harness.registry.list(), run: harness.run });
    expect(harness.calls.some((args) => args[0] === "log")).toBe(true);
    expect(harness.missingNotices()).toEqual([]);
  });
});
