import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { runSetupStep } from "../../../src/features/gitOnboarding";
import { buildSyncTarget } from "../../../src/core/syncTarget";
import {
  STOPPED_LINE,
  UNREGISTER_BUTTON,
  library,
  moved,
  present,
  setUpMissingWork,
  type MissingWorkHarness,
} from "../support/missingWorkHarness";

/**
 * GitHub のセットアップの「最初の記録」も、置き場にフォルダーが無い作品があれば作らない
 * （2026-11-14。設計書5.5.14）。
 *
 * 最初の記録（`commitFirstRecord`）は `git add -A` で置き場ぜんぶを入れる。
 * 作品が見えないまま記録すると、その作品が入っていない1つ目の記録ができ、送れば
 * GitHub にもその形で載る。はじめての送信（`firstPush`）も同じ入口（`ensureFirstRecord`）を通る。
 */

let harness: MissingWorkHarness;
beforeEach(() => {
  harness = setUpMissingWork();
});
afterEach(() => harness.restore());

const target = () => buildSyncTarget(library, [present, moved]);

describe("セットアップ：置き場にフォルダーが無い作品があるとき", () => {
  test("Gitで管理を始める：初期化も記録もせず、作品名入りの知らせを出す", async () => {
    const ok = await runSetupStep(target(), { kind: "not_a_repo" }, harness.run);
    expect(ok).toBe(false);
    expect(harness.writes()).toEqual([]);
    const notices = harness.missingNotices();
    expect(notices).toHaveLength(1);
    expect(notices[0].message).toContain(STOPPED_LINE);
    expect(notices[0].buttons).toEqual([UNREGISTER_BUTTON]);
  });

  test("はじめての送信：送らず、作品名入りの知らせを出す", async () => {
    const ok = await runSetupStep(
      target(),
      { kind: "no_upstream", root: library, branch: "main", dirty: 0, dirtyHere: 0 } as never,
      harness.run
    );
    expect(ok).toBe(false);
    expect(harness.writes()).toEqual([]);
    expect(harness.missingNotices()).toHaveLength(1);
  });

  test("作品が全部そろっていれば、はじめての送信は今までどおり送り先を読みに進む", async () => {
    harness.bringBack();
    await runSetupStep(
      target(),
      { kind: "no_upstream", root: library, branch: "main", dirty: 0, dirtyHere: 0 } as never,
      harness.run
    );
    expect(harness.calls.some((args) => args.join(" ") === "remote get-url origin")).toBe(true);
    expect(harness.missingNotices()).toEqual([]);
  });
});
