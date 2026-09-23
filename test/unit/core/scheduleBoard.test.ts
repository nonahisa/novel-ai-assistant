import { describe, expect, test } from "vitest";
import type { ScheduleFile } from "../../../src/models/schedule";
import { buildScheduleBoard, type WorkScheduleInput } from "../../../src/core/scheduleBoard";
import { collectScheduleNotices, scheduleNoticeText } from "../../../src/core/scheduleNotice";
import type { PlanContext } from "../../../src/core/schedulePlan";
import { createSchedule, type IdMaker } from "../../../src/core/scheduleTemplates";
import { updateStep } from "../../../src/core/scheduleEdit";

/**
 * スケジュールの画面の中身と知らせ（設計書6.111.7・6.111.9）。
 *
 * **作業が発生している作品だけを並べる**（作者の指定、2026-09-23）。
 */

const today = "2026-09-23";

function idMaker(): IdMaker {
  let seq = 0;
  return (prefix) => `${prefix}_${++seq}`;
}

function context(overrides: Partial<PlanContext> = {}): PlanContext {
  return { today, written: 0, perDay: 0, goalsContest: null, perEpisodeGoal: null, episodes: [], ...overrides };
}

function work(workId: string, file: ScheduleFile | null, overrides: Partial<WorkScheduleInput> = {}): WorkScheduleInput {
  return { workId, title: `作品${workId}`, file, error: null, context: context(), ...overrides };
}

function fileOf(kind: "publisher" | "contest", milestone: string | null): ScheduleFile {
  return { schemaVersion: "1", schedules: [createSchedule({ kind, name: "予定", milestone, now: "t" }, idMaker())] };
}

const empty: ScheduleFile = { schemaVersion: "1", schedules: [] };

describe("並べる作品", () => {
  test("スケジュールの無い作品・過ぎた作品・全部済んだ作品は出さない", () => {
    let allDone = fileOf("publisher", "2027-03-01");
    for (const step of allDone.schedules[0].steps) {
      allDone = updateStep(allDone, allDone.schedules[0].id, step.id, { status: "done" }, today, "t");
    }
    const board = buildScheduleBoard(
      [
        work("A", fileOf("publisher", "2027-03-01")),
        work("B", empty),
        work("C", fileOf("publisher", "2026-09-01")),
        work("D", allDone),
      ],
      { today, now: "t", showFinished: false }
    );
    expect(board.columns.map((column) => column.workId)).toEqual(["A"]);
    expect(board.hiddenCount).toBe(2);
  });

  test("「済んだ作品も見る」なら、過ぎた・済んだ作品も出す（スケジュールの無い作品は出さない）", () => {
    const board = buildScheduleBoard(
      [work("A", fileOf("publisher", "2027-03-01")), work("B", empty), work("C", fileOf("publisher", "2026-09-01"))],
      { today, now: "t", showFinished: true }
    );
    expect(board.columns.map((column) => column.workId)).toEqual(["A", "C"]);
  });

  test("読めなかった作品はいつも出す（隠すと壊れていることに気づけない）", () => {
    const board = buildScheduleBoard([work("X", null, { error: "読めません" })], {
      today,
      now: "t",
      showFinished: false,
    });
    expect(board.columns).toHaveLength(1);
    expect(board.columns[0].error).toBe("読めません");
  });

  test("作品目標設定の応募先がある作品は、ファイルが無くても公募の列が出る", () => {
    const board = buildScheduleBoard(
      [work("A", empty, { context: context({ goalsContest: { name: "○○賞", deadline: "2026-12-01", targetChars: null } }) })],
      { today, now: "t", showFinished: false }
    );
    expect(board.columns[0].plans[0]).toMatchObject({ name: "○○賞", virtual: true });
  });
});

describe("縦の範囲と注意", () => {
  test("今日より2週前から、最後の予定の2週後まで", () => {
    const board = buildScheduleBoard([work("A", fileOf("publisher", "2027-03-01"))], {
      today,
      now: "t",
      showFinished: false,
    });
    expect(board.from).toBe("2026-09-09");
    expect(board.to).toBe("2027-03-15");
  });

  test("遅れている段があれば上へ広げ、「間に合いません」とはっきり出す", () => {
    const board = buildScheduleBoard([work("A", fileOf("publisher", "2026-10-15"))], {
      today,
      now: "t",
      showFinished: false,
    });
    const plan = board.columns[0].plans[0];
    expect(plan.shortageDays).toBeGreaterThan(0);
    expect(plan.alerts[0]).toBe(`間に合いません（あと${plan.shortageDays}日足りない）`);
    expect(board.from < "2026-09-09").toBe(true);
  });

  test("速度が0の執筆の段には、仮の日数だと書く", () => {
    const board = buildScheduleBoard(
      [work("A", { schemaVersion: "1", schedules: [{ ...fileOf("contest", "2027-03-01").schedules[0], targetChars: 50000 }] })],
      { today, now: "t", showFinished: false }
    );
    expect(board.columns[0].plans[0].alerts.join("\n")).toContain("仮の30日");
  });
});

describe("知らせ", () => {
  test("今日・明日に始める段と、間に合わない予定を数えて1文にする", () => {
    // 5日の段1つ・マイルストーン 9/29 → 9/23〜9/27（今日始める）
    const file: ScheduleFile = {
      schemaVersion: "1",
      schedules: [
        {
          ...createSchedule({ kind: "publisher", name: "新刊", milestone: "2026-09-29", now: "t" }, idMaker()),
          steps: [{ id: "s", key: "custom", label: "見直し", days: 5, due: null, status: "todo", doneAt: null, note: "" }],
        },
      ],
    };
    const board = buildScheduleBoard([work("A", file), work("B", fileOf("publisher", "2026-10-15"))], {
      today,
      now: "t",
      showFinished: false,
    });
    const counts = collectScheduleNotices(board.columns, today);
    expect(counts.startingSoon).toBeGreaterThanOrEqual(1);
    expect(counts.late).toBe(1);
    expect(counts.milestoneSoon).toBe(1);
    expect(scheduleNoticeText(counts)).toMatch(/^スケジュール：間に合わない予定が1つ・/);
  });

  test("何も無い日は出さない", () => {
    expect(
      scheduleNoticeText({ startingSoon: 0, dueSoon: 0, milestoneSoon: 0, late: 0, stockRunningOut: 0 })
    ).toBeNull();
  });
});
