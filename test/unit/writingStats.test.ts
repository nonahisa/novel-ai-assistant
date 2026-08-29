import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
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
  fileCountKey,
  fileNetOn,
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
  fileCountKeyFor,
  summarize,
} from "../../src/features/writingProgress";
import type { WorkEntry } from "../../src/models/types";

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

/**
 * ファイル別の内訳（作者の指示、2026-08-29「記録の持ち方を細かくして。
 * 集計画面等でおかしくならないように」）。
 *
 * **合計が正で、内訳は補助である。** 内訳を足しても、これまでの集計・
 * グラフ・目標・ステータスバーの数字は1字も変わってはいけない。
 */
describe("ファイル別の内訳", () => {
  const at = new Date(2026, 7, 13, 20, 0);

  /** 内訳つきの走査結果 */
  function withFiles(
    net: number,
    files: Record<string, { net: number; gross: number }>,
    options: Partial<WritingMeasurement> = {}
  ): WritingMeasurement {
    return { ...measurement(net, options), files };
  }

  test("ファイルごとの増減を積む", () => {
    const first = recordMeasurement(
      emptyDeviceStats("d-0001"),
      withFiles(300, {
        "本文/001.txt": { net: 200, gross: 210 },
        "本文/002.txt": { net: 100, gross: 110 },
      }),
      { at }
    );

    const second = recordMeasurement(
      first.stats,
      withFiles(450, {
        "本文/001.txt": { net: 200, gross: 210 },
        "本文/002.txt": { net: 250, gross: 265 },
      }),
      { at }
    );

    expect(second.counted).toBe(true);
    // 増えていないファイルは載せない（積むのは増減のあったものだけ）
    expect(second.stats.days[0].files).toEqual({
      "本文/002.txt": { net: 150, gross: 155 },
    });
    // **合計はこれまでどおり別に積む**
    expect(second.stats.days[0].net).toBe(150);
  });

  test("同じ日に何度保存しても、ファイルごとに足し込む", () => {
    let stats = recordMeasurement(
      emptyDeviceStats("d-0001"),
      withFiles(100, { "本文/001.txt": { net: 100, gross: 100 } }),
      { at }
    ).stats;
    stats = recordMeasurement(
      stats,
      withFiles(150, { "本文/001.txt": { net: 150, gross: 150 } }),
      { at }
    ).stats;
    stats = recordMeasurement(
      stats,
      withFiles(230, { "本文/001.txt": { net: 230, gross: 230 } }),
      { at }
    ).stats;

    expect(stats.days[0].files).toEqual({
      "本文/001.txt": { net: 130, gross: 130 },
    });
    expect(stats.days[0].net).toBe(130);
  });

  test("ファイルが増えた回は、内訳も数えない", () => {
    // ダウンロードした本文を入れただけで「書いた」ことにしない。
    // 合計と同じ扱いを内訳にも当てる
    const first = recordMeasurement(
      emptyDeviceStats("d-0001"),
      withFiles(100, { "本文/001.txt": { net: 100, gross: 100 } }),
      { at }
    );

    const second = recordMeasurement(
      first.stats,
      withFiles(
        900,
        {
          "本文/001.txt": { net: 400, gross: 400 },
          "本文/002.txt": { net: 500, gross: 500 },
        },
        { fileCount: 20 }
      ),
      { at }
    );

    expect(second.counted).toBe(false);
    expect(second.reason).toBe("structure_changed");
    expect(second.stats.days).toEqual([]);
    // 次回の差はこの新しい姿から取る
    expect(second.stats.baseline?.files).toEqual({
      "本文/001.txt": { net: 400, gross: 400 },
      "本文/002.txt": { net: 500, gross: 500 },
    });
  });

  test("初回は内訳も数えず、基準だけ置く", () => {
    const first = recordMeasurement(
      emptyDeviceStats("d-0001"),
      withFiles(43_755, { "本文/001.txt": { net: 43_755, gross: 44_000 } }),
      { at }
    );

    expect(first.stats.days).toEqual([]);
    expect(first.stats.baseline?.files).toEqual({
      "本文/001.txt": { net: 43_755, gross: 44_000 },
    });
  });

  test("基準に無いパス・現在に無いパスの差は取らない", () => {
    /*
      ファイル数が同じままパスが入れ替わるのは「名前を変えた」ときである。
      差を取ると、同じ原稿を「全部消して全部書いた」と数えてしまう。
    */
    const first = recordMeasurement(
      emptyDeviceStats("d-0001"),
      withFiles(500, {
        "本文/001.txt": { net: 200, gross: 200 },
        "本文/002.txt": { net: 300, gross: 300 },
      }),
      { at }
    );

    const renamed = recordMeasurement(
      first.stats,
      withFiles(560, {
        "本文/001.txt": { net: 200, gross: 200 },
        "本文/002_旅立ち.txt": { net: 360, gross: 360 },
      }),
      { at }
    );

    // 合計は動く（ファイル数は変わっていない）が、内訳には載せない
    expect(renamed.counted).toBe(true);
    expect(renamed.stats.days[0].net).toBe(60);
    expect(renamed.stats.days[0].files).toBeUndefined();
  });

  test("内訳を渡さなければ、これまでどおり合計だけを積む", () => {
    const first = recordMeasurement(emptyDeviceStats("d-0001"), measurement(1_000), { at });
    const second = recordMeasurement(first.stats, measurement(1_600), { at });

    expect(second.stats.days[0]).toEqual({
      date: "2026-08-13",
      net: 600,
      gross: 600,
      saves: 1,
    });
    expect(second.stats.baseline?.files).toBeUndefined();
  });

  test("鍵の区切りは / に揃える", () => {
    // WindowsとmacOSで同じ作品を書くと、揃えないと記録が2つに割れる
    expect(fileCountKey("本文\\001.txt")).toBe("本文/001.txt");
    expect(fileCountKey("本文/001.txt")).toBe("本文/001.txt");
  });

  test("今日その話で書いた量を引ける", () => {
    const days = [
      { date: "2026-08-12", net: 500, gross: 500, saves: 1 },
      {
        date: "2026-08-13",
        net: 900,
        gross: 900,
        saves: 2,
        files: {
          "本文/001.txt": { net: 600, gross: 600 },
          "本文/002.txt": { net: 300, gross: 300 },
        },
      },
    ];

    expect(fileNetOn(days, "2026-08-13", "本文/001.txt")).toBe(600);
    // 内訳に無いファイル・内訳を持たない日は0（作品合計で埋めない）
    expect(fileNetOn(days, "2026-08-13", "本文/003.txt")).toBe(0);
    expect(fileNetOn(days, "2026-08-12", "本文/001.txt")).toBe(0);
    expect(fileNetOn(days, "2026-08-11", "本文/001.txt")).toBe(0);
  });

  test("環境をまたいでも、同じ話の量は足し合わせる", () => {
    const desktop: DeviceWritingStats = {
      schemaVersion: WRITING_STATS_SCHEMA_VERSION,
      deviceId: "desktop-a1b2",
      days: [
        {
          date: "2026-08-13",
          net: 600,
          gross: 600,
          saves: 1,
          files: { "本文/001.txt": { net: 600, gross: 600 } },
        },
      ],
    };
    // **内訳を持たない端末（前の版で書いた記録）と混ざる**
    const laptop: DeviceWritingStats = {
      schemaVersion: WRITING_STATS_SCHEMA_VERSION,
      deviceId: "laptop-c3d4",
      days: [
        {
          date: "2026-08-13",
          net: 400,
          gross: 400,
          saves: 1,
          files: { "本文/001.txt": { net: 400, gross: 400 } },
        },
      ],
    };
    const old: DeviceWritingStats = {
      schemaVersion: WRITING_STATS_SCHEMA_VERSION,
      deviceId: "tablet-e5f6",
      days: [day("2026-08-13", 100)],
    };

    const merged = mergeDailyStats([desktop, laptop, old]);

    expect(fileNetOn(merged, "2026-08-13", "本文/001.txt")).toBe(1_000);
    // 合計には、内訳を持たない端末のぶんも入る
    expect(merged[0].net).toBe(1_100);
    // **元の記録を書き換えていない**（浅い写しのままだと壊れる）
    expect(desktop.days[0].files).toEqual({
      "本文/001.txt": { net: 600, gross: 600 },
    });
  });

  test("内訳の有無が混ざっても、これまでの集計は変わらない", () => {
    /*
      **内訳をわざと合計と食い違わせる。** 集計・グラフ・目標・ステータスバーが
      合計しか見ていないことを、こうすれば確かめられる（内訳を足し込んでいたら
      ここで数字が跳ねる）。実際の記録でこうなることは無い。
    */
    const withBreakdown: DailyStat = {
      date: "2026-08-13",
      net: 600,
      gross: 620,
      saves: 1,
      files: { "本文/001.txt": { net: 999_999, gross: 999_999 } },
    };
    const without = day("2026-08-12", 400);

    const buckets = aggregate([without, withBreakdown], "daily", {
      today: "2026-08-13",
      span: 2,
    });

    expect(buckets.map((bucket) => bucket.net)).toEqual([400, 600]);
    expect(sumRange([without, withBreakdown], "2026-08-01", "2026-08-31")).toEqual(
      { net: 1_000, gross: 1_020, activeDays: 2 }
    );
    expect(currentStreak([without, withBreakdown], "2026-08-13")).toBe(2);
    expect(
      summarize([without, withBreakdown], "2026-08-13").todayProgress.written
    ).toBe(600);
    expect(
      deviceTotals([
        {
          schemaVersion: WRITING_STATS_SCHEMA_VERSION,
          deviceId: "desktop-a1b2",
          days: [without, withBreakdown],
        },
      ])
    ).toEqual([{ deviceId: "desktop-a1b2", net: 1_000, activeDays: 2 }]);
  });
});

describe("内訳つきの記録を読む", () => {
  test("様式版は上げない（古い版がこの記録を読めなくなる）", () => {
    // 上げると、古い版は「読めない版」としてファイルごと捨てる。
    // 同期で他の環境の記録も読むので、被害は端末1台では済まない
    expect(WRITING_STATS_SCHEMA_VERSION).toBe("1");
  });

  test("内訳を読み取る", () => {
    const parsed = parseDeviceWritingStats({
      schemaVersion: WRITING_STATS_SCHEMA_VERSION,
      deviceId: "desktop-a1b2",
      baseline: {
        net: 100,
        gross: 120,
        fileCount: 3,
        conflictedCount: 0,
        at: "2026-08-13T11:00:00.000Z",
        files: { "本文/001.txt": { net: 100, gross: 120 } },
      },
      days: [
        {
          date: "2026-08-13",
          net: 600,
          gross: 600,
          saves: 1,
          files: { "本文/001.txt": { net: 600, gross: 600 } },
        },
      ],
    });

    expect(parsed?.days[0].files).toEqual({
      "本文/001.txt": { net: 600, gross: 600 },
    });
    expect(parsed?.baseline?.files).toEqual({
      "本文/001.txt": { net: 100, gross: 120 },
    });
  });

  test("壊れた内訳だけを黙って落とす", () => {
    // 合計が正なので、内訳が読めなくても記録としては成り立つ。
    // 読める分は残す（丸ごと捨てない）
    const parsed = parseDeviceWritingStats({
      schemaVersion: WRITING_STATS_SCHEMA_VERSION,
      deviceId: "desktop-a1b2",
      days: [
        {
          date: "2026-08-13",
          net: 600,
          gross: 600,
          saves: 1,
          files: {
            "本文/001.txt": { net: 600, gross: 600 },
            "本文/002.txt": { net: "たくさん" },
            "本文/003.txt": null,
            "本文/004.txt": [1, 2],
          },
        },
        { date: "2026-08-12", net: 100, gross: 100, saves: 1, files: "こわれた" },
        { date: "2026-08-11", net: 50, gross: 50, saves: 1, files: {} },
      ],
    });

    expect(parsed?.days).toHaveLength(3);
    expect(parsed?.days[2].files).toEqual({
      "本文/001.txt": { net: 600, gross: 600 },
    });
    // 1件も読めなければ、項目そのものを置かない
    expect(parsed?.days[1].files).toBeUndefined();
    expect(parsed?.days[0].files).toBeUndefined();
    // 合計は落とさない
    expect(parsed?.days.map((entry) => entry.net)).toEqual([50, 100, 600]);
  });

  test("知らない項目は捨てずに通す", () => {
    /*
      **先の版が足した項目を、読んで書き戻すだけで消さない。**
      この記録は読んで・足して・丸ごと書き直す作りなので、
      落とすと版を戻した瞬間に情報が消える。
    */
    const parsed = parseDeviceWritingStats({
      schemaVersion: WRITING_STATS_SCHEMA_VERSION,
      deviceId: "desktop-a1b2",
      days: [
        { date: "2026-08-13", net: 600, gross: 600, saves: 1, mood: "上機嫌" },
      ],
    });

    expect(parsed?.days[0]).toMatchObject({ net: 600, mood: "上機嫌" });
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

/**
 * 新しい話を作った直後に、基準を置き直す（設計書6.3.2）。
 *
 * ## 何が起きていたか
 *
 * 記録は「ファイル数が変わった回は数えない」という決まりで動いている
 * （投稿サイトからダウンロードした本文を入れただけで数十万字が増えるため）。
 * ところが「次の話 →」「最新話を書く」「新規話数ファイルを追加」
 * 「新規作品（本文から）」では**拡張機能が自分で空のファイルを作る**。
 * そのあと作者がそこへ書いて保存すると、その回がこの決まりに当たり、
 * **書いた分が「今日 +0字」になって消える**（しかも基準が置き直されるので、
 * 次の保存からは「その話は最初からあった」ことになり、消えた分は戻らない）。
 *
 * 作った直後に基準を置き直しておけば、空のファイルごと基準に入るので、
 * 次の保存は素直に差分として数えられる。
 */
describe("新しい話を作った直後の基準", () => {
  const at = new Date(2026, 7, 29, 10, 0);

  function files(
    entries: Record<string, number>
  ): WritingMeasurement {
    const map: Record<string, { net: number; gross: number }> = {};
    let total = 0;
    for (const [name, net] of Object.entries(entries)) {
      map[name] = { net, gross: net };
      total += net;
    }
    return {
      net: total,
      gross: total,
      fileCount: Object.keys(entries).length,
      conflictedCount: 0,
      files: map,
    };
  }

  test("置き直さないと、そのあと書いた分が数えられない", () => {
    // **これが不具合そのもの。** 空の3話目を作ったまま基準を置き直さず、
    // 作者が800字書いて保存した
    const base = recordMeasurement(
      emptyDeviceStats("d-0001"),
      files({ "本文/001.txt": 1000, "本文/002.txt": 1000 }),
      { at }
    );

    const afterWriting = recordMeasurement(
      base.stats,
      files({ "本文/001.txt": 1000, "本文/002.txt": 1000, "本文/003.txt": 800 }),
      { at }
    );

    // ファイルが増えた回として扱われ、800字は消える
    expect(afterWriting.counted).toBe(false);
    expect(afterWriting.reason).toBe("structure_changed");
    expect(afterWriting.stats.days).toEqual([]);
  });

  test("作った直後に置き直せば、そのあとの800字が差分として付く", () => {
    const base = recordMeasurement(
      emptyDeviceStats("d-0001"),
      files({ "本文/001.txt": 1000, "本文/002.txt": 1000 }),
      { at }
    );

    // **空のファイルを作った直後に置き直す**（拡張機能が作ったところで呼ぶ）
    const rebased = rebaseline(
      base.stats,
      files({ "本文/001.txt": 1000, "本文/002.txt": 1000, "本文/003.txt": 0 }),
      at
    );

    // そこへ作者が800字書いて保存した
    const afterWriting = recordMeasurement(
      rebased,
      files({ "本文/001.txt": 1000, "本文/002.txt": 1000, "本文/003.txt": 800 }),
      { at }
    );

    expect(afterWriting.counted).toBe(true);
    expect(afterWriting.delta).toBe(800);
    expect(afterWriting.stats.days[0].files).toEqual({
      "本文/003.txt": { net: 800, gross: 800 },
    });
  });
});

/**
 * 配線（拡張機能が本文ファイルを作る4か所）。
 *
 * **上の純関数の話は「置き直せば数えられる」までしか言っていない。**
 * 置き直しを実際に呼んでいるかは、作る側のコードにしか無い。
 * どれか1つでも呼び忘れると、その入口から作った話だけが数えられなくなる。
 */
describe("空の話を作ったら基準を置き直す配線", () => {
  test("原稿エディタ（次の話・最新話を書く）", () => {
    const source = readFileSync("src/features/manuscriptEditor.ts", "utf8");
    // 作る場所（`createAndOpen`）で置き直しを呼んでいること
    const createAndOpen = source.slice(source.indexOf("private async createAndOpen"));
    expect(createAndOpen).toContain("this.deps.rebaseline(work)");
  });

  test("新規話数ファイルを追加（extension.ts）", () => {
    const source = readFileSync("src/extension.ts", "utf8");
    const addEpisode = source.slice(source.indexOf('"novelai.addEpisode"'));
    expect(addEpisode.slice(0, 4000)).toContain("progress.rebaseline(work)");
  });

  test("新規作品（本文から）の第1話", () => {
    const source = readFileSync("src/extension.ts", "utf8");
    expect(source).toContain("createFirstEpisodeFile(entry, (work) =>");
  });
});

/**
 * ファイル別の記録の鍵（作者の報告：ブラウザ版で「今日 +0字」から動かない）。
 *
 * 記録する側は走査の `episode.filePath`（日本語は生のまま）、読む側は
 * `paths.fromUri(document.uri)`（非 `file:` では**百分率符号化される**）から
 * 鍵を作っていた。同じファイルなのに鍵が違うので、いつまでも0だった。
 */
describe("ファイル別の記録の鍵", () => {
  const local: WorkEntry = {
    id: "w1",
    title: "いじめられっ子",
    folderPath: "C:/小説/いじめられっ子",
    registeredAt: "2026-08-29T00:00:00.000Z",
  };

  const browser: WorkEntry = {
    ...local,
    folderPath: "vscode-vfs://github/o/r/作品",
  };

  test("手元のファイルの鍵は、これまでと同じ", () => {
    // **変えてはいけない。** 既にある記録と食い違うと、過去の分が読めなくなる
    expect(fileCountKeyFor(local, "C:/小説/いじめられっ子/本文/第1話.md")).toBe(
      "本文/第1話.md"
    );
  });

  test("符号化されたURIでも、走査の道と同じ鍵になる", () => {
    const encoded =
      "vscode-vfs://github/o/r/%E4%BD%9C%E5%93%81/%E6%9C%AC%E6%96%87/%E7%AC%AC1%E8%A9%B1.md";
    const raw = "vscode-vfs://github/o/r/作品/本文/第1話.md";

    expect(fileCountKeyFor(browser, encoded)).toBe("本文/第1話.md");
    expect(fileCountKeyFor(browser, raw)).toBe("本文/第1話.md");
  });

  test("作品フォルダー自体が符号化されていても揃う", () => {
    // 登録の経路によって、`folderPath` は符号化されていることがある
    const encodedWork: WorkEntry = {
      ...local,
      folderPath: "vscode-vfs://github/o/r/%E4%BD%9C%E5%93%81",
    };

    expect(
      fileCountKeyFor(encodedWork, "vscode-vfs://github/o/r/作品/本文/第1話.md")
    ).toBe("本文/第1話.md");
  });
});
