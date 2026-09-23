import { describe, expect, test } from "vitest";
import {
  isDateKey,
  parseWorkGoals,
  emptyWorkGoals,
  type ContestGoal,
} from "../../src/models/workGoals";
import {
  buildContestProgress,
  daysUntil,
  describeContestProgress,
  targetCharsOf,
} from "../../src/core/contestProgress";
import { buildEpisodeCountTable } from "../../src/core/episodeCharTable";
import type { EpisodeFile } from "../../src/models/types";

/**
 * 作品ごとの目標と、締切への進み具合（設計書6.3.6）。
 *
 * **急かすための機能ではない。**「間に合うのか」「今日どれだけ書けばよいか」に
 * 数字で答えるためのものである。
 */
function contest(overrides: Partial<ContestGoal> = {}): ContestGoal {
  return {
    name: "第40回ファンタジア大賞",
    url: null,
    deadline: "2026-08-31",
    minChars: 100_000,
    maxChars: null,
    dailyGoal: null,
    ...overrides,
  };
}

function goalsWith(c: ContestGoal | null) {
  return { ...emptyWorkGoals(), contest: c };
}

describe("目標の読み取り", () => {
  test("空のJSONは「決めていない」", () => {
    const goals = parseWorkGoals({});

    expect(goals.perEpisodeChars).toBeNull();
    expect(goals.contest).toBeNull();
  });

  test("0は「決めていない」と同じ", () => {
    // 負の目標も、0字の目標も意味を持たない
    expect(parseWorkGoals({ perEpisodeChars: 0 }).perEpisodeChars).toBeNull();
    expect(parseWorkGoals({ perEpisodeChars: -1 }).perEpisodeChars).toBeNull();
  });

  test("壊れた値は勝手に直さず、エラーにする", () => {
    // 直して上書きすると、作者が書いた値が黙って消える
    expect(() => parseWorkGoals({ perEpisodeChars: "3000" })).toThrow();
    expect(() =>
      parseWorkGoals({ contest: { name: "賞", deadline: "8/31" } })
    ).toThrow("YYYY-MM-DD");
    expect(() =>
      parseWorkGoals({ contest: { name: "", deadline: "2026-08-31" } })
    ).toThrow("名前");
  });

  test("下限が上限を超えていたらエラーにする", () => {
    // 逆に入っていると、達成率も残り字数も意味を成さない
    expect(() =>
      parseWorkGoals({
        contest: {
          name: "賞",
          deadline: "2026-08-31",
          minChars: 200_000,
          maxChars: 100_000,
        },
      })
    ).toThrow();
  });

  test("実在しない日付を弾く", () => {
    expect(isDateKey("2026-02-30")).toBe(false);
    expect(isDateKey("2026-13-01")).toBe(false);
    expect(isDateKey("2026-08-31")).toBe(true);
  });
});

describe("締切までの日数", () => {
  test("締切当日は1日として数える", () => {
    // 「残り0日」では今日書けないことになる
    expect(daysUntil("2026-08-16", "2026-08-16")).toBe(1);
  });

  test("過ぎていれば0", () => {
    expect(daysUntil("2026-08-15", "2026-08-16")).toBe(0);
  });

  test("先の日付は当日を含めて数える", () => {
    expect(daysUntil("2026-08-31", "2026-08-16")).toBe(16);
  });
});

describe("進み具合", () => {
  test("必要な日割りは、書いた分を差し引いてから割る", () => {
    // 目標を日数で割るだけだと、書いても数字が減らない
    const progress = buildContestProgress(
      goalsWith(contest({ minChars: 100_000, deadline: "2026-08-26" })),
      40_000,
      "2026-08-16"
    )!;

    expect(progress.remainingChars).toBe(60_000);
    expect(progress.daysLeft).toBe(11);
    expect(progress.neededPerDay).toBe(Math.ceil(60_000 / 11));
  });

  test("作者が決めた日間目標を、割り算で上書きしない", () => {
    // 「平日は書けないので土日で稼ぐ」など、割り算では出ない事情がある
    const progress = buildContestProgress(
      goalsWith(contest({ dailyGoal: 5_000 })),
      0,
      "2026-08-16"
    )!;

    expect(progress.neededPerDay).toBe(5_000);
  });

  test("目標に届いていれば、残りは0で止める", () => {
    // 「あと -3,000字」とは言わない
    const progress = buildContestProgress(
      goalsWith(contest({ minChars: 100_000 })),
      120_000,
      "2026-08-16"
    )!;

    expect(progress.remainingChars).toBe(0);
    expect(describeContestProgress(progress)).toContain("届いています");
  });

  test("上限を超えていたら、削る必要があると言う", () => {
    // 応募規定を外れるので、達成ではない
    const progress = buildContestProgress(
      goalsWith(contest({ minChars: null, maxChars: 8_000 })),
      9_500,
      "2026-08-16"
    )!;

    expect(progress.overMax).toBe(true);
    expect(describeContestProgress(progress)).toContain("削る必要");
  });

  test("締切を過ぎたら、日割りは出さない", () => {
    // 残り全部を出しても、それは1日あたりではない
    const progress = buildContestProgress(
      goalsWith(contest({ deadline: "2026-08-01" })),
      0,
      "2026-08-16"
    )!;

    expect(progress.overdue).toBe(true);
    expect(progress.neededPerDay).toBeNull();
    expect(describeContestProgress(progress)).toContain("過ぎています");
  });

  test("目標にする字数は下限を優先する", () => {
    // 「10万字以上」の応募では、まず届くことが目標になる
    expect(targetCharsOf(contest({ minChars: 100_000, maxChars: 200_000 }))).toBe(
      100_000
    );
    // 上限しか無ければ、そこまで書ける
    expect(targetCharsOf(contest({ minChars: null, maxChars: 8_000 }))).toBe(
      8_000
    );
  });

  test("応募先が無ければ何も返さない", () => {
    expect(buildContestProgress(goalsWith(null), 0, "2026-08-16")).toBeUndefined();
  });
});

describe("1記事あたりの目標", () => {
  function episode(net: number, name: string): EpisodeFile {
    return {
      filePath: `C:/w/${name}`,
      fileName: name,
      kind: "本編",
      chapterStart: 1,
      chapterEnd: 1,
      subtitle: null,
      metaTitle: null,
      isInitialName: true,
      counts: { net, gross: net, manuscriptLines: Math.ceil(net / 20) },
      hasConflictMarkers: false,
      collectedCount: null,
    } as unknown as EpisodeFile;
  }

  const episodes = [
    episode(1_000, "001.txt"),
    episode(1_100, "002.txt"),
    episode(900, "003.txt"),
  ];

  test("目標を決めれば、平均ではなく目標と比べる", () => {
    // 全部が短い作品では、平均と比べても「どれも平均どおり」としか出ない
    const table = buildEpisodeCountTable(episodes, { perEpisodeGoal: 3_000 });

    expect(table.summary.basis).toBe("goal");
    expect(table.summary.basisChars).toBe(3_000);
    // 3,000字が狙いなら、1,000字は「短い」
    expect(table.rows.every((row) => row.flag === "short")).toBe(true);
  });

  test("目標を決めていなければ、これまでどおり平均と比べる", () => {
    const table = buildEpisodeCountTable(episodes);

    expect(table.summary.basis).toBe("average");
    expect(table.summary.basisChars).toBe(1_000);
  });

  test("目標があれば、話数が少なくても印を付ける", () => {
    // 平均は少数だと当てにならないが、目標は1話目から決まっている
    const table = buildEpisodeCountTable([episode(500, "001.txt")], {
      perEpisodeGoal: 3_000,
    });

    expect(table.rows[0].flag).toBe("short");
  });

  test("目標が無く話数も少なければ、印を付けない", () => {
    // 2話しかない作品では、片方が必ず「平均より上」になる
    const table = buildEpisodeCountTable([
      episode(500, "001.txt"),
      episode(5_000, "002.txt"),
    ]);

    expect(table.rows.every((row) => row.flag === null)).toBe(true);
  });
});
