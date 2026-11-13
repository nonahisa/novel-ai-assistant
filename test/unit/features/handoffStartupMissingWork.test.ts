import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("../../../src/core/logger", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/core/logger")>()),
  logFailure: vi.fn(),
  logStep: vi.fn(),
  useLogFile: vi.fn(),
  useLogFiles: vi.fn(),
  showLog: vi.fn(),
}));

import { runStartupHandoff } from "../../../src/features/handoffSync";
import { forgetMissingWorksNotices } from "../../../src/features/missingWorksNotice";
import { logFailure, logStep } from "../../../src/core/logger";
import {
  STOPPED_LINE,
  UNREGISTER_BUTTON,
  setUpMissingWork,
  type MissingWorkHarness,
} from "../support/missingWorkHarness";

/**
 * 開いたときの点検も、同じ置き場にフォルダーが無い作品があれば、その置き場では
 * 取り込みも送信もしない（2026-11-14。設計書5.5.14）。
 *
 * 点検は記録しないが、黙って取り込む・送る。取り込むと、見えない作品のフォルダーへ
 * git が書き戻して作り直すことがある（作者が移した先と元の場所に作品が2つできる）。
 *
 * **黙って飛ばさない、ただし起動のたびに何度も出さない**：知らせは1回の起動で1回まで、
 * ログには点検のたびに1行残す。
 */

let harness: MissingWorkHarness;
beforeEach(() => {
  harness = setUpMissingWork();
  forgetMissingWorksNotices();
  vi.mocked(logFailure).mockClear();
  vi.mocked(logStep).mockClear();
  // GitHub だけ進んでいる（今までなら黙って取り込む）
  harness.counts.behind = 2;
  harness.counts.ahead = 0;
  harness.porcelain = "";
});
afterEach(() => harness.restore());

function deps() {
  const store: Record<string, unknown> = {};
  return {
    registry: harness.registry as never,
    monitor: {
      refreshAll: async () => undefined,
      refresh: async () => ({ kind: "not_a_repo" }),
      statusFor: () => undefined,
    } as never,
    storage: {
      get: <T>(key: string) => store[key] as T | undefined,
      update: async (key: string, value: unknown) => {
        store[key] = value;
      },
    },
    run: harness.run,
  };
}

/** 「作品のフォルダーが見つからない」を書いたログの行 */
function missingLogLines(): string[] {
  return [...vi.mocked(logStep).mock.calls, ...vi.mocked(logFailure).mock.calls]
    .map((call) => String(call[0]))
    .filter((line) => line.includes("作品のフォルダーが見つからない"));
}

describe("開いたときの点検：同じ置き場にフォルダーが無い作品があるとき", () => {
  test("取り込まず、作品名入りの知らせと登録を外すボタンを出す", async () => {
    await runStartupHandoff(deps());
    expect(harness.writes()).toEqual([]);
    const notices = harness.missingNotices();
    expect(notices).toHaveLength(1);
    expect(notices[0].message).toContain(STOPPED_LINE);
    expect(notices[0].buttons).toEqual([UNREGISTER_BUTTON]);
    expect(missingLogLines()).toHaveLength(1);
  });

  test("同じ起動で2回走っても、知らせは1回・ログは毎回1行", async () => {
    await runStartupHandoff(deps());
    await runStartupHandoff(deps());
    expect(harness.writes()).toEqual([]);
    expect(harness.missingNotices()).toHaveLength(1);
    expect(missingLogLines()).toHaveLength(2);
  });

  test("作品が全部そろっていれば、今までどおり取り込む", async () => {
    harness.bringBack();
    await runStartupHandoff(deps());
    expect(harness.calls.some((args) => args[0] === "pull")).toBe(true);
    expect(harness.missingNotices()).toEqual([]);
  });
});
