import { describe, expect, test } from "vitest";
import type { Schedule, ScheduleStep } from "../../../src/models/schedule";
import {
  paceDays,
  planSchedule,
  schedulesWithGoals,
  serialCharsBy,
  serialSlotDates,
  weekdayOf,
  type EpisodeFact,
  type PlanContext,
} from "../../../src/core/schedulePlan";
import { createSchedule, defaultSerialRule, GOALS_CONTEST_SCHEDULE_ID, type IdMaker } from "../../../src/core/scheduleTemplates";

/**
 * スケジュールの逆算（設計書6.111.3・6.111.5）。
 *
 * 暦の境目（月末・年またぎ・閏年）、手で入れた期日を保つこと、済んだ段、
 * 巡航速度が0のとき、WEB連載の予定と書き溜めを押さえる。
 */

function idMaker(): IdMaker {
  let seq = 0;
  return (prefix) => `${prefix}_${++seq}`;
}

function context(overrides: Partial<PlanContext> = {}): PlanContext {
  return {
    today: "2026-09-23",
    written: 0,
    perDay: 0,
    goalsContest: null,
    perEpisodeGoal: null,
    episodes: [],
    ...overrides,
  };
}

function step(label: string, days: number, extra: Partial<ScheduleStep> = {}): ScheduleStep {
  return { id: label, key: "custom", label, days, due: null, status: "todo", doneAt: null, note: "", ...extra };
}

function custom(milestone: string | null, steps: ScheduleStep[], kind: Schedule["kind"] = "publisher"): Schedule {
  return {
    id: "sch_1",
    kind,
    name: "テスト",
    followsGoals: false,
    milestone,
    targetChars: null,
    steps,
    serial: kind === "webSerial" ? defaultSerialRule() : null,
    note: "",
    createdAt: "",
    updatedAt: "",
  };
}

describe("後ろから詰める", () => {
  test("最後の段はマイルストーンの前日に終わり、前の段は1日前で区切られる", () => {
    const plan = planSchedule(custom("2026-12-01", [step("A", 7), step("B", 3)]), context());
    expect(plan.steps.map((s) => [s.step.label, s.start, s.end])).toEqual([
      ["A", "2026-11-21", "2026-11-27"],
      ["B", "2026-11-28", "2026-11-30"],
    ]);
    expect(plan.shortageDays).toBe(0);
    expect(plan.active).toBe(true);
  });

  test("年をまたぐ：1月3日の締切から10日遡ると前の年の12月へ", () => {
    const plan = planSchedule(custom("2027-01-03", [step("A", 10)]), context());
    expect([plan.steps[0].start, plan.steps[0].end]).toEqual(["2026-12-24", "2027-01-02"]);
  });

  test("閏年：2028年3月1日の締切の前日は2月29日", () => {
    const plan = planSchedule(custom("2028-03-01", [step("A", 2)]), context());
    expect([plan.steps[0].start, plan.steps[0].end]).toEqual(["2028-02-28", "2028-02-29"]);
  });

  test("閏年でない年：2027年3月1日の前日は2月28日", () => {
    const plan = planSchedule(custom("2027-03-01", [step("A", 1)]), context());
    expect(plan.steps[0].end).toBe("2027-02-28");
  });
});

describe("手で入れた期日", () => {
  test("期日は逆算で上書きしない。その前の段は期日から逆算する", () => {
    const plan = planSchedule(
      custom("2026-12-01", [step("打ち合わせ", 5), step("改稿", 10, { due: "2026-11-10" }), step("初校", 5)]),
      context()
    );
    const [meeting, rewrite, proof] = plan.steps;
    expect([rewrite.start, rewrite.end]).toEqual(["2026-11-01", "2026-11-10"]);
    expect([meeting.start, meeting.end]).toEqual(["2026-10-27", "2026-10-31"]);
    // あとの段はマイルストーンから
    expect([proof.start, proof.end]).toEqual(["2026-11-26", "2026-11-30"]);
    expect(rewrite.overlapDays).toBe(0);
  });

  test("期日があとの段と重なるときは、日付を動かさずに重なりの日数を出す", () => {
    const plan = planSchedule(
      custom("2026-12-01", [step("改稿", 10, { due: "2026-11-29" }), step("初校", 5)]),
      context()
    );
    const [rewrite] = plan.steps;
    expect(rewrite.end).toBe("2026-11-29");
    // 初校は 11/26〜11/30。改稿の期日は初校の始まりの前日（11/25）より4日あと
    expect(rewrite.overlapDays).toBe(4);
  });
});

describe("済んだ段", () => {
  test("逆算の鎖から外れ、済んだ日の1日として置く", () => {
    const plan = planSchedule(
      custom("2026-12-01", [step("A", 7, { status: "done", doneAt: "2026-09-20" }), step("B", 3)]),
      context()
    );
    expect([plan.steps[0].start, plan.steps[0].end]).toEqual(["2026-09-20", "2026-09-20"]);
    expect([plan.steps[1].start, plan.steps[1].end]).toEqual(["2026-11-28", "2026-11-30"]);
  });

  test("全部済むと、作業が発生していない", () => {
    const plan = planSchedule(
      custom("2026-12-01", [step("A", 7, { status: "done", doneAt: "2026-09-20" })]),
      context()
    );
    expect(plan.active).toBe(false);
  });
});

describe("間に合わない", () => {
  test("未着手の段の始まりが今日より前なら、その日数だけ足りない", () => {
    // 10/3 締切、20日の段 → 9/13 に始めるべき。今日 9/23 なら10日足りない
    const plan = planSchedule(custom("2026-10-03", [step("A", 20)]), context());
    expect(plan.steps[0].start).toBe("2026-09-13");
    expect(plan.shortageDays).toBe(10);
  });

  test("進行中の段は、終わりが今日より前のときだけ遅れる", () => {
    const onTrack = planSchedule(custom("2026-10-03", [step("A", 20, { status: "doing" })]), context());
    expect(onTrack.shortageDays).toBe(0);
    const overdue = planSchedule(
      custom("2026-10-03", [step("A", 5, { status: "doing", due: "2026-09-20" }), step("B", 3)]),
      context()
    );
    expect(overdue.shortageDays).toBe(3);
  });

  test("マイルストーンを過ぎたら、作業中に数えない", () => {
    const plan = planSchedule(custom("2026-09-01", [step("A", 3)]), context());
    expect(plan.milestonePassed).toBe(true);
    expect(plan.active).toBe(false);
  });
});

describe("執筆の日数（巡航速度）", () => {
  test("（予定の字数−今の字数）÷速度、切り上げ", () => {
    expect(paceDays(10_000, 3_000, 30)).toEqual({ days: 4, source: "pace" });
  });

  test("速度が0なら割らずに仮の日数", () => {
    expect(paceDays(10_000, 0, 30)).toEqual({ days: 30, source: "noPace" });
    expect(paceDays(10_000, Number.NaN, 30)).toEqual({ days: 30, source: "noPace" });
  });

  test("字数に届いていれば0日", () => {
    expect(paceDays(0, 0, 30)).toEqual({ days: 0, source: "pace" });
  });

  test("予定の字数が無ければ仮の日数", () => {
    expect(paceDays(null, 1000, 30)).toEqual({ days: 30, source: "noTarget" });
  });

  test("10年を超えたら止める", () => {
    expect(paceDays(10_000_000, 1, 30)).toEqual({ days: 3650, source: "tooSlow" });
  });

  test("公募の執筆の段は予定の字数と今の字数から日数を出す", () => {
    const schedule = createSchedule(
      { kind: "contest", name: "○○賞", milestone: "2026-12-01", targetChars: 100_000, now: "" },
      idMaker()
    );
    const plan = planSchedule(schedule, context({ written: 40_000, perDay: 2_000 }));
    const write = plan.steps[0];
    expect(write.days).toBe(30);
    expect(write.daysSource).toBe("pace");
    // 推敲7日・最終見直し3日のぶん前へ
    expect(write.end).toBe("2026-11-20");
    expect(write.start).toBe("2026-10-22");
  });

  test("字数に届いた執筆の段は長さ0で、遅れに数えない", () => {
    const schedule = createSchedule(
      { kind: "contest", name: "○○賞", milestone: "2026-10-01", targetChars: 10_000, now: "" },
      idMaker()
    );
    const plan = planSchedule(schedule, context({ written: 12_000, perDay: 0 }));
    expect(plan.steps[0].days).toBe(0);
    expect(plan.steps[0].lateDays).toBe(0);
  });
});

describe("マイルストーンが未定", () => {
  test("今日から前へ詰め、最短の日を出す", () => {
    const plan = planSchedule(custom(null, [step("A", 3), step("B", 2)]), context());
    expect(plan.steps.map((s) => [s.start, s.end])).toEqual([
      ["2026-09-23", "2026-09-25"],
      ["2026-09-26", "2026-09-27"],
    ]);
    expect(plan.earliestMilestone).toBe("2026-09-28");
    expect(plan.shortageDays).toBe(0);
  });
});

describe("作品目標設定の応募先とつなぐ", () => {
  const goalsContest = { name: "○○賞", deadline: "2026-12-01", targetChars: 100_000 };

  test("ファイルに無ければ、画面の上だけに既定の段取りで出す", () => {
    const listed = schedulesWithGoals({ schemaVersion: "1", schedules: [] }, goalsContest, "");
    expect(listed).toHaveLength(1);
    expect(listed[0].virtual).toBe(true);
    expect(listed[0].schedule.id).toBe(GOALS_CONTEST_SCHEDULE_ID);
    const plan = planSchedule(listed[0].schedule, context({ goalsContest }), true);
    expect(plan.name).toBe("○○賞");
    expect(plan.milestone).toBe("2026-12-01");
    expect(plan.targetChars).toBe(100_000);
  });

  test("応募先を変えたら締切も追う（写していないので）", () => {
    const schedule = createSchedule({ kind: "contest", name: "", milestone: null, followsGoals: true, now: "" }, idMaker());
    const plan = planSchedule(
      schedule,
      context({ goalsContest: { name: "△△賞", deadline: "2027-01-31", targetChars: null } })
    );
    expect(plan.name).toBe("△△賞");
    expect(plan.milestone).toBe("2027-01-31");
  });

  test("応募先が外れたら、消さずに外れていると出す", () => {
    const schedule = createSchedule({ kind: "contest", name: "", milestone: null, followsGoals: true, now: "" }, idMaker());
    const plan = planSchedule(schedule, context());
    expect(plan.detached).toBe(true);
    expect(plan.active).toBe(false);
  });

  test("ファイルに応募先に従う公募があれば、二重に出さない", () => {
    const schedule = createSchedule({ kind: "contest", name: "", milestone: null, followsGoals: true, now: "" }, idMaker());
    const listed = schedulesWithGoals({ schemaVersion: "1", schedules: [schedule] }, goalsContest, "");
    expect(listed).toHaveLength(1);
    expect(listed[0].virtual).toBe(false);
  });
});

describe("WEB連載", () => {
  function serialSchedule(start: string | null, rule: Partial<ReturnType<typeof defaultSerialRule>> = {}): Schedule {
    const schedule = createSchedule({ kind: "webSerial", name: "カクヨム連載", milestone: start, now: "" }, idMaker());
    return { ...schedule, serial: { ...defaultSerialRule(), ...rule } };
  }

  function episodes(list: Array<[number, "posted" | "written" | "plan"]>, chars = 3000): EpisodeFact[] {
    return list.map(([chapter, state]) => ({
      chapter,
      written: state !== "plan",
      posted: state === "posted",
      chars: state === "plan" ? 0 : chars,
      title: `第${chapter}話の題`,
    }));
  }

  test("曜日の決まりから投稿予定日を並べる（月・木）", () => {
    expect(weekdayOf("2026-09-24")).toBe(4);
    const dates = serialSlotDates(
      { ...defaultSerialRule(), weekdays: [1, 4], endEpisode: 4 },
      "2026-09-24",
      "2026-09-23"
    );
    expect(dates).toEqual(["2026-09-24", "2026-09-28", "2026-10-01", "2026-10-05"]);
  });

  test("終わりが無ければ1年先まで", () => {
    const dates = serialSlotDates({ ...defaultSerialRule(), weekdays: [0] }, "2026-09-27", "2026-09-23");
    expect(dates[0]).toBe("2026-09-27");
    expect(dates[dates.length - 1] <= "2027-09-27").toBe(true);
    expect(dates.length).toBeGreaterThanOrEqual(52);
  });

  test("投稿済み・書き溜め・未執筆・予定日を過ぎて未投稿を分け、書き溜めの残りを数える", () => {
    const plan = planSchedule(
      serialSchedule("2026-09-20", { endEpisode: 6, bufferEpisodes: 2 }),
      context({
        episodes: episodes([
          [1, "posted"],
          [2, "posted"],
          [3, "written"],
          [4, "written"],
          [5, "plan"],
        ]),
      })
    );
    const serial = plan.serial!;
    expect(serial.slots.map((slot) => [slot.episode, slot.date, slot.state])).toEqual([
      [1, "2026-09-20", "posted"],
      [2, "2026-09-21", "posted"],
      [3, "2026-09-22", "missed"],
      [4, "2026-09-23", "stocked"],
      [5, "2026-09-24", "unwritten"],
      [6, "2026-09-25", "unwritten"],
    ]);
    expect(serial.stock).toBe(2);
    // 予定の話（単話プロットだけ）の題を並べる
    expect(serial.slots[4].title).toBe("第5話の題");
  });

  test("書き溜めが尽きる最初の話を出す（速度が1話の字数に追いつかない）", () => {
    const plan = planSchedule(
      serialSchedule("2026-09-20", { bufferEpisodes: 0, endEpisode: 10, charsPerEpisode: 3000 }),
      context({
        perDay: 1500,
        episodes: episodes([
          [1, "posted"],
          [2, "posted"],
          [3, "posted"],
          [4, "written"],
        ]),
      })
    );
    const serial = plan.serial!;
    // 第5話（9/24投稿）は 9/23〜9/24 で書く → 投稿日に間に合わない
    expect(serial.writing[0]).toEqual({ episode: 5, start: "2026-09-23", end: "2026-09-24", late: true });
    expect(serial.firstMiss).toEqual({ episode: 5, date: "2026-09-24" });
  });

  test("速度が0なら執筆の見込みを出さず、理由を言う", () => {
    const plan = planSchedule(
      serialSchedule("2026-09-20", { endEpisode: 10, charsPerEpisode: 3000 }),
      context({ perDay: 0 })
    );
    expect(plan.serial!.writing).toEqual([]);
    expect(plan.serial!.writingNote).toContain("記録が無い");
  });

  test("開始前は、書き溜めの執筆の段が書いていない書き溜めの字数から日数を出す", () => {
    const plan = planSchedule(
      serialSchedule("2026-10-10", { bufferEpisodes: 3, charsPerEpisode: 2000 }),
      context({ perDay: 1000, episodes: episodes([[1, "written"]]) })
    );
    const buffer = plan.steps.find((s) => s.step.key === "serialBuffer")!;
    // 残り2話×2000字 ÷ 1000字 = 4日。投稿の準備2日の前
    expect(buffer.days).toBe(4);
    expect([buffer.start, buffer.end]).toEqual(["2026-10-04", "2026-10-07"]);
  });

  test("開始日が未定なら予定を並べず、理由を言う", () => {
    const plan = planSchedule(serialSchedule(null), context());
    expect(plan.serial!.slots).toEqual([]);
    expect(plan.serial!.unscheduledReason).toContain("連載開始日");
  });

  test("公募の締切までに連載で投稿される字数（目安）", () => {
    const ctx = context({
      episodes: episodes([
        [1, "posted"],
        [2, "posted"],
      ]),
    });
    const plan = planSchedule(
      serialSchedule("2026-09-22", { endEpisode: 20, charsPerEpisode: 3000 }),
      ctx
    );
    // 投稿済み（第1話 9/22・第2話 9/23）6000字 ＋ 9/24〜9/30 の未投稿の7回 × 3000字
    expect(serialCharsBy(plan.serial!, "2026-09-30", ctx)).toBe(6000 + 7 * 3000);
  });

  test("開始後は、開始前の段の遅れを数えない", () => {
    const plan = planSchedule(
      serialSchedule("2026-09-01", { endEpisode: 400, charsPerEpisode: 3000 }),
      context({ perDay: 10_000 })
    );
    expect(plan.shortageDays).toBe(0);
    expect(plan.active).toBe(true);
  });
});
