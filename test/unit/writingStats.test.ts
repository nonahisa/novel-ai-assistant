import { describe, expect, test } from "vitest";
import type {
  DailyStat,
  DeviceWritingStats,
  WritingMeasurement,
} from "../../src/models/writingStats";
import { WRITING_STATS_SCHEMA_VERSION } from "../../src/models/writingStats";
import {
  addDays,
  aggregate,
  currentStreak,
  dailyPaceNeeded,
  deviceTotals,
  emptyDeviceStats,
  mergeDailyStats,
  parseDeviceWritingStats,
  progressAgainstGoal,
  rebaseline,
  recordMeasurement,
  shouldPersist,
  statsDayKey,
  sumRange,
  totalsByLabel,
  weekStartKey,
} from "../../src/core/writingStats";
import {
  describeStatusBarProgress,
  summarize,
} from "../../src/features/writingProgress";

/** 作品を走査した結果の代わり */
function measurement(
  net: number,
  options: Partial<WritingMeasurement> = {}
): WritingMeasurement {
  return {
    net,
    gross: options.gross ?? net + 100,
    fileCount: options.fileCount ?? 19,
    conflictedCount: options.conflictedCount ?? 0,
  };
}

function day(date: string, net: number): DailyStat {
  return { date, net, gross: net, saves: 1 };
}

describe("執筆量を数える日付", () => {
  test("深夜に書いた分は前日に付ける", () => {
    // 0時で切ると「昨日の夜に書いた」ぶんが翌日へ回る
    const lateNight = new Date(2026, 7, 14, 2, 30);

    expect(statsDayKey(lateNight, 4)).toBe("2026-08-13");
  });

  test("区切りの時刻を過ぎればその日になる", () => {
    expect(statsDayKey(new Date(2026, 7, 14, 4, 0), 4)).toBe("2026-08-14");
    expect(statsDayKey(new Date(2026, 7, 14, 3, 59), 4)).toBe("2026-08-13");
  });

  test("区切りを0時にすれば暦どおりになる", () => {
    expect(statsDayKey(new Date(2026, 7, 14, 2, 30), 0)).toBe("2026-08-14");
  });

  test("設定値が壊れていても動く", () => {
    expect(statsDayKey(new Date(2026, 7, 14, 12, 0), Number.NaN)).toBe(
      "2026-08-14"
    );
  });

  test("月をまたぐ日付の足し引き", () => {
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
  });

  test("週の始まりを選べる", () => {
    // 2026-08-13は木曜
    expect(weekStartKey("2026-08-13", 1)).toBe("2026-08-10");
    expect(weekStartKey("2026-08-13", 0)).toBe("2026-08-09");
  });
});

describe("執筆量の記録", () => {
  const at = new Date(2026, 7, 13, 20, 0);

  test("初回は数えない。基準だけ置く", () => {
    // 既にある4万字を「今日書いた」ことにしない
    const result = recordMeasurement(emptyDeviceStats("desktop-a1b2"), measurement(43_755), { at });

    expect(result.counted).toBe(false);
    expect(result.reason).toBe("baseline");
    expect(result.stats.days).toEqual([]);
    expect(result.stats.baseline?.net).toBe(43_755);
  });

  test("2回目からは前回との差を積む", () => {
    const first = recordMeasurement(emptyDeviceStats("desktop-a1b2"), measurement(43_755), { at });

    const second = recordMeasurement(first.stats, measurement(44_355), { at });

    expect(second.counted).toBe(true);
    expect(second.delta).toBe(600);
    expect(second.stats.days).toEqual([
      { date: "2026-08-13", net: 600, gross: 600, saves: 1 },
    ]);
  });

  test("同じ日に何度保存しても1日にまとまる", () => {
    let stats = recordMeasurement(emptyDeviceStats("d-0001"), measurement(1_000), { at }).stats;
    stats = recordMeasurement(stats, measurement(1_400), { at }).stats;
    stats = recordMeasurement(stats, measurement(1_900), { at }).stats;

    expect(stats.days).toHaveLength(1);
    expect(stats.days[0]).toMatchObject({ net: 900, saves: 2 });
  });

  test("消した分は負として残す", () => {
    // 「今日は減った」も執筆の実態である。0で止めると総量と合わなくなる
    const first = recordMeasurement(emptyDeviceStats("d-0001"), measurement(5_000), { at });

    const second = recordMeasurement(first.stats, measurement(4_200), { at });

    expect(second.delta).toBe(-800);
    expect(second.stats.days[0].net).toBe(-800);
  });

  test("ファイルが増えたら数えない", () => {
    // ダウンロードした本文を入れただけで数十万字書いたことにしない
    const first = recordMeasurement(emptyDeviceStats("d-0001"), measurement(5_000), { at });

    const second = recordMeasurement(
      first.stats,
      measurement(705_000, { fileCount: 20 }),
      { at }
    );

    expect(second.counted).toBe(false);
    expect(second.reason).toBe("structure_changed");
    expect(second.stats.days).toEqual([]);
    // 次回はこの新しい姿を基準にする
    expect(second.stats.baseline?.net).toBe(705_000);
  });

  test("ファイルを消しても数えない", () => {
    const first = recordMeasurement(emptyDeviceStats("d-0001"), measurement(5_000), { at });

    const second = recordMeasurement(
      first.stats,
      measurement(1_000, { fileCount: 18 }),
      { at }
    );

    expect(second.counted).toBe(false);
    expect(second.stats.days).toEqual([]);
  });

  test("競合が起きた話は集計から外れるので数えない", () => {
    // 競合中の話は走査が0字として扱う。直った瞬間に「数万字書いた」
    // ことにならないよう、競合の件数が変わった回は数えない
    const first = recordMeasurement(emptyDeviceStats("d-0001"), measurement(43_755), { at });

    const conflicted = recordMeasurement(
      first.stats,
      measurement(40_000, { conflictedCount: 1 }),
      { at }
    );
    const resolved = recordMeasurement(
      conflicted.stats,
      measurement(43_800, { conflictedCount: 0 }),
      { at }
    );

    expect(conflicted.counted).toBe(false);
    expect(resolved.counted).toBe(false);
    expect(resolved.stats.days).toEqual([]);
  });

  test("増減が無ければ日の記録は作らない", () => {
    const first = recordMeasurement(emptyDeviceStats("d-0001"), measurement(5_000), { at });

    const second = recordMeasurement(first.stats, measurement(5_000), { at });

    expect(second.counted).toBe(false);
    expect(second.reason).toBe("no_change");
    expect(second.stats.days).toEqual([]);
  });

  test("増減が無い回はファイルを書き直さない", () => {
    // 設定資料を保存しただけでも記録は走る。そのたびに書き直すと、
    // 中身が同じなのに時刻だけ変わった差分が毎回git上に出る
    const first = recordMeasurement(emptyDeviceStats("d-0001"), measurement(5_000), { at });
    const unchanged = recordMeasurement(first.stats, measurement(5_000), { at });
    const written = recordMeasurement(first.stats, measurement(5_100), { at });
    const added = recordMeasurement(
      first.stats,
      measurement(5_000, { fileCount: 20 }),
      { at }
    );

    expect(shouldPersist(first)).toBe(true);
    expect(shouldPersist(unchanged)).toBe(false);
    expect(shouldPersist(written)).toBe(true);
    // 数えない回でも、基準が変わったなら残さないと次回の差が狂う
    expect(shouldPersist(added)).toBe(true);
  });

  test("取り込んだ分は基準を置き直すだけにする", () => {
    // 別の環境で書いた分を数えると、同じ文章を2台ぶん数えることになる
    const first = recordMeasurement(emptyDeviceStats("d-0001"), measurement(5_000), { at });

    const pulled = rebaseline(first.stats, measurement(9_000), at);
    const afterPull = recordMeasurement(pulled, measurement(9_300), { at });

    expect(pulled.days).toEqual([]);
    expect(afterPull.delta).toBe(300);
  });

  test("日をまたぐと別の記録になる", () => {
    const first = recordMeasurement(emptyDeviceStats("d-0001"), measurement(1_000), {
      at: new Date(2026, 7, 13, 20, 0),
    });
    const second = recordMeasurement(first.stats, measurement(1_500), {
      at: new Date(2026, 7, 14, 20, 0),
    });

    expect(second.stats.days.map((entry) => entry.date)).toEqual([
      "2026-08-14",
    ]);
  });
});

describe("記録の読み込み", () => {
  test("必要な項目がそろっていれば読む", () => {
    const parsed = parseDeviceWritingStats({
      schemaVersion: WRITING_STATS_SCHEMA_VERSION,
      deviceId: "desktop-a1b2",
      baseline: {
        net: 100,
        gross: 120,
        fileCount: 3,
        conflictedCount: 0,
        at: "2026-08-13T11:00:00.000Z",
      },
      days: [day("2026-08-13", 600)],
    });

    expect(parsed?.days).toHaveLength(1);
    expect(parsed?.baseline?.net).toBe(100);
  });

  test("壊れた記録は捨てる", () => {
    // 同期対象なので競合マーカーが混ざることがある。
    // ここで例外を投げると統計が二度と開けなくなる
    expect(parseDeviceWritingStats(null)).toBeUndefined();
    expect(parseDeviceWritingStats({ deviceId: "d-0001", days: [] })).toBeUndefined();
    expect(
      parseDeviceWritingStats({
        schemaVersion: WRITING_STATS_SCHEMA_VERSION,
        deviceId: "../evil",
        days: [],
      })
    ).toBeUndefined();
  });

  test("1日が壊れていても残りは使う", () => {
    const parsed = parseDeviceWritingStats({
      schemaVersion: WRITING_STATS_SCHEMA_VERSION,
      deviceId: "desktop-a1b2",
      days: [day("2026-08-13", 600), { date: "こわれた", net: 1 }, day("2026-08-12", 100)],
    });

    expect(parsed?.days.map((entry) => entry.date)).toEqual([
      "2026-08-12",
      "2026-08-13",
    ]);
  });

  test("壊れた基準は捨てるが、日ごとの記録は残す", () => {
    const parsed = parseDeviceWritingStats({
      schemaVersion: WRITING_STATS_SCHEMA_VERSION,
      deviceId: "desktop-a1b2",
      baseline: { net: 100 },
      days: [day("2026-08-13", 600)],
    });

    expect(parsed?.baseline).toBeUndefined();
    expect(parsed?.days).toHaveLength(1);
  });
});

describe("粒度ごとの集計", () => {
  const days = [
    day("2026-08-10", 1_000),
    day("2026-08-13", 2_000),
    day("2026-07-20", 5_000),
    day("2025-12-31", 300),
  ];

  test("書かなかった日も0として並べる", () => {
    // 書いた日だけを並べると、毎日書いているように見えてしまう
    const buckets = aggregate(days, "daily", { today: "2026-08-13", span: 5 });

    expect(buckets.map((bucket) => bucket.key)).toEqual([
      "2026-08-09",
      "2026-08-10",
      "2026-08-11",
      "2026-08-12",
      "2026-08-13",
    ]);
    expect(buckets.map((bucket) => bucket.net)).toEqual([0, 1_000, 0, 0, 2_000]);
  });

  test("週次は週の始まりでまとめる", () => {
    const buckets = aggregate(days, "weekly", {
      today: "2026-08-13",
      weekStart: 1,
      span: 2,
    });

    expect(buckets.map((bucket) => bucket.key)).toEqual([
      "2026-08-03",
      "2026-08-10",
    ]);
    // 8/10と8/13は同じ週
    expect(buckets[1].net).toBe(3_000);
  });

  test("月次は当月から遡って並べる", () => {
    const buckets = aggregate(days, "monthly", { today: "2026-08-13", span: 3 });

    expect(buckets.map((bucket) => bucket.key)).toEqual([
      "2026-06",
      "2026-07",
      "2026-08",
    ]);
    expect(buckets.map((bucket) => bucket.net)).toEqual([0, 5_000, 3_000]);
  });

  test("年次は記録のある年を必ず出す", () => {
    // 「直近5年」で切ると、それより前の記録が消えたように見える
    const buckets = aggregate([...days, day("2019-05-05", 10)], "yearly", {
      today: "2026-08-13",
      span: 3,
    });

    expect(buckets[0].key).toBe("2019");
    expect(buckets[buckets.length - 1].key).toBe("2026");
    expect(buckets.find((bucket) => bucket.key === "2025")?.net).toBe(300);
  });

  test("書いた日数は増えた日だけ数える", () => {
    const buckets = aggregate(
      [day("2026-08-12", -500), day("2026-08-13", 700)],
      "monthly",
      { today: "2026-08-13", span: 1 }
    );

    expect(buckets[0].activeDays).toBe(1);
    expect(buckets[0].net).toBe(200);
  });

  test("目盛りは日本語の見出しにする", () => {
    const buckets = aggregate(days, "monthly", { today: "2026-08-13", span: 1 });

    expect(buckets[0].label).toBe("2026年8月");
  });
});

describe("環境をまたいだ合算", () => {
  const desktop: DeviceWritingStats = {
    schemaVersion: WRITING_STATS_SCHEMA_VERSION,
    deviceId: "desktop-a1b2",
    days: [day("2026-08-13", 2_000), day("2026-08-12", 500)],
  };
  const laptop: DeviceWritingStats = {
    schemaVersion: WRITING_STATS_SCHEMA_VERSION,
    deviceId: "laptop-c3d4",
    days: [day("2026-08-13", 300)],
  };

  test("同じ日は足し合わせる", () => {
    // 同じ人が環境を渡り歩いて書いている以上、合算値が本人の総執筆量になる
    const merged = mergeDailyStats([desktop, laptop]);

    expect(merged.map((entry) => entry.date)).toEqual([
      "2026-08-12",
      "2026-08-13",
    ]);
    expect(merged[1].net).toBe(2_300);
  });

  test("環境ごとの内訳も出せる", () => {
    const totals = deviceTotals([desktop, laptop]);

    expect(totals[0]).toMatchObject({ deviceId: "desktop-a1b2", net: 2_500 });
    expect(totals[1]).toMatchObject({ deviceId: "laptop-c3d4", net: 300 });
  });

  test("ラベル付きの内訳（全作品の執筆量パネル用）は多い順に並ぶ", () => {
    const totals = totalsByLabel([
      { label: "作品A", days: [day("2026-08-13", 2_000), day("2026-08-12", 500)] },
      { label: "作品B", days: [day("2026-08-13", 300)] },
      { label: "作品C", days: [] },
    ]);

    expect(totals).toEqual([
      { label: "作品A", net: 2_500, activeDays: 2 },
      { label: "作品B", net: 300, activeDays: 1 },
      { label: "作品C", net: 0, activeDays: 0 },
    ]);
  });
});

describe("目標と連続日数", () => {
  test("達成率と残りを出す", () => {
    expect(progressAgainstGoal(600, 1_000)).toMatchObject({
      remaining: 400,
      rate: 60,
      achieved: false,
    });
    expect(progressAgainstGoal(1_200, 1_000)).toMatchObject({
      remaining: 0,
      achieved: true,
    });
  });

  test("目標未設定なら達成率を出さない", () => {
    // 目標を決めていない作者に「0%」を見せない
    expect(progressAgainstGoal(600, 0)).toMatchObject({ goal: 0, rate: 0 });
  });

  test("今日まだでも昨日まで続いていれば途切れさせない", () => {
    // 朝いちばんに「0日」と出ると、続いている実感まで消える
    const days = [
      day("2026-08-11", 100),
      day("2026-08-12", 100),
      day("2026-08-13", 0),
    ];

    expect(currentStreak(days, "2026-08-13")).toBe(2);
  });

  test("今日書けば今日も数える", () => {
    const days = [day("2026-08-12", 100), day("2026-08-13", 100)];

    expect(currentStreak(days, "2026-08-13")).toBe(2);
  });

  test("間が空いていれば数え直す", () => {
    const days = [day("2026-08-01", 100), day("2026-08-13", 100)];

    expect(currentStreak(days, "2026-08-13")).toBe(1);
  });

  test("残りの日数で割ってペースを出す", () => {
    // 8月13日なら残り19日（当日を含む）
    expect(dailyPaceNeeded(19_000, "2026-08-13")).toBe(1_000);
    expect(dailyPaceNeeded(0, "2026-08-13")).toBeNull();
  });

  test("最終日は残りをそのまま返す", () => {
    expect(dailyPaceNeeded(5_000, "2026-08-31")).toBe(5_000);
  });

  test("期間を指定して合計する", () => {
    const days = [
      day("2026-07-31", 100),
      day("2026-08-01", 200),
      day("2026-08-31", 300),
      day("2026-09-01", 400),
    ];

    expect(sumRange(days, "2026-08-01", "2026-08-31")).toMatchObject({
      net: 500,
      activeDays: 2,
    });
  });
});

describe("ステータスバーの表示", () => {
  test("目標が無ければ今日の字数だけ出す", () => {
    // 目標を設定していない作者に「0/0」のような数字を見せない
    const summary = summarize([day("2026-08-13", 560)], "2026-08-13");

    expect(describeStatusBarProgress(summary)).toBe("今日 +560字");
  });

  test("まだ書いていない日", () => {
    const summary = summarize([], "2026-08-13");

    expect(describeStatusBarProgress(summary)).toBe("今日 0字");
    expect(summary.streak).toBe(0);
  });

  test("今月の合計と書いた日数も持つ", () => {
    const summary = summarize(
      [day("2026-08-01", 100), day("2026-08-13", 560), day("2026-07-31", 999)],
      "2026-08-13"
    );

    expect(summary.monthProgress.written).toBe(660);
    expect(summary.monthActiveDays).toBe(2);
  });
});
