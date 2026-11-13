import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { GitSyncMonitor } from "../../../src/features/gitSync";
import {
  STOPPED_LINE,
  UNREGISTER_BUTTON,
  present,
  setUpMissingWork,
  type MissingWorkHarness,
} from "../support/missingWorkHarness";
import { window } from "../support/vscodeStub";

/**
 * 作品1つの取り込み・受け取り・送信も、同じ置き場にフォルダーが無い作品があれば止める
 * （2026-11-14。設計書5.5.14）。
 *
 * 取り込むと、見えない作品のフォルダーへ git が書き戻して作り直すことがある（作者が移した先と
 * 元の場所に作品が2つできる）。送ると、止めた置き場の古い記録（移した作品の削除を含みうる）が
 * GitHub に載る。記録の道（`gitSyncMissingWork.test.ts`）と同じ知らせで止める。
 */

let harness: MissingWorkHarness;
const originalQuickPick = window.showQuickPick;
beforeEach(() => {
  harness = setUpMissingWork();
  harness.porcelain = "";
});
afterEach(() => {
  harness.restore();
  Object.assign(window, { showQuickPick: originalQuickPick });
});

type Private = {
  runPull(work: { id: string }, afterRecording: boolean): Promise<boolean>;
  runPush(work: { id: string }): Promise<boolean>;
};

function monitor(): GitSyncMonitor {
  return new GitSyncMonitor(harness.registry as never, { run: harness.run });
}

function expectStopped(): void {
  expect(harness.writes()).toEqual([]);
  const notices = harness.missingNotices();
  expect(notices).toHaveLength(1);
  expect(notices[0].message).toContain(STOPPED_LINE);
  expect(notices[0].buttons).toEqual([UNREGISTER_BUTTON]);
}

describe("作品1つの取り込み・受け取り・送信：同じ置き場にフォルダーが無い作品があるとき", () => {
  test("取り込む（未記録が無いときの素の取り込み）：取り込まずに知らせる", async () => {
    harness.counts.behind = 1;
    harness.counts.ahead = 0;
    const one = monitor();
    try {
      expect(await (one as unknown as Private).runPull(present, false)).toBe(false);
      expectStopped();
    } finally {
      one.dispose();
    }
  });

  test("受け取るだけ：受け取らずに知らせ、受け取らなかったと答える", async () => {
    harness.counts.behind = 1;
    harness.counts.ahead = 0;
    const one = monitor();
    try {
      const outcome = await one.receive(present);
      expect(outcome.kind).toBe("skipped");
      expectStopped();
    } finally {
      one.dispose();
    }
  });

  test("送信する：確認も送信もせずに知らせる", async () => {
    harness.counts.behind = 0;
    harness.counts.ahead = 1;
    let asked = 0;
    Object.assign(window, {
      showQuickPick: async () => {
        asked += 1;
        return undefined;
      },
    });
    const one = monitor();
    try {
      expect(await (one as unknown as Private).runPush(present)).toBe(false);
      expect(asked).toBe(0);
      expectStopped();
    } finally {
      one.dispose();
    }
  });
});

describe("作品が全部そろっていれば、今までどおり", () => {
  test("取り込む", async () => {
    harness.bringBack();
    harness.counts.behind = 1;
    harness.counts.ahead = 0;
    const one = monitor();
    try {
      await (one as unknown as Private).runPull(present, false);
      expect(harness.calls.some((args) => args[0] === "pull")).toBe(true);
      expect(harness.missingNotices()).toEqual([]);
    } finally {
      one.dispose();
    }
  });

  test("受け取る", async () => {
    harness.bringBack();
    harness.counts.behind = 1;
    harness.counts.ahead = 0;
    const one = monitor();
    try {
      await one.receive(present);
      expect(harness.calls.some((args) => args[0] === "pull")).toBe(true);
      expect(harness.missingNotices()).toEqual([]);
    } finally {
      one.dispose();
    }
  });

  test("送信の確認を出す", async () => {
    harness.bringBack();
    harness.counts.behind = 0;
    harness.counts.ahead = 1;
    let asked = 0;
    Object.assign(window, {
      showQuickPick: async () => {
        asked += 1;
        return undefined;
      },
    });
    const one = monitor();
    try {
      await (one as unknown as Private).runPush(present);
      expect(harness.missingNotices()).toEqual([]);
      expect(asked).toBeGreaterThan(0);
    } finally {
      one.dispose();
    }
  });
});
