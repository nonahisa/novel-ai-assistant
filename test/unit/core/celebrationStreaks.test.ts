import { describe, expect, test } from "vitest";
import {
  advanceStreak,
  applyStreaks,
  isStreakMilestone,
  previousMonth,
  rebuildStreaks,
  streakBalloons,
  streakBookOf,
  type StreakState,
} from "../../../src/core/celebrationStreaks";
import {
  celebrationLine,
  celebrationScale,
  footCheer,
  toAchievements,
  type Achievement,
} from "../../../src/core/celebrations";

/**
 * 連続達成の祝い（設計書6.3.8、作者の裁定 2026-09-23）。
 *
 * - 1日の目標は連続した日数、1か月の目標は連続した月数で数える
 * - 2回目から毎回少しずつ風船が増える（上限あり）
 * - 節目（1日：7・14・30・50・100、以降100ごと／1か月：3・6・12、以降12ごと）では花火
 * - 途切れても何も言わず、次に届いた日から数え直す
 * - これまでの最長を超えた日（月）にも花火
 */

function dailyEntry(day: string, goal = 1000): Achievement {
  return {
    id: `daily:${day}:${goal}`,
    kind: "daily",
    day,
    at: `${day}T10:00:00.000Z`,
    goal,
    written: goal,
  };
}

function monthlyEntry(day: string, goal = 30000): Achievement {
  return {
    id: `monthly:${day.slice(0, 7)}:${goal}`,
    kind: "monthly",
    day,
    at: `${day}T10:00:00.000Z`,
    goal,
    written: goal,
  };
}

/** 日を順に届かせて、最後の結果を返す */
function runDays(days: readonly string[]) {
  let state: StreakState | undefined;
  let last: ReturnType<typeof advanceStreak> | undefined;
  for (const day of days) {
    last = advanceStreak(state, day, "daily");
    state = last.state;
  }
  if (!last) throw new Error("日がありません");
  return last;
}

function consecutiveDays(from: string, count: number): string[] {
  const start = new Date(`${from}T00:00:00Z`);
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(start);
    date.setUTCDate(start.getUTCDate() + index);
    return date.toISOString().slice(0, 10);
  });
}

describe("連続の数え方", () => {
  test("初めて届いた日は1日目", () => {
    const result = runDays(["2026-09-01"]);
    expect(result.streak).toBe(1);
    expect(result.state).toEqual({
      last: "2026-09-01",
      current: 1,
      best: 1,
      bestLast: "2026-09-01",
    });
  });

  test("翌日に届けば続き、1日空けば1から数え直す", () => {
    expect(runDays(["2026-09-01", "2026-09-02", "2026-09-03"]).streak).toBe(3);
    const broken = runDays(["2026-09-01", "2026-09-02", "2026-09-04"]);
    expect(broken.streak).toBe(1);
    // 途切れても最長は残る
    expect(broken.state.best).toBe(2);
  });

  test("月末をまたいでも続く", () => {
    expect(runDays(["2026-08-30", "2026-08-31", "2026-09-01"]).streak).toBe(3);
    expect(runDays(["2026-04-30", "2026-05-01"]).streak).toBe(2);
  });

  test("年末をまたいでも続く", () => {
    expect(runDays(["2026-12-30", "2026-12-31", "2027-01-01"]).streak).toBe(3);
  });

  test("うるう年の2月29日をはさむ", () => {
    expect(runDays(["2028-02-28", "2028-02-29", "2028-03-01"]).streak).toBe(3);
    // うるう年でない年は 2/28 の翌日が 3/1
    expect(runDays(["2027-02-28", "2027-03-01"]).streak).toBe(2);
    // うるう年で 2/29 を飛ばしたら途切れる
    expect(runDays(["2028-02-28", "2028-03-01"]).streak).toBe(1);
  });

  test("同じ日にもう一度届いても（目標を変えた）数は増えず、節目も繰り返さない", () => {
    const days = consecutiveDays("2026-09-01", 7);
    const seventh = runDays(days);
    expect(seventh.streak).toBe(7);
    expect(seventh.milestone).toBe(true);
    const again = advanceStreak(seventh.state, "2026-09-07", "daily");
    expect(again.streak).toBe(7);
    expect(again.milestone).toBe(false);
    expect(again.record).toBe(false);
    expect(again.state).toEqual(seventh.state);
  });

  test("日付が戻った（区切りの時刻を変えた等）ときは記録を動かさず、連続も言わない", () => {
    const state = runDays(["2026-09-01", "2026-09-02"]).state;
    const back = advanceStreak(state, "2026-08-31", "daily");
    expect(back.state).toEqual(state);
    expect(back.streak).toBeUndefined();
    expect(back.milestone).toBe(false);
  });

  test("1か月は暦の月で数え、年をまたいでも続く", () => {
    expect(previousMonth("2027-01")).toBe("2026-12");
    expect(previousMonth("2026-03")).toBe("2026-02");
    let state: StreakState | undefined;
    const months = ["2026-11", "2026-12", "2027-01"];
    let streak: number | undefined;
    for (const month of months) {
      const result = advanceStreak(state, month, "monthly");
      state = result.state;
      streak = result.streak;
    }
    expect(streak).toBe(3);
    const skipped = advanceStreak(state, "2027-03", "monthly");
    expect(skipped.streak).toBe(1);
  });
});

describe("節目", () => {
  test("1日は 7・14・30・50・100、以降100日ごと", () => {
    const hits = [];
    for (let n = 1; n <= 400; n++) if (isStreakMilestone("daily", n)) hits.push(n);
    expect(hits).toEqual([7, 14, 30, 50, 100, 200, 300, 400]);
  });

  test("1か月は 3・6・12、以降12か月ごと", () => {
    const hits = [];
    for (let n = 1; n <= 48; n++) if (isStreakMilestone("monthly", n)) hits.push(n);
    expect(hits).toEqual([3, 6, 12, 24, 36, 48]);
  });

  test("節目の日に届くと花火の印が付く", () => {
    const days = consecutiveDays("2026-09-01", 14);
    expect(runDays(days.slice(0, 6)).milestone).toBe(false);
    expect(runDays(days.slice(0, 7)).milestone).toBe(true);
    expect(runDays(days.slice(0, 8)).milestone).toBe(false);
    expect(runDays(days).milestone).toBe(true);
  });
});

describe("これまでの最長を超えた日", () => {
  test("前の連続（3日）を次の連続が超えた日に1度だけ印が付く", () => {
    const first = ["2026-09-01", "2026-09-02", "2026-09-03"];
    const second = consecutiveDays("2026-09-10", 6);
    const results = [];
    let state: StreakState | undefined;
    for (const day of [...first, ...second]) {
      const result = advanceStreak(state, day, "daily");
      state = result.state;
      results.push(result);
    }
    // 2つ目の連続の4日目（2026-09-13）だけ
    expect(results.map((r) => r.record)).toEqual([
      false, false, false,
      false, false, false, true, false, false,
    ]);
    expect(state?.best).toBe(6);
    expect(state?.bestLast).toBe("2026-09-15");
  });

  test("最長と並んだだけでは印は付かず、超えた日に付く", () => {
    const days = [
      ...consecutiveDays("2026-09-01", 3),
      ...consecutiveDays("2026-09-10", 4),
    ];
    const results = [];
    let state: StreakState | undefined;
    for (const day of days) {
      const result = advanceStreak(state, day, "daily");
      state = result.state;
      results.push(result.record);
    }
    expect(results).toEqual([false, false, false, false, false, false, true]);
  });

  test("連続が初めて続いたとき（前の最長が1日）は、最長を超えたとは言わない", () => {
    const results = [];
    let state: StreakState | undefined;
    for (const day of ["2026-09-01", "2026-09-03", "2026-09-04", "2026-09-05"]) {
      const result = advanceStreak(state, day, "daily");
      state = result.state;
      results.push(result.record);
    }
    expect(results).toEqual([false, false, false, false]);
  });
});

describe("風船の数", () => {
  test("1日は5個から始まり、2日目から1個ずつ増え、24個で止まる", () => {
    expect(streakBalloons("daily", undefined)).toBe(5);
    expect(streakBalloons("daily", 1)).toBe(5);
    expect(streakBalloons("daily", 2)).toBe(6);
    expect(streakBalloons("daily", 10)).toBe(14);
    expect(streakBalloons("daily", 20)).toBe(24);
    expect(streakBalloons("daily", 365)).toBe(24);
  });

  test("1か月は12個から始まり、2か月目から2個ずつ増え、30個で止まる", () => {
    expect(streakBalloons("monthly", 1)).toBe(12);
    expect(streakBalloons("monthly", 2)).toBe(14);
    expect(streakBalloons("monthly", 10)).toBe(30);
    expect(streakBalloons("monthly", 50)).toBe(30);
  });

  test("作品・締切は12個（連続は無い）", () => {
    expect(streakBalloons("work", undefined)).toBe(12);
    expect(streakBalloons("deadline", undefined)).toBe(12);
  });
});

describe("達成に連続を書き込む", () => {
  test("1日と1か月の達成に、連続・節目・最長の印を書き込む", () => {
    const book = rebuildStreaks([
      ...consecutiveDays("2026-09-01", 6).map((day) => dailyEntry(day)),
      monthlyEntry("2026-07-20"),
      monthlyEntry("2026-08-25"),
    ]);
    const { found, book: next } = applyStreaks(
      [dailyEntry("2026-09-07"), monthlyEntry("2026-09-07")],
      book
    );
    expect(found[0]).toMatchObject({ streak: 7, streakMilestone: true });
    expect(found[1]).toMatchObject({ streak: 3, streakMilestone: true });
    expect(next.daily?.current).toBe(7);
    expect(next.monthly?.current).toBe(3);
  });

  test("作品の達成には何も書かない", () => {
    const work: Achievement = {
      id: "work:a:1000",
      kind: "work",
      day: "2026-09-07",
      at: "2026-09-07T10:00:00.000Z",
      goal: 1000,
      written: 1200,
      workId: "a",
    };
    const { found, book } = applyStreaks([work], {});
    expect(found[0]).toEqual(work);
    expect(book).toEqual({});
  });

  test("1日目は連続を書かない（祝いは今までどおり）", () => {
    const { found } = applyStreaks([dailyEntry("2026-09-07")], {});
    expect(found[0].streak).toBeUndefined();
    expect(found[0].streakMilestone).toBeUndefined();
  });

  test("記録から組み直す：同じ日の達成が2つ（目標を変えた）でも1日と数える", () => {
    const book = rebuildStreaks([
      dailyEntry("2026-09-01", 1000),
      dailyEntry("2026-09-01", 1500),
      dailyEntry("2026-09-02", 1500),
    ]);
    expect(book.daily).toEqual({
      last: "2026-09-02",
      current: 2,
      best: 2,
      bestLast: "2026-09-02",
    });
    expect(book.monthly).toBeUndefined();
  });

  test("記録の並びが崩れていても日付順に数える", () => {
    const book = rebuildStreaks([
      dailyEntry("2026-09-03"),
      dailyEntry("2026-09-01"),
      dailyEntry("2026-09-02"),
    ]);
    expect(book.daily?.current).toBe(3);
  });

  test("保存してあった連続の帳面は形を確かめて読む（壊れていれば undefined）", () => {
    const good = {
      daily: { last: "2026-09-02", current: 2, best: 5, bestLast: "2026-08-20" },
    };
    expect(streakBookOf(good)).toEqual(good);
    expect(streakBookOf(undefined)).toBeUndefined();
    expect(streakBookOf("x")).toBeUndefined();
    expect(streakBookOf({ daily: { last: 3 } })).toBeUndefined();
  });
});

describe("祝いの大きさと言い方", () => {
  test("連続の節目・最長更新では1日の目標でも花火", () => {
    const plain = celebrationScale([{ ...dailyEntry("2026-09-07"), streak: 3 }]);
    expect(plain).toEqual({ size: "small", balloons: 7 });
    const milestone = celebrationScale([
      { ...dailyEntry("2026-09-07"), streak: 7, streakMilestone: true },
    ]);
    expect(milestone).toEqual({ size: "fireworks", balloons: 11 });
    const record = celebrationScale([
      { ...dailyEntry("2026-09-07"), streak: 4, streakRecord: true },
    ]);
    expect(record?.size).toBe("fireworks");
  });

  test("複数の達成なら、いちばん多い風船に揃える", () => {
    const scale = celebrationScale([
      { ...dailyEntry("2026-09-07"), streak: 3 },
      { ...monthlyEntry("2026-09-07"), streak: 2 },
    ]);
    expect(scale).toEqual({ size: "balloons", balloons: 14 });
  });

  test("何も無ければ undefined", () => {
    expect(celebrationScale([])).toBeUndefined();
  });

  test("札の行に連続を添える", () => {
    expect(celebrationLine(dailyEntry("2026-09-07"))).toBe(
      "1日の目標（1,000字）を達成"
    );
    expect(celebrationLine({ ...dailyEntry("2026-09-07"), streak: 3 })).toBe(
      "1日の目標（1,000字）を3日連続で達成"
    );
    expect(
      celebrationLine({ ...monthlyEntry("2026-09-07"), streak: 4, streakRecord: true })
    ).toBe("2026年9月の目標（30,000字）を4か月連続で達成（これまでの最長を更新）");
  });

  test("下の欄の一言にも連続を添える", () => {
    expect(
      footCheer([{ ...dailyEntry("2026-09-07"), streak: 3 }], "2026-09-07", "a")
    ).toBe("3日連続で目標に届きました");
    expect(
      footCheer([{ ...monthlyEntry("2026-09-07"), streak: 2 }], "2026-09-07", "a")
    ).toBe("2か月連続で今月の目標に届きました");
    expect(footCheer([dailyEntry("2026-09-07")], "2026-09-07", "a")).toBe(
      "今日の目標に届きました"
    );
  });

  test("globalState から読むとき、連続の印も取り戻す", () => {
    const [entry] = toAchievements([
      { ...dailyEntry("2026-09-07"), streak: 7, streakMilestone: true, streakRecord: "x" },
    ]);
    expect(entry.streak).toBe(7);
    expect(entry.streakMilestone).toBe(true);
    expect(entry.streakRecord).toBeUndefined();
  });
});
