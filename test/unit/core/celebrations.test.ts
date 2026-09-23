import { describe, expect, test } from "vitest";
import {
  ACHIEVEMENT_WINDOW_DAYS,
  appendAchievements,
  celebrationSize,
  dailyAchievementId,
  deadlineAchievementId,
  describeAchievement,
  footCheer,
  judgeAchievements,
  monthlyAchievementId,
  parseAchievementLog,
  pendingCelebrations,
  workAchievementId,
  type Achievement,
  type AchievementJudgeInput,
} from "../../../src/core/celebrations";
import type { WorkGoals } from "../../../src/models/workGoals";

/**
 * 目標の達成を祝う（設計書6.3.8）。
 *
 * **一度きり**がいちばん大事なところである。保存のたびに風船が上がれば、
 * 祝いではなく邪魔になる。「繰り返さない」と「目標を変えたら改めて祝える」
 * の両方を見る——片方だけなら、一度も祝わない実装でも満点になる。
 */

const AT = new Date("2026-09-23T10:00:00");

function goals(contest: Partial<NonNullable<WorkGoals["contest"]>> | null): WorkGoals {
  return {
    schemaVersion: "0.1",
    perEpisodeChars: null,
    contest: contest
      ? {
          name: "第1回テスト大賞",
          url: null,
          deadline: "2026-09-30",
          minChars: 100_000,
          maxChars: null,
          dailyGoal: null,
          ...contest,
        }
      : null,
  };
}

function input(overrides: Partial<AchievementJudgeInput> = {}): AchievementJudgeInput {
  return {
    at: AT,
    day: "2026-09-23",
    wrote: true,
    dailyGoal: 0,
    todayTotal: 0,
    monthlyGoal: 0,
    monthTotal: 0,
    known: new Set<string>(),
    ...overrides,
  };
}

function kinds(list: readonly Achievement[]): string[] {
  return list.map((entry) => entry.kind).sort();
}

describe("1日・1か月の目標", () => {
  test("1日の目標に届いたら、1日の達成になる", () => {
    const found = judgeAchievements(
      input({ dailyGoal: 1_000, todayTotal: 1_020 })
    );
    expect(kinds(found)).toEqual(["daily"]);
    expect(found[0].id).toBe(dailyAchievementId("2026-09-23", 1_000));
    expect(found[0].goal).toBe(1_000);
    expect(found[0].written).toBe(1_020);
    expect(found[0].day).toBe("2026-09-23");
  });

  test("届いていなければ何も起きない", () => {
    expect(
      judgeAchievements(input({ dailyGoal: 1_000, todayTotal: 999 }))
    ).toEqual([]);
  });

  test("目標が0（未設定）なら祝わない", () => {
    expect(
      judgeAchievements(input({ dailyGoal: 0, todayTotal: 5_000 }))
    ).toEqual([]);
  });

  test("同じ日・同じ目標では二度祝わない", () => {
    const known = new Set([dailyAchievementId("2026-09-23", 1_000)]);
    expect(
      judgeAchievements(input({ dailyGoal: 1_000, todayTotal: 2_000, known }))
    ).toEqual([]);
  });

  test("目標の値を変えたら、新しい値で改めて祝える", () => {
    const known = new Set([dailyAchievementId("2026-09-23", 1_000)]);
    const found = judgeAchievements(
      input({ dailyGoal: 1_500, todayTotal: 2_000, known })
    );
    expect(kinds(found)).toEqual(["daily"]);
  });

  test("次の日は、同じ目標でも改めて祝える", () => {
    const known = new Set([dailyAchievementId("2026-09-22", 1_000)]);
    const found = judgeAchievements(
      input({ dailyGoal: 1_000, todayTotal: 1_000, known })
    );
    expect(kinds(found)).toEqual(["daily"]);
  });

  test("1か月の目標は月ごとに1回", () => {
    const found = judgeAchievements(
      input({ monthlyGoal: 30_000, monthTotal: 30_000 })
    );
    expect(kinds(found)).toEqual(["monthly"]);
    expect(found[0].id).toBe(monthlyAchievementId("2026-09", 30_000));

    const again = judgeAchievements(
      input({
        monthlyGoal: 30_000,
        monthTotal: 31_000,
        day: "2026-09-28",
        known: new Set([found[0].id]),
      })
    );
    expect(again).toEqual([]);
  });

  test("書いて増えた保存でなければ祝わない（取り込み・削った回）", () => {
    expect(
      judgeAchievements(
        input({ wrote: false, dailyGoal: 1_000, todayTotal: 5_000 })
      )
    ).toEqual([]);
  });

  test("合計が読めなかったときは祝わない（0とも届いたとも言わない）", () => {
    expect(
      judgeAchievements(
        input({ dailyGoal: 1_000, todayTotal: undefined, monthlyGoal: 1, monthTotal: undefined })
      )
    ).toEqual([]);
  });
});

describe("作品の文字量と締切", () => {
  const work = (written: number, contest = goals({})) => ({
    id: "w1",
    title: "空の港",
    goals: contest,
    written,
  });

  test("締切前に作品の文字量へ届いたら、作品と締切の両方", () => {
    const found = judgeAchievements(input({ work: work(100_000) }));
    expect(kinds(found)).toEqual(["deadline", "work"]);
    const workEntry = found.find((entry) => entry.kind === "work")!;
    expect(workEntry.id).toBe(workAchievementId("w1", 100_000));
    expect(workEntry.workTitle).toBe("空の港");
    const deadlineEntry = found.find((entry) => entry.kind === "deadline")!;
    expect(deadlineEntry.id).toBe(
      deadlineAchievementId("w1", "第1回テスト大賞", "2026-09-30", 100_000)
    );
    expect(deadlineEntry.deadline).toBe("2026-09-30");
  });

  test("締切当日に届いても、締切前として祝う（当日いっぱい書ける）", () => {
    const found = judgeAchievements(
      input({ day: "2026-09-30", work: work(100_000) })
    );
    expect(kinds(found)).toEqual(["deadline", "work"]);
  });

  test("締切を過ぎてから届いたら、作品の文字量だけ", () => {
    const found = judgeAchievements(
      input({ day: "2026-10-01", work: work(100_000) })
    );
    expect(kinds(found)).toEqual(["work"]);
  });

  test("届いていなければ何も起きない", () => {
    expect(judgeAchievements(input({ work: work(99_999) }))).toEqual([]);
  });

  test("応募先が無ければ作品の目標は無い", () => {
    expect(
      judgeAchievements(input({ work: work(500_000, goals(null)) }))
    ).toEqual([]);
  });

  test("同じ作品・同じ目標値では二度祝わない", () => {
    const known = new Set([
      workAchievementId("w1", 100_000),
      deadlineAchievementId("w1", "第1回テスト大賞", "2026-09-30", 100_000),
    ]);
    expect(
      judgeAchievements(input({ work: work(120_000), known }))
    ).toEqual([]);
  });

  test("目標の字数を変えたら、改めて祝える", () => {
    const known = new Set([workAchievementId("w1", 100_000)]);
    const found = judgeAchievements(
      input({ work: work(120_000, goals({ minChars: 120_000 })), known })
    );
    expect(kinds(found)).toEqual(["deadline", "work"]);
  });

  test("上限を超えているときは祝わない（削る必要がある）", () => {
    const found = judgeAchievements(
      input({ work: work(8_200, goals({ minChars: null, maxChars: 8_000 })) })
    );
    expect(found).toEqual([]);
  });

  test("上限しか無い応募は、上限に届いたところで祝う", () => {
    const found = judgeAchievements(
      input({ work: work(8_000, goals({ minChars: null, maxChars: 8_000 })) })
    );
    expect(kinds(found)).toEqual(["deadline", "work"]);
  });

  test("書いて増えた保存でなければ祝わない", () => {
    expect(
      judgeAchievements(input({ wrote: false, work: work(100_000) }))
    ).toEqual([]);
  });
});

describe("祝い方の大きさ", () => {
  test("1日だけなら少なめの風船", () => {
    expect(celebrationSize(["daily"])).toBe("small");
  });
  test("1か月なら風船", () => {
    expect(celebrationSize(["daily", "monthly"])).toBe("balloons");
  });
  test("作品・締切なら花火も", () => {
    expect(celebrationSize(["work"])).toBe("fireworks");
    expect(celebrationSize(["daily", "deadline"])).toBe("fireworks");
  });
  test("何も無ければ祝わない", () => {
    expect(celebrationSize([])).toBeUndefined();
  });
});

function record(overrides: Partial<Achievement>): Achievement {
  return {
    id: "x",
    kind: "daily",
    day: "2026-09-23",
    at: "2026-09-23T10:00:00.000Z",
    goal: 1_000,
    written: 1_000,
    ...overrides,
  };
}

describe("原稿エディターの下の欄の一言", () => {
  test("今日の達成があれば、いちばん大きいものを1つ言う", () => {
    const records = [
      record({ id: "a", kind: "daily" }),
      record({ id: "b", kind: "monthly" }),
    ];
    expect(footCheer(records, "2026-09-23", "w1")).toBe(
      "今月の目標に届きました"
    );
    expect(footCheer([records[0]], "2026-09-23", "w1")).toBe(
      "今日の目標に届きました"
    );
  });

  test("昨日の達成は言わない（その日の間だけ残す）", () => {
    expect(
      footCheer([record({ day: "2026-09-22" })], "2026-09-23", "w1")
    ).toBeUndefined();
  });

  test("ほかの作品の達成は言わない", () => {
    const other = record({ kind: "work", workId: "w2", workTitle: "別作" });
    expect(footCheer([other], "2026-09-23", "w1")).toBeUndefined();
    expect(footCheer([other], "2026-09-23", "w2")).toBe(
      "作品の目標の字数に届きました"
    );
  });

  test("締切前の書き上げがいちばん大きい", () => {
    const list = [
      record({ id: "a", kind: "work", workId: "w1" }),
      record({ id: "b", kind: "deadline", workId: "w1" }),
      record({ id: "c", kind: "daily" }),
    ];
    expect(footCheer(list, "2026-09-23", "w1")).toBe(
      "締切より前に書き上げました"
    );
  });
});

describe("まだ見せていない祝い", () => {
  test("見せたものは除き、見せていないものだけを返す", () => {
    const list = [record({ id: "a" }), record({ id: "b", kind: "monthly" })];
    const pending = pendingCelebrations(list, new Set(["a"]), "2026-09-23");
    expect(pending.map((entry) => entry.id)).toEqual(["b"]);
  });

  test("古すぎる達成は、あとから風船を上げない", () => {
    const old = record({ id: "old", day: "2026-08-01" });
    const recent = record({ id: "new", day: "2026-09-20" });
    const pending = pendingCelebrations([old, recent], new Set(), "2026-09-23");
    expect(pending.map((entry) => entry.id)).toEqual(["new"]);
    expect(ACHIEVEMENT_WINDOW_DAYS).toBeGreaterThan(0);
  });
});

describe("達成の記録の読み書き", () => {
  test("同じ鍵は足さない（一度きり）", () => {
    const merged = appendAchievements(
      [record({ id: "a" })],
      [record({ id: "a", written: 9 }), record({ id: "b" })]
    );
    expect(merged.map((entry) => entry.id)).toEqual(["a", "b"]);
    // 先にあったほうを残す（最初に届いた時の記録が正しい）
    expect(merged[0].written).toBe(1_000);
  });

  test("上限を超えたら古いものから落とす", () => {
    const many = Array.from({ length: 5 }, (_, index) =>
      record({ id: `r${index}` })
    );
    const merged = appendAchievements(many, [record({ id: "new" })], 3);
    expect(merged.map((entry) => entry.id)).toEqual(["r3", "r4", "new"]);
  });

  test("読めた記録はそのまま戻る", () => {
    const list = [record({ id: "a", kind: "work", workId: "w1", workTitle: "空" })];
    expect(parseAchievementLog({ schemaVersion: "0.1", achievements: list })).toEqual(list);
  });

  test("形の壊れた記録は例外にする（直して上書きしない）", () => {
    expect(() => parseAchievementLog("<<<<<<< HEAD")).toThrow();
    expect(() => parseAchievementLog({ achievements: "x" })).toThrow();
  });

  test("知らない種類の行は読み飛ばす（先の版が足したものでも止めない）", () => {
    const parsed = parseAchievementLog({
      achievements: [record({ id: "a" }), { id: "z", kind: "future" }],
    });
    expect(parsed.map((entry) => entry.id)).toEqual(["a"]);
  });
});

describe("達成の言い方", () => {
  test("1日・1か月・作品・締切を言い分ける", () => {
    expect(describeAchievement(record({ kind: "daily", goal: 1_000 }))).toBe(
      "1日の目標（1,000字）"
    );
    expect(
      describeAchievement(record({ kind: "monthly", day: "2026-09-23", goal: 30_000 }))
    ).toBe("2026年9月の目標（30,000字）");
    expect(
      describeAchievement(
        record({ kind: "work", workTitle: "空の港", goal: 100_000 })
      )
    ).toBe("「空の港」作品の文字量（100,000字）");
    expect(
      describeAchievement(
        record({
          kind: "deadline",
          workTitle: "空の港",
          goal: 100_000,
          contestName: "第1回テスト大賞",
          deadline: "2026-09-30",
        })
      )
    ).toBe("「空の港」を第1回テスト大賞の締切（2026-09-30）より前に書き上げ");
  });
});
