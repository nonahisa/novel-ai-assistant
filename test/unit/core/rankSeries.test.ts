import { describe, expect, test } from "vitest";
import { buildRankChart, buildRankSeries } from "../../../src/core/rankSeries";
import { buildPostingSiteRecords } from "../../../src/core/postingSiteRecords";
import { emptyPostingLedger, type PostingLedger, type PostingRankingRecord } from "../../../src/models/posting";

/** 順位の推移の線（作者の指示 2026-11-02「順位もグラフに」「他のサイトでも同様です」） */

function ledgerWith(rankings: PostingRankingRecord[], extra: Partial<PostingLedger> = {}): PostingLedger {
  return { ...emptyPostingLedger(), rankings, ...extra };
}

const api = (day: string, board: string, rank: number): PostingRankingRecord => ({
  site: "narou",
  recordedAt: `${day}T00:00:00+09:00`,
  board,
  rank,
  source: "narou-api",
});

describe("種別ごとの線", () => {
  test("手の記録と API の順位は、同じ種別なら1本、違えば別の線", () => {
    const series = buildRankSeries(
      ledgerWith([
        { site: "narou", recordedAt: "2026-10-18T12:00:00+09:00", board: "日間", rank: 80 },
        api("2026-10-19", "日間", 50),
        api("2026-10-20", "週間", 120),
        { site: "kakuyomu", recordedAt: "2026-10-19T12:00:00+09:00", board: "日間", rank: 3 },
      ]),
      "narou"
    );
    expect(series.map((line) => line.label)).toEqual(["日間", "週間"]);
    expect(series[0].points).toEqual([
      { day: "2026-10-18", rank: 80 },
      { day: "2026-10-19", rank: 50 },
    ]);
  });

  test("ヘルパーの順位（小さいほど良い欄）も線になる。ほかの順位があるのに無い日は圏外", () => {
    const series = buildRankSeries(
      {
        ...emptyPostingLedger(),
        readerStats: [
          { site: "alphapolis", readAt: "2026-10-20T10:00:00+09:00", scope: "work", metrics: { alphapolis_rankTotal: 900, alphapolis_rank24h: 40 }, source: "helper" },
          { site: "alphapolis", readAt: "2026-10-21T10:00:00+09:00", scope: "work", metrics: { alphapolis_rankTotal: 880 }, source: "helper" },
          { site: "alphapolis", readAt: "2026-10-22T10:00:00+09:00", scope: "work", metrics: { alphapolis_rankTotal: 870, alphapolis_rank24h: 30 }, source: "helper" },
          // 順位の欄が無い行は、順位を読んだ画面ではない（圏外の印にしない）
          { site: "alphapolis", readAt: "2026-10-23T10:00:00+09:00", scope: "work", metrics: { points: 10 }, source: "helper" },
        ],
      },
      "alphapolis"
    );
    expect(series.map((line) => line.label)).toEqual(["累計ランキング", "24時間ランキング"]);
    expect(series[1].points).toEqual([
      { day: "2026-10-20", rank: 40 },
      { day: "2026-10-21", rank: null },
      { day: "2026-10-22", rank: 30 },
    ]);
  });
});

describe("圏外は線を切る（0 や大きな数で埋めない）", () => {
  test("API の日間は1日より空いた所、週間は7日より空いた所で切れる", () => {
    const series = buildRankSeries(
      ledgerWith([
        api("2026-10-01", "日間", 100),
        api("2026-10-02", "日間", 90),
        api("2026-10-05", "日間", 70),
        api("2026-10-06", "週間", 200),
        api("2026-10-13", "週間", 180),
        api("2026-10-27", "週間", 150),
      ]),
      "narou"
    );
    expect(series[0].points).toEqual([
      { day: "2026-10-01", rank: 100 },
      { day: "2026-10-02", rank: 90 },
      { day: "2026-10-03", rank: null },
      { day: "2026-10-05", rank: 70 },
    ]);
    expect(series[1].points.map((point) => point.rank)).toEqual([200, 180, null, 150]);
    // 圏外を数で埋めていない
    expect(series.flatMap((line) => line.points).some((point) => point.rank === 0)).toBe(false);
  });

  test("手の記録は書いていない日を圏外と言えないので、そのまま結ぶ", () => {
    const series = buildRankSeries(
      ledgerWith([
        { site: "kakuyomu", recordedAt: "2026-10-01T12:00:00+09:00", board: "週間", rank: 30 },
        { site: "kakuyomu", recordedAt: "2026-10-20T12:00:00+09:00", board: "週間", rank: 20 },
      ]),
      "kakuyomu"
    );
    expect(series[0].points.map((point) => point.rank)).toEqual([30, 20]);
  });

  test("同じ日は台帳であとに足した方", () => {
    const series = buildRankSeries(
      ledgerWith([
        { site: "kakuyomu", recordedAt: "2026-10-01T09:00:00+09:00", board: "日間", rank: 30 },
        { site: "kakuyomu", recordedAt: "2026-10-01T09:00:00+09:00", board: "日間", rank: 25 },
      ]),
      "kakuyomu"
    );
    expect(series[0].points).toEqual([{ day: "2026-10-01", rank: 25 }]);
  });
});

describe("グラフの材料", () => {
  test("縦軸の端は best（いちばん良い順位）と worst。画面は best を上に描く", () => {
    const chart = buildRankChart(ledgerWith([api("2026-10-01", "日間", 100), api("2026-10-02", "日間", 3)]), "narou");
    expect(chart).toMatchObject({ best: 3, worst: 100, firstDay: "2026-10-01", lastDay: "2026-10-02" });
  });

  test("順位が1つも無いサイトは null（画面は案内の1行）", () => {
    expect(buildRankChart(emptyPostingLedger(), "kakuyomu")).toBeNull();
  });

  test("サイトの記録に順位のグラフと、API の数があるときだけ出典が載る", () => {
    const records = buildPostingSiteRecords(
      ledgerWith([
        api("2026-10-01", "日間", 100),
        { site: "kakuyomu", recordedAt: "2026-10-01T12:00:00+09:00", board: "日間", rank: 5 },
      ])
    );
    const narou = records.find((record) => record.site === "narou");
    const kakuyomu = records.find((record) => record.site === "kakuyomu");
    expect(narou?.rankChart?.series).toHaveLength(1);
    expect(narou?.apiAttribution).toBe("出典：なろうデベロッパー（なろう小説API・なろう殿堂入りAPI）");
    expect(kakuyomu?.rankChart?.series).toHaveLength(1);
    expect(kakuyomu?.apiAttribution).toBeNull();
  });
});
