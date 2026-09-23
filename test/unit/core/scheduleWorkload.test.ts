import { describe, expect, test } from "vitest";
import type { Schedule, ScheduleFile, ScheduleStep } from "../../../src/models/schedule";
import { parallelGroups, planSchedule, type PlanContext } from "../../../src/core/schedulePlan";
import { settleLoad, SpanLoad, type LoadTask } from "../../../src/core/scheduleLoad";
import { buildScheduleBoard, type WorkScheduleInput } from "../../../src/core/scheduleBoard";
import { createSchedule, templateSteps, type IdMaker } from "../../../src/core/scheduleTemplates";
import { buildWorkCalendar, DEFAULT_WORKLOAD, type WorkloadSettings } from "../../../src/core/workCalendar";
import { NO_HOLIDAYS, type HolidaySet } from "../../../src/core/holidays";
import { dayDiff } from "../../../src/core/schedulePlan";

/**
 * 休む日（作業量の割合）・並行・重なりの逆算（設計書6.111.12〜6.111.14）。
 *
 * 押さえること：既定（全部1・並行なし・重なりなし）では 0.83.0 と同じ並び／手で入れた期日は
 * 動かさない（規則2）／祝日の境目・年またぎ／重なり0・1・3／輪になった並行のつなぎでも止まる／
 * 重なりの並べ直しが止まり、決まった形になる。
 */

const TODAY = "2026-09-23"; // 水曜

function idMaker(): IdMaker {
  let seq = 0;
  return (prefix) => `${prefix}_${++seq}`;
}

function step(id: string, days: number, extra: Partial<ScheduleStep> = {}): ScheduleStep {
  return { id, key: "custom", label: id, days, due: null, status: "todo", doneAt: null, note: "", ...extra };
}

function schedule(id: string, milestone: string | null, steps: ScheduleStep[]): Schedule {
  return {
    id,
    kind: "publisher",
    name: id,
    followsGoals: false,
    milestone,
    targetChars: null,
    steps,
    serial: null,
    note: "",
    createdAt: "",
    updatedAt: "",
  };
}

function context(patch: Partial<PlanContext> = {}): PlanContext {
  return { today: TODAY, written: 0, perDay: 0, goalsContest: null, perEpisodeGoal: null, episodes: [], ...patch };
}

function calendar(patch: Partial<WorkloadSettings>, holidays: HolidaySet = NO_HOLIDAYS) {
  return buildWorkCalendar({ ...DEFAULT_WORKLOAD, ...patch }, holidays, TODAY);
}

const span = (plan: ReturnType<typeof planSchedule>) => plan.steps.map((s) => [s.step.id, s.start, s.end]);

describe("既定は 0.83.0 と同じ", () => {
  test("暦を渡しても、全部1なら同じ並び", () => {
    const steps = [step("A", 7), step("B", 3)];
    const plain = planSchedule(schedule("s", "2026-12-01", steps), context());
    const withCalendar = planSchedule(
      schedule("s", "2026-12-01", steps),
      context({ calendar: calendar({}, { source: "", fetchedAt: "2026-01-01", dates: { "2026-11-23": "勤労感謝の日" } }) })
    );
    expect(span(withCalendar)).toEqual(span(plain));
    expect(span(plain)).toEqual([
      ["A", "2026-11-21", "2026-11-27"],
      ["B", "2026-11-28", "2026-11-30"],
    ]);
  });
});

describe("休む日（割合0）", () => {
  test("土日を休むと、段は平日だけで数える（締切が月曜なら、終わりは金曜へ寄る）", () => {
    // 2026-12-07 は月曜。割り戻しの平均は 30日の平日の割合（5/7 前後）
    const cal = calendar({ weekend: 0 });
    const plan = planSchedule(schedule("s", "2026-12-07", [step("A", 5)]), context({ calendar: cal }));
    const a = plan.steps[0];
    expect(a.end).toBe("2026-12-04"); // 金曜（日曜・土曜は休み）
    // 5日ぶんの量は、平日の進み（1 ÷ 平均）で割ると 5 × 平均 ≒ 3〜4 平日
    expect(a.start >= "2026-11-30").toBe(true);
    expect(a.start <= "2026-12-01").toBe(true);
  });

  test("水曜だけ休む：水曜をまたぐ段は1日延びる", () => {
    const cal = calendar({ byWeekday: [null, null, null, 0, null, null, null] });
    // 割り戻しで、平日1日の進みは 1 ÷ (6/7前後) ≒ 1.17。休みを含む週の段は暦の日数で7日前後
    const plan = planSchedule(schedule("s", "2026-12-12", [step("A", 7)]), context({ calendar: cal }));
    const a = plan.steps[0];
    expect(a.end).toBe("2026-12-11");
    expect(dayDiff(a.start, a.end) + 1).toBeGreaterThanOrEqual(7);
    expect(dayDiff(a.start, a.end) + 1).toBeLessThanOrEqual(8);
  });

  test("祝日だけ休む：祝日の前日に終わる段の次の段は、祝日を飛ばす", () => {
    const holidays: HolidaySet = { source: "", fetchedAt: "2026-01-01", dates: { "2026-11-23": "勤労感謝の日" } };
    const cal = calendar({ holiday: 0 }, holidays);
    // 締切11月24日：最後の段の終わりは前日の23日（祝日＝休み）なので22日へ寄る
    const plan = planSchedule(schedule("s", "2026-11-24", [step("A", 3)]), context({ calendar: cal }));
    expect(plan.steps[0].end).toBe("2026-11-22");
    expect(plan.steps[0].start).toBe("2026-11-20");
  });

  test("手で入れた期日は、休みの日でも動かさない（規則2）", () => {
    const cal = calendar({ weekend: 0 });
    const plan = planSchedule(
      schedule("s", "2026-12-20", [step("A", 3), step("B", 3, { due: "2026-12-06" })]), // 12-06 は日曜
      context({ calendar: cal })
    );
    expect(plan.steps[1].end).toBe("2026-12-06");
    expect(plan.steps[1].step.due).toBe("2026-12-06");
  });

  test("年をまたぐ：1月4日の締切から、年末年始の祝日を休んで遡る", () => {
    const holidays: HolidaySet = {
      source: "",
      fetchedAt: "2026-01-01",
      dates: { "2027-01-01": "元日", "2027-01-02": "テスト", "2027-01-03": "テスト" },
    };
    const cal = calendar({ holiday: 0 }, holidays);
    const plan = planSchedule(schedule("s", "2027-01-04", [step("A", 3)]), context({ calendar: cal }));
    expect(plan.steps[0].end).toBe("2026-12-31");
    expect(plan.steps[0].start).toBe("2026-12-29");
  });

  test("人に頼む段は休みに従わない（頼んだ先の暦で進む）", () => {
    const cal = calendar({ weekend: 0 });
    const plan = planSchedule(
      schedule("s", "2026-12-07", [step("表紙", 7, { key: "cover", actor: "others" })]),
      context({ calendar: cal })
    );
    expect([plan.steps[0].start, plan.steps[0].end]).toEqual(["2026-11-30", "2026-12-06"]);
  });

  test("執筆の段：巡航速度の30日の並びで割り戻すので、休日に多く書く設定でも30日ぶんの字数は30日で書ける", () => {
    // 平日1・土日3。30日で 30 × 1000字 を書く速さ（巡航速度 1000字/日）
    const cal = calendar({ weekday: 1, weekend: 3 });
    const contest: Schedule = {
      ...schedule("s", null, [step("W", 30, { key: "write" })]),
      kind: "contest",
      targetChars: 30_000,
    };
    // 今日から前へ詰める：割り戻しの30日（今日を含む直近30日）と同じ曜日の並びが続く30日なら30日
    const plan = planSchedule(contest, context({ calendar: cal, perDay: 1000 }));
    const w = plan.steps[0];
    expect(dayDiff(w.start, w.end) + 1).toBeGreaterThanOrEqual(29);
    expect(dayDiff(w.start, w.end) + 1).toBeLessThanOrEqual(31);
  });
});

describe("並行", () => {
  test("自費出版の雛形：表紙は推敲と並行（同じ日に終わる）", () => {
    const created = createSchedule({ kind: "selfPublish", name: "電子", milestone: "2027-03-01", now: "" }, idMaker());
    const revise = created.steps.find((s) => s.key === "revise")!;
    const cover = created.steps.find((s) => s.key === "cover")!;
    expect(cover.parallelWith).toBe(revise.id);
    expect(cover.actor).toBe("others");
    expect(revise.actor).toBe("self");
    const plan = planSchedule(created, context());
    const planned = (id: string) => plan.steps.find((s) => s.step.id === id)!;
    expect(planned(cover.id).end).toBe(planned(revise.id).end);
    // 組の前（執筆）は、組でいちばん早い始まり（表紙の14日）の前日に終わる
    const write = plan.steps.find((s) => s.step.key === "write")!;
    expect(dayDiff(write.end, planned(cover.id).start)).toBe(1);
    expect([planned(revise.id).tracks, planned(cover.id).tracks]).toEqual([2, 2]);
    expect(new Set([planned(revise.id).track, planned(cover.id).track])).toEqual(new Set([0, 1]));
  });

  test("並行のない雛形の段の並びは変えない（公募・出版社・連載）", () => {
    for (const kind of ["contest", "publisher", "webSerial"] as const) {
      expect(templateSteps(kind, idMaker()).every((s) => s.parallelWith === null)).toBe(true);
    }
  });

  test("輪になったつなぎ（AがBと、BがAと）・自分を指す・無い段を指すでも止まり、決まった組になる", () => {
    const chain = [
      step("A", 3, { parallelWith: "B" }),
      step("B", 3, { parallelWith: "A" }),
      step("C", 3, { parallelWith: "C" }),
      step("D", 3, { parallelWith: "消した段" }),
      step("E", 3, { parallelWith: "A" }),
    ];
    expect(parallelGroups(chain).map((group) => group.map((s) => s.id))).toEqual([["A", "B", "E"], ["C"], ["D"]]);
  });

  test("前へ詰める（マイルストーン未定）：組は同じ日に始まり、次は組の遅いほうの翌日から", () => {
    const plan = planSchedule(
      schedule("s", null, [step("A", 5), step("B", 2, { parallelWith: "A" }), step("C", 1)]),
      context()
    );
    expect(span(plan)).toEqual([
      ["A", TODAY, "2026-09-27"],
      ["B", TODAY, "2026-09-24"],
      ["C", "2026-09-28", "2026-09-28"],
    ]);
    expect(plan.earliestMilestone).toBe("2026-09-29");
  });

  test("済んだ段と並行にしていた段は、前の段が終わってからに戻る", () => {
    const plan = planSchedule(
      schedule("s", "2026-12-01", [
        step("A", 3, { status: "done", doneAt: "2026-09-01" }),
        step("B", 2, { parallelWith: "A" }),
      ]),
      context()
    );
    expect(plan.steps[1].tracks).toBe(1);
    expect([plan.steps[1].start, plan.steps[1].end]).toEqual(["2026-11-29", "2026-11-30"]);
  });
});

describe("重なり（作品をまたぐ）", () => {
  const input = (workId: string, file: ScheduleFile): WorkScheduleInput => ({
    workId,
    title: workId,
    file,
    error: null,
    context: context(),
  });
  const board = (works: WorkScheduleInput[], penalty = 0.1) =>
    buildScheduleBoard(works, {
      today: TODAY,
      now: "",
      showFinished: true,
      calendar: calendar({ overlapPenalty: penalty }),
    });
  const stepsOf = (b: ReturnType<typeof board>, workId: string) =>
    b.columns.find((c) => c.workId === workId)!.plans[0].steps;

  test("重なり0：1作品だけなら 0.83.0 と同じ", () => {
    const b = board([input("w1", { schemaVersion: "1", schedules: [schedule("s1", "2026-12-01", [step("A", 10)])] })]);
    const a = stepsOf(b, "w1")[0];
    expect([a.start, a.end, a.peakLoad]).toEqual(["2026-11-21", "2026-11-30", 1]);
  });

  test("重ならない2作品は互いに影響しない", () => {
    const b = board([
      input("w1", { schemaVersion: "1", schedules: [schedule("s1", "2026-11-01", [step("A", 10)])] }),
      input("w2", { schemaVersion: "1", schedules: [schedule("s2", "2026-12-01", [step("B", 10)])] }),
    ]);
    expect(stepsOf(b, "w1")[0].peakLoad).toBe(1);
    expect(stepsOf(b, "w2")[0].peakLoad).toBe(1);
    expect(stepsOf(b, "w2")[0].start).toBe("2026-11-21");
  });

  test("重なり1（2つが重なる）：両方が延びて始まりが早まり、注意が出る", () => {
    const b = board([
      input("w1", { schemaVersion: "1", schedules: [schedule("s1", "2026-12-01", [step("A", 10)])] }),
      input("w2", { schemaVersion: "1", schedules: [schedule("s2", "2026-12-01", [step("B", 10)])] }),
    ]);
    const a = stepsOf(b, "w1")[0];
    const bb = stepsOf(b, "w2")[0];
    // 2つが同じ日に重なる：1つあたり 0.45 日ぶん／日 → 10 ÷ 0.45 ≒ 22.2 → 23日
    expect(a.peakLoad).toBe(2);
    expect(a.end).toBe("2026-11-30");
    expect(dayDiff(a.start, a.end) + 1).toBe(23);
    expect([bb.start, bb.end]).toEqual([a.start, a.end]);
    const alerts = b.columns[0].plans[0].alerts.join("\n");
    expect(alerts).toContain("作業が2つ重なっています（速さ 約5割）");
  });

  test("重なり3（3作品）：重なりの数と速さの注意", () => {
    const works = ["w1", "w2", "w3"].map((id) =>
      input(id, { schemaVersion: "1", schedules: [schedule(`s_${id}`, "2026-12-01", [step("A", 9)])] })
    );
    const b = board(works);
    const a = stepsOf(b, "w1")[0];
    expect(a.peakLoad).toBe(3);
    // 1つあたり 0.81 ÷ 3 = 0.27 → 9 ÷ 0.27 ≒ 33.3 → 34日
    expect(dayDiff(a.start, a.end) + 1).toBe(34);
    expect(b.columns[0].plans[0].alerts.join("\n")).toContain("作業が3つ重なっています（速さ 約3割）");
  });

  test("人に頼む段は重なりに数えない", () => {
    const b = board([
      input("w1", { schemaVersion: "1", schedules: [schedule("s1", "2026-12-01", [step("A", 10)])] }),
      input("w2", {
        schemaVersion: "1",
        schedules: [schedule("s2", "2026-12-01", [step("表紙", 10, { key: "cover", actor: "others" })])],
      }),
    ]);
    expect(stepsOf(b, "w1")[0].peakLoad).toBe(1);
    expect(stepsOf(b, "w1")[0].start).toBe("2026-11-21");
  });

  test("重なりで延びた結果、間に合わなくなる判定にも効く", () => {
    // 今日から締切まで15日。ひとりなら10日で足りるが、2つ重なると足りない
    const alone = board([
      input("w1", { schemaVersion: "1", schedules: [schedule("s1", "2026-10-08", [step("A", 10)])] }),
    ]);
    expect(alone.columns[0].plans[0].shortageDays).toBe(0);
    const both = board([
      input("w1", { schemaVersion: "1", schedules: [schedule("s1", "2026-10-08", [step("A", 10)])] }),
      input("w2", { schemaVersion: "1", schedules: [schedule("s2", "2026-10-08", [step("B", 10)])] }),
    ]);
    expect(both.columns[0].plans[0].shortageDays).toBeGreaterThan(0);
  });

  test("同じ作品の中の並行も、自分で進める段どうしなら重なりに数える", () => {
    const b = board([
      input("w1", {
        schemaVersion: "1",
        schedules: [schedule("s1", "2026-12-01", [step("A", 10), step("B", 10, { parallelWith: "A" })])],
      }),
    ]);
    const [a, bb] = stepsOf(b, "w1");
    expect(a.peakLoad).toBe(2);
    expect(bb.peakLoad).toBe(2);
    expect(a.end).toBe("2026-11-30");
  });

  test("作品の並び順を入れ替えても結果は同じ（先に並べた作品だけが得をしない）", () => {
    const w1 = input("w1", { schemaVersion: "1", schedules: [schedule("s1", "2026-12-01", [step("A", 10)])] });
    const w2 = input("w2", { schemaVersion: "1", schedules: [schedule("s2", "2026-12-10", [step("B", 6), step("C", 6)])] });
    const forward = board([w1, w2]);
    const backward = board([w2, w1]);
    for (const id of ["w1", "w2"]) {
      expect(stepsOf(forward, id).map((s) => [s.start, s.end])).toEqual(stepsOf(backward, id).map((s) => [s.start, s.end]));
    }
  });
});

describe("重なりの並べ直しは止まる", () => {
  test("重なりが無ければ1回で終わる", () => {
    const result = settleLoad(() => ({ result: "x", tasks: [{ key: "a", start: "2026-10-01", end: "2026-10-05" }] }), 0.1);
    expect(result).toEqual({ result: "x", rounds: 1, converged: true });
  });

  test("並びが行き来して決まらない形でも、上限の回数で止まる（入力が同じなら同じ結果）", () => {
    // 重なりを受けるたびに、片方が前後に跳ねる（わざと決まらない並べ方）
    let calls = 0;
    const flip = (load: SpanLoad | undefined): { result: number; tasks: LoadTask[] } => {
      calls++;
      // 1回目は重なる所へ置き、重なりを受けたら離れ、離れたら戻る
      const overlapped = load ? load.countOn("2026-10-03") >= 2 : false;
      return {
        result: calls,
        tasks: [
          { key: "a", start: "2026-10-01", end: "2026-10-05" },
          overlapped
            ? { key: "b", start: "2026-10-10", end: "2026-10-12" }
            : { key: "b", start: "2026-10-02", end: "2026-10-04" },
        ],
      };
    };
    const first = settleLoad((load) => flip(load as SpanLoad | undefined), 0.1, 6);
    expect(first.converged).toBe(false);
    expect(first.rounds).toBe(6);
    expect(calls).toBe(6);
  });

  test("ふつうの重なりは数回で決まる", () => {
    const works: WorkScheduleInput[] = ["w1", "w2", "w3"].map((id, index) => ({
      workId: id,
      title: id,
      file: {
        schemaVersion: "1",
        schedules: [schedule(`s_${id}`, `2026-12-0${index + 1}`, [step("A", 8), step("B", 5), step("C", 3)])],
      },
      error: null,
      context: context(),
    }));
    const cal = calendar({});
    // 盤面の結果が決まる（注意に「決まりきらない」が出ない）ことを見る
    const b = buildScheduleBoard(works, { today: TODAY, now: "", showFinished: true, calendar: cal });
    expect(b.notes).toEqual([]);
    // 重なっていることは確かめる（重ならない盤面で「決まった」を見ても意味がない）
    expect(b.columns.some((column) => column.plans[0].steps.some((s) => s.peakLoad > 1))).toBe(true);
  });
});

describe("深い重なりでも決まる", () => {
  test("5作品が60日の段で重なっても、上限より前に決まり、5作品とも同じ扱い", () => {
    const works: WorkScheduleInput[] = [0, 1, 2, 3, 4].map((index) => ({
      workId: `w${index}`,
      title: `w${index}`,
      file: {
        schemaVersion: "1",
        schedules: [schedule(`s${index}`, `2027-06-0${index + 1}`, [step("a", 60), step("b", 20), step("c", 10)])],
      },
      error: null,
      context: context(),
    }));
    const b = buildScheduleBoard(works, { today: TODAY, now: "", showFinished: true, calendar: calendar({}) });
    expect(b.notes).toEqual([]);
    const peaks = b.columns.map((column) => column.plans[0].steps.map((s) => s.peakLoad));
    expect(peaks.every((row) => row.every((peak) => peak === 5))).toBe(true);
  });
});

describe("SpanLoad", () => {
  test("自分の期間は数えず、ほかの作業だけを数える", () => {
    const load = new SpanLoad(
      [
        { key: "a", start: "2026-10-01", end: "2026-10-05" },
        { key: "b", start: "2026-10-04", end: "2026-10-08" },
      ],
      0.1
    );
    expect(load.othersOn("a", "2026-10-04")).toBe(1);
    expect(load.othersOn("a", "2026-10-02")).toBe(0);
    expect(load.othersOn("c", "2026-10-04")).toBe(2);
    expect(load.hasOverlap()).toBe(true);
  });
});
