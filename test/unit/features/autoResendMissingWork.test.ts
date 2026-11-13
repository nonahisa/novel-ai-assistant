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
import type { WorkEntry } from "../../../src/models/types";
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
 * 自動の送り直しも、同じ置き場にフォルダーが無い作品があれば、その置き場へは送らない
 * （2026-11-14。設計書5.5.14）。
 *
 * 送り直しが送るのは記録済みの分だけだが、その記録に移した作品の削除が入っていれば、
 * 送った時点で GitHub でも作品が消えた形になる。置き場の作品がそろうまで送らない。
 *
 * **黙って飛ばさない、ただし送り直しのたびに何度も出さない**：知らせは同じ組につき1回の起動で
 * 1回まで。ログは失敗と同じく同じ組では続けて書かず、組が変わったとき・そろって再び送れたときに1行。
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

  test("同じ組で続けて試しても、知らせは1回・ログも1行（同じ理由は続けて書かない）", async () => {
    const one = resender();
    try {
      await one.attempt("interval");
      now += 10 * 60_000;
      await one.attempt("interval");
      now += 10 * 60_000;
      await one.attempt("interval");
      expect(harness.writes()).toEqual([]);
      expect(harness.missingNotices()).toHaveLength(1);
      expect(missingLogLines()).toHaveLength(1);
    } finally {
      one.dispose();
    }
  });

  test("見つからない作品の組が変わったら、ログをもう1行・知らせももう1回", async () => {
    const third = {
      id: "w3",
      title: "三作目",
      folderPath: "C:/書庫/三作目",
      registeredAt: "2026-10-01T00:00:00.000Z",
    } as WorkEntry;
    const one = resender();
    try {
      await one.attempt("interval");
      now += 10 * 60_000;
      harness.registry.list = () => [present, moved, third];
      await one.attempt("interval");
      expect(harness.writes()).toEqual([]);
      expect(missingLogLines()).toHaveLength(2);
      expect(missingLogLines()[1]).toContain("たゆたう鉛、三作目");
      expect(harness.missingNotices()).toHaveLength(2);
    } finally {
      one.dispose();
    }
  });

  test("そろって再び送れたら、送った1行に見送った回数を添える", async () => {
    const one = resender();
    try {
      await one.attempt("interval");
      now += 10 * 60_000;
      await one.attempt("interval");
      harness.bringBack();
      now += 10 * 60_000;
      await one.attempt("interval");
      expect(harness.calls.some((args) => args[0] === "push")).toBe(true);
      const sentLine = vi
        .mocked(logStep)
        .mock.calls.map((call) => String(call[0]))
        .find((line) => line.startsWith("自動の送り直し：送った"));
      expect(sentLine).toContain("作品のフォルダーがそろうまで 2回見送った");
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
