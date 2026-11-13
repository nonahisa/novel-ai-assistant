import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("../../../src/core/logger", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/core/logger")>()),
  logFailure: vi.fn(),
  logStep: vi.fn(),
  useLogFile: vi.fn(),
  useLogFiles: vi.fn(),
  showLog: vi.fn(),
}));

import { AutoResender } from "../../../src/features/autoResend";
import { forgetMissingWorksNotices } from "../../../src/features/missingWorksNotice";
import { logFailure, logStep } from "../../../src/core/logger";
import type { GitSyncStatus } from "../../../src/core/git";
import {
  STOPPED_LINE,
  UNREGISTER_BUTTON,
  library,
  present,
  setUpMissingWork,
  type MissingWorkHarness,
} from "../support/missingWorkHarness";

/**
 * 自動の送り直しも、同じ置き場にフォルダーが無い作品があれば、その置き場へは送らない
 * （2026-11-14。設計書5.5.14）。
 *
 * 送り直しが送るのは記録済みの分だけだが、その記録に移した作品の削除が入っていれば、
 * 送った時点で GitHub でも作品が消えた形になる。置き場の作品がそろうまで送らない。
 *
 * **黙って飛ばさない、ただし送り直しのたびに何度も出さない**：知らせは1回の起動で1回まで、
 * ログには試すたびに1行残す。
 */

let harness: MissingWorkHarness;
let now = 0;
beforeEach(() => {
  harness = setUpMissingWork();
  forgetMissingWorksNotices();
  vi.mocked(logFailure).mockClear();
  vi.mocked(logStep).mockClear();
  harness.counts.behind = 0;
  harness.counts.ahead = 1;
  harness.porcelain = "";
  now = 0;
});
afterEach(() => harness.restore());

/** 見張りの控え：在る作品は送れていない分が1件。無い作品は git が起きない */
const sending: GitSyncStatus = {
  kind: "tracked",
  root: library,
  branch: "main",
  upstream: "origin/main",
  behind: 0,
  ahead: 1,
  behindHere: 0,
  aheadHere: 1,
  dirty: 0,
  dirtyHere: 0,
  unmerged: 0,
};

function resender() {
  return new AutoResender({
    registry: harness.registry,
    monitor: {
      statusFor: (id: string) =>
        id === present.id ? sending : ({ kind: "failed", detail: "起動に失敗" } as GitSyncStatus),
      refresh: async () => sending,
      refreshAll: async () => undefined,
      isOperating: () => false,
    } as never,
    run: harness.run,
    isSyncBusy: () => false,
    settings: () => ({ enabled: true, intervalMinutes: 5 }),
    now: () => now,
  });
}

function missingLogLines(): string[] {
  return [...vi.mocked(logStep).mock.calls, ...vi.mocked(logFailure).mock.calls]
    .map((call) => String(call[0]))
    .filter((line) => line.includes("作品のフォルダーが見つからない"));
}

describe("自動の送り直し：同じ置き場にフォルダーが無い作品があるとき", () => {
  test("送らず、作品名入りの知らせと登録を外すボタンを出す", async () => {
    const one = resender();
    try {
      const outcome = await one.attempt("interval");
      expect(harness.writes()).toEqual([]);
      expect(outcome?.sent).toEqual([]);
      const notices = harness.missingNotices();
      expect(notices).toHaveLength(1);
      expect(notices[0].message).toContain(STOPPED_LINE);
      expect(notices[0].buttons).toEqual([UNREGISTER_BUTTON]);
      expect(missingLogLines()).toHaveLength(1);
    } finally {
      one.dispose();
    }
  });

  test("同じ起動で2回試しても、知らせは1回・ログは毎回1行", async () => {
    const one = resender();
    try {
      await one.attempt("interval");
      now += 10 * 60_000;
      await one.attempt("interval");
      expect(harness.writes()).toEqual([]);
      expect(harness.missingNotices()).toHaveLength(1);
      expect(missingLogLines()).toHaveLength(2);
    } finally {
      one.dispose();
    }
  });

  test("作品が全部そろっていれば、今までどおり送る", async () => {
    harness.bringBack();
    const one = resender();
    try {
      await one.attempt("interval");
      expect(harness.calls.some((args) => args[0] === "push")).toBe(true);
      expect(harness.missingNotices()).toEqual([]);
    } finally {
      one.dispose();
    }
  });
});
