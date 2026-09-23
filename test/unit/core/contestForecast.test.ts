import { describe, expect, test } from "vitest";
import {
  chooseCruisingPace,
  DEFAULT_SLACK_DAYS,
  forecastCompletion,
  MAX_FORECAST_DAYS,
  MIN_WORK_ACTIVE_DAYS,
  paceOver,
  PACE_WINDOW_DAYS,
  selectContestsForForecast,
} from "../../../src/core/contestForecast";
import { storeContests, type StoredContest } from "../../../src/core/contestInbox";
import { parseContestCard } from "../../../src/core/contestListing";
import type { DailyStat } from "../../../src/models/writingStats";

/**
 * 完成予定から公募を選び出す（設計書6.3.6.3）。
 *
 * - 巡航速度＝**直近30日の平均**（書かなかった日も含めて30で割る）
 * - その作品の記録が少なければ（書いた日が5日未満）、全作品の記録で
 * - 完成予定日＝今日＋（予定−今の字数）÷巡航速度
 * - 締切≧完成予定日＋余裕（既定7日）で、締切の近い順。字数が作品に合わないものは外す
 */

const TODAY = "2026-09-23";

function day(date: string, net: number): DailyStat {
  return { date, net, gross: Math.max(0, net), saves: 1 };
}

describe("直近30日の平均（巡航速度）", () => {
  test("窓は今日を含む30日。書かなかった日も含めて30で割る", () => {
    expect(PACE_WINDOW_DAYS).toBe(30);
    const pace = paceOver(
      [
        day("2026-08-24", 9000), // 窓の外（31日前）
        day("2026-08-25", 3000), // 窓の最初の日
        day("2026-09-10", 1500),
        day(TODAY, 1500),
      ],
      TODAY
    );
    expect(pace.from).toBe("2026-08-25");
    expect(pace.to).toBe(TODAY);
    expect(pace.windowChars).toBe(6000);
    expect(pace.perDay).toBe(200);
    expect(pace.activeDays).toBe(3);
  });

  test("消した日（負の日）も差し引く。合計が0以下なら速度は0", () => {
    expect(paceOver([day("2026-09-20", 3000), day("2026-09-21", -3000)], TODAY).perDay).toBe(0);
    expect(paceOver([day("2026-09-21", -500)], TODAY).perDay).toBe(0);
    expect(paceOver([], TODAY).perDay).toBe(0);
  });

  test("書いた日が5日以上あれば、その作品の記録を使う", () => {
    expect(MIN_WORK_ACTIVE_DAYS).toBe(5);
    const work = ["09-01", "09-05", "09-10", "09-15", "09-20"].map((md) => day(`2026-${md}`, 600));
    const all = [...work, day("2026-09-21", 30000)];
    const pace = chooseCruisingPace(work, all, TODAY);
    expect(pace.basis).toBe("work");
    expect(pace.perDay).toBe(100);
  });

  test("その作品の記録が少なければ（書いた日が4日）、全作品の記録を使う", () => {
    const work = ["09-01", "09-05", "09-10", "09-15"].map((md) => day(`2026-${md}`, 600));
    const all = [...work, day("2026-09-21", 3600)];
    const pace = chooseCruisingPace(work, all, TODAY);
    expect(pace.basis).toBe("allWorks");
    expect(pace.perDay).toBe(200);
  });
});

describe("完成予定日", () => {
  test("今日＋（予定−今）÷速度（割り切れなければ切り上げ）", () => {
    const forecast = forecastCompletion({ target: 100000, written: 40000, perDay: 2000, today: TODAY });
    expect(forecast).toEqual({ kind: "dated", date: "2026-10-23", days: 30, remaining: 60000 });
    const rounded = forecastCompletion({ target: 10001, written: 0, perDay: 1000, today: TODAY });
    expect(rounded.kind === "dated" && rounded.days).toBe(11);
  });

  test("もう届いていれば、今日が完成予定（負の残りにしない）", () => {
    expect(forecastCompletion({ target: 5000, written: 8000, perDay: 0, today: TODAY })).toEqual({
      kind: "reached",
      date: TODAY,
      days: 0,
      remaining: 0,
    });
  });

  test("速度が0なら割らない（日付を作らない）", () => {
    expect(forecastCompletion({ target: 5000, written: 1000, perDay: 0, today: TODAY })).toEqual({
      kind: "noPace",
      remaining: 4000,
    });
    expect(forecastCompletion({ target: 5000, written: 1000, perDay: Number.NaN, today: TODAY }).kind).toBe(
      "noPace"
    );
  });

  test("10年を超える見込みは日付にしない", () => {
    const forecast = forecastCompletion({ target: 10_000_000, written: 0, perDay: 1, today: TODAY });
    expect(forecast.kind).toBe("tooSlow");
    expect(MAX_FORECAST_DAYS).toBe(3650);
  });
});

function contest(name: string, text: string): StoredContest {
  const listing = parseContestCard({ name, text, source: "pasted" });
  if (!listing) throw new Error(`読めない見本：${name}`);
  return storeContests([listing], {
    importedAt: "2026-09-23T10:00:00.000+09:00",
    sourcePage: null,
  })[0];
}

describe("完成予定から公募を選ぶ", () => {
  const inbox = [
    contest("早すぎる賞", "締切：2026年10月25日\n字数：制限なし"),
    contest("ちょうどよい賞", "締切：2026年11月5日\n字数：5万字以上12万字以内"),
    contest("遠い賞", "締切：2027年3月31日\n字数：8万字以上"),
    contest("上限の小さい賞", "締切：2026年12月1日\n字数：3万字以内"),
    contest("下限の大きい賞", "締切：2026年12月1日\n字数：15万字以上"),
    contest("字数の読めない賞", "締切：2026年12月10日\n字数：10,000字程度"),
    contest("随時の賞", "締切：随時\n字数：制限なし"),
    contest("終わった賞", "締切：2026年9月1日\n字数：制限なし"),
  ];

  const selected = selectContestsForForecast(inbox, {
    finishDate: "2026-10-23",
    today: TODAY,
    written: 40000,
    target: 100000,
  });

  test("締切が完成予定＋余裕（既定7日）以降のものだけ、締切の近い順に並べる", () => {
    expect(DEFAULT_SLACK_DAYS).toBe(7);
    expect(selected.candidates.map((entry) => entry.contest.name)).toEqual([
      "ちょうどよい賞",
      "遠い賞",
      "字数の読めない賞",
    ]);
    expect(selected.excluded.tooSoon).toBe(1);
  });

  test("「締切まで余裕○日」は完成予定から締切までの日数", () => {
    const fit = selected.candidates[0];
    expect(fit.deadline).toBe("2026-11-05");
    expect(fit.slackDays).toBe(13);
    expect(fit.chars).toBe("fits");
  });

  test("字数が作品に合わないもの（予定が上限を超える・下限に届かない）は外す", () => {
    expect(selected.excluded.charMismatch).toBe(2);
  });

  test("字数を読めなかったものは外さず、読めなかったと印して後ろへ", () => {
    const unknown = selected.candidates.find((entry) => entry.contest.name === "字数の読めない賞");
    expect(unknown?.chars).toBe("unknownChars");
  });

  test("締切を読めないもの・過ぎたものは数えるだけ", () => {
    expect(selected.excluded.noDeadline).toBe(1);
    expect(selected.excluded.past).toBe(1);
  });

  test("いまの字数が上限を超えていれば、予定が収まっていても外す", () => {
    const over = selectContestsForForecast([contest("小さな賞", "締切：2027年1月1日\n字数：3万字以内")], {
      finishDate: "2026-10-01",
      today: TODAY,
      written: 35000,
      target: 20000,
    });
    expect(over.candidates).toEqual([]);
    expect(over.excluded.charMismatch).toBe(1);
  });

  test("余裕の日数は変えられる（0日なら完成予定日ちょうどの締切も入る）", () => {
    const tight = selectContestsForForecast([contest("当日の賞", "締切：2026年10月23日\n字数：制限なし")], {
      finishDate: "2026-10-23",
      today: TODAY,
      written: 0,
      target: 1000,
      slackDays: 0,
    });
    expect(tight.candidates.map((entry) => entry.slackDays)).toEqual([0]);
  });
});
