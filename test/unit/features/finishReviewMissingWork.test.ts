import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { finishReviewAndReturn } from "../../../src/features/finishReview";
import {
  moved,
  present,
  setUpMissingWork,
  type MissingWorkHarness,
} from "../support/missingWorkHarness";
import { workspace } from "../support/vscodeStub";

/**
 * 編集者モードの「校閲を終えて返す」も、編集者の写し（作品のフォルダー）が見つからなければ、
 * git を呼ぶ前に止める（2026-11-14。設計書5.5.14）。
 *
 * 無いフォルダーでは git が起動せず、「まだ GitHub とつながっていません」と事実と違う案内が
 * 出ていた。記録の書き先を無い写しへ向けると、写しのフォルダーを作り直すおそれもある。
 * ボタンは編集者モードの言葉（「この作品の編集を終える」＝登録の解除）にそろえる。
 */

let harness: MissingWorkHarness;
const originalConfig = workspace.getConfiguration;
beforeEach(() => {
  harness = setUpMissingWork();
  harness.porcelain = "";
  // 編集者モードにする（`actorContext.ts` の `currentMode` は設定 novelai.mode を読む）
  workspace.getConfiguration = (() => ({
    get: <T>(key: string, fallback: T): T => (key === "mode" ? ("editor" as T) : fallback),
  })) as typeof workspace.getConfiguration;
});
afterEach(() => {
  harness.restore();
  workspace.getConfiguration = originalConfig;
});

describe("校閲を終えて返す：編集者の写しのフォルダーが見つからないとき", () => {
  test("git を呼ばずに止め、写しが見つからないと知らせる（GitHub とつながっていないとは言わない）", async () => {
    let confirmed = 0;
    const result = await finishReviewAndReturn(moved, {
      run: harness.run,
      works: harness.registry.list(),
      confirm: async () => {
        confirmed += 1;
        return true;
      },
    });
    expect(result.kind).toBe("missing");
    expect(harness.calls).toEqual(
      // 根を訊く1回だけ（無いフォルダーでは起動しない）。記録・送信は無い
      harness.calls.filter((args) => args.join(" ") === "rev-parse --show-toplevel")
    );
    expect(confirmed).toBe(0);
    expect(harness.warned.some((one) => one.message.includes("GitHub とつながっていません"))).toBe(false);
    const notices = harness.missingNotices();
    expect(notices).toHaveLength(1);
    expect(notices[0].message).toContain("たゆたう鉛");
    expect(notices[0].message).toContain("作者へ返していません");
    expect(notices[0].buttons).toEqual(["「たゆたう鉛」の編集を終える"]);
  });

  test("写しがそろっていれば、今までどおり返す確認へ進む", async () => {
    harness.bringBack();
    let confirmed = 0;
    await finishReviewAndReturn(present, {
      run: harness.run,
      works: harness.registry.list(),
      whoAmI: async () => "編集者",
      confirm: async () => {
        confirmed += 1;
        return false;
      },
    });
    expect(confirmed).toBe(1);
    expect(harness.missingNotices()).toEqual([]);
  });
});
