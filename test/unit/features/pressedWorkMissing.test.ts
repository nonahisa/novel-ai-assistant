import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { GitSyncMonitor } from "../../../src/features/gitSync";
import { restoreFromHistory } from "../../../src/features/gitRestore";
import {
  UNREGISTER_BUTTON,
  moved,
  setUpMissingWork,
  type MissingWorkHarness,
} from "../support/missingWorkHarness";
import { window } from "../support/vscodeStub";

/**
 * フォルダーが見つからない作品そのものを押したときは、「作品のフォルダーが見つからない」で止める
 * （2026-11-14。設計書5.5.14）。
 *
 * 無いフォルダーでは git が起動しないので、状態が「Git が入っていない」と読まれていた。
 * 受け取りは「このパソコンに Git が入っていないため…」、復元は「Gitが見つからないため…」と
 * 事実と違う文を出し、送信は何も言わずに終わっていた。
 */

let harness: MissingWorkHarness;
let informed: string[];
const original = {
  showInformationMessage: window.showInformationMessage,
  showErrorMessage: window.showErrorMessage,
};
beforeEach(() => {
  harness = setUpMissingWork();
  harness.porcelain = "";
  informed = [];
  Object.assign(window, {
    showInformationMessage: async (message: string) => {
      informed.push(message);
      return undefined;
    },
    showErrorMessage: async (message: string) => {
      informed.push(message);
      return undefined;
    },
  });
});
afterEach(() => {
  harness.restore();
  Object.assign(window, original);
});

/** 「Git が入っていない」と読める文が、知らせにも答えにも無い */
function expectNoGitMissing(extra: string[] = []): void {
  for (const text of [...informed, ...harness.warned.map((one) => one.message), ...extra]) {
    expect(text).not.toMatch(/Git ?が(入っていない|見つからない)/);
  }
}

function expectMissingNotice(): void {
  const notices = harness.missingNotices();
  expect(notices).toHaveLength(1);
  expect(notices[0].message).toContain("作品のフォルダーが見つからないので");
  expect(notices[0].message).toContain("たゆたう鉛");
  expect(notices[0].buttons).toEqual([UNREGISTER_BUTTON]);
}

describe("フォルダーが見つからない作品そのものを押したとき", () => {
  test("受け取る：Git が入っていないとは言わず、作品のフォルダーが見つからないと知らせる", async () => {
    const one = new GitSyncMonitor(harness.registry as never, { run: harness.run });
    try {
      const outcome = await one.receive(moved);
      expect(outcome.kind).toBe("skipped");
      expectMissingNotice();
      expectNoGitMissing("reason" in outcome ? [outcome.reason] : []);
    } finally {
      one.dispose();
    }
  });

  test("送信する：黙って終わらず、作品のフォルダーが見つからないと知らせる", async () => {
    const one = new GitSyncMonitor(harness.registry as never, { run: harness.run });
    try {
      expect(await one.push(moved)).toBe(false);
      expectMissingNotice();
      expectNoGitMissing();
    } finally {
      one.dispose();
    }
  });

  test("復元：Gitが見つからないとは言わず、作品のフォルダーが見つからないと知らせる", async () => {
    await restoreFromHistory(moved, { works: harness.registry.list(), run: harness.run });
    expectMissingNotice();
    expectNoGitMissing();
  });
});
