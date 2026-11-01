import { describe, expect, test } from "vitest";
import { buildPostingSiteRecords } from "../../../src/core/postingSiteRecords";
import { buildReaderAdviceMaterials } from "../../../src/core/readerAdvice";
import {
  emptyPostingLedger,
  withSites,
  type PostingLedger,
  type ReaderStatsRecord,
} from "../../../src/models/posting";

/**
 * 執筆統計の「読者の反応」で、なろうファンDBの同じ日の読み取りが1日1つになる
 * （作者の判断 2026-11-01）。台帳に重なって入っている古い記録も、読むときに畳む。
 */

function at(day: number, hour: number): string {
  return new Date(2026, 10, day, hour, 0).toISOString();
}

function narouRead(readAt: string, bookmarks: number, dayValue: number): ReaderStatsRecord[] {
  return [
    { site: "narou", readAt, scope: "work", metrics: { bookmarks }, source: "helper" },
    {
      site: "narou",
      readAt,
      scope: "work",
      period: "day",
      periodKey: "2026-10-31",
      metrics: { bookmarks: dayValue },
      source: "helper",
    },
  ];
}

function ledger(records: ReaderStatsRecord[]): PostingLedger {
  return {
    ...withSites(emptyPostingLedger(), [
      {
        site: "narou",
        newEpisodeUrl: "https://syosetu.com/usernovelmanage/isnoveluploadmenu/ncode/n1234ab/",
      },
    ]),
    readerStats: records,
  };
}

describe("なろうファンDBの同じ日の読み取り", () => {
  const sameDay = ledger([...narouRead(at(1, 0), 10, 1), ...narouRead(at(1, 18), 12, 3)]);

  test("履歴の表は1日1行（あとの読み取り）", () => {
    const narou = buildPostingSiteRecords(sameDay).find((record) => record.site === "narou");
    const rows = narou?.readerWork?.rows ?? [];
    expect(rows).toHaveLength(1);
    expect(rows[0].readAt).toBe(at(1, 18));
    expect(rows[0].snapshot).toContain("12");
  });

  test("日ごとの増減のグラフは1日1点で、あとの読み取りの数", () => {
    const narou = buildPostingSiteRecords(sameDay).find((record) => record.site === "narou");
    const chart = narou?.readerCharts.changes.find(
      (entry) => entry.metric === "bookmarks" && entry.period === "day"
    );
    expect(chart?.points).toEqual([expect.objectContaining({ key: "2026-10-31", value: 3 })]);
  });

  test("違う日の読み取りは、今までどおり別の行", () => {
    const twoDays = ledger([...narouRead(at(1, 0), 10, 1), ...narouRead(at(2, 0), 12, 3)]);
    const narou = buildPostingSiteRecords(twoDays).find((record) => record.site === "narou");
    expect(narou?.readerWork?.rows).toHaveLength(2);
  });

  test("台帳は書き換えない（4件のまま）", () => {
    buildPostingSiteRecords(sameDay);
    buildReaderAdviceMaterials(sameDay);
    expect(sameDay.readerStats).toHaveLength(4);
  });
});
