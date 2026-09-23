import { describe, expect, test } from "vitest";
import {
  readPostingLedger,
  readerStatsMetricsFor,
  SITE_READER_STATS_METRICS,
  withReaderStats,
  type PostingLedger,
} from "../../src/models/posting";

/**
 * 台帳の読みを寛容にする（作者の裁定、2026-09-19）。
 *
 * `設定/投稿状態.json` はGitで同期する。**書いた版より古い版が読むことが
 * ある**ので、知らないもの（出どころ・サイト・指標）が書いてあっても、
 * **その行だけを飛ばして、台帳ぜんぶは読める**ようにする。
 *
 * これは**古い版を直すものではない**（0.67.1 は直せない）。0.69.9 以降が
 * 同じ目に遭わないようにするものである。
 */

/** 最低限の中身が入った台帳（読者の反応の行だけを差し替えて使う） */
function ledgerWith(rows: unknown[]): unknown {
  return {
    schemaVersion: "1",
    sites: [],
    siteProfiles: [{ site: "narou", genre: "ホラー" }],
    posts: [],
    rankings: [],
    readerStats: rows,
  };
}

const GOOD_ROW = {
  site: "narou",
  readAt: "2026-09-19T10:00:00.000Z",
  scope: "work",
  metrics: { pv: 1234 },
  source: "manual",
};

describe("知らないものが書いてあっても、台帳ごと死なせない", () => {
  test("知らない出どころ（source）の行は、その行だけ飛ばして読む", () => {
    const read = readPostingLedger(
      ledgerWith([
        GOOD_ROW,
        { ...GOOD_ROW, source: "未来の版の出どころ", metrics: { pv: 99 } },
      ])
    );

    expect(read.ledger.readerStats).toHaveLength(1);
    expect(read.ledger.readerStats[0].metrics.pv).toBe(1234);
    // **飛ばした行は生のまま控える**（書き戻しで消さないため）
    expect(read.skippedReaderStats).toBe(1);
    expect(read.skippedReaderStatsRows).toHaveLength(1);
  });

  test("知らないサイトの行も、その行だけ飛ばして読む", () => {
    const read = readPostingLedger(
      ledgerWith([{ ...GOOD_ROW, site: "未来の投稿サイト" }, GOOD_ROW])
    );

    expect(read.ledger.readerStats).toHaveLength(1);
    expect(read.skippedReaderStatsRows).toHaveLength(1);
  });

  test("1行が壊れていても、ほかの行は読める", () => {
    const read = readPostingLedger(
      ledgerWith([
        { site: "narou", readAt: "", scope: "work", metrics: {}, source: "manual" },
        GOOD_ROW,
        { site: "narou", scope: "episode", episode: 0, metrics: { pv: 1 }, source: "manual" },
      ])
    );

    expect(read.ledger.readerStats).toHaveLength(1);
    expect(read.skippedReaderStatsRows).toHaveLength(2);
  });

  test("台帳そのものが壊れていれば、これまでどおり止める", () => {
    // 行ごとの寛容さは**行の中身まで**である。入れ物の形が違うのは別の話で、
    // ここまで黙って通すと「読めた」と「読めなかった」の区別が消える
    expect(() =>
      readPostingLedger({ schemaVersion: "1", readerStats: "壊れています" })
    ).toThrow();
  });
});

describe("サイトごとの指標（なろうの評価者数・評価ポイント・評価平均）", () => {
  test("表はサイトごとに引ける", () => {
    const narou = SITE_READER_STATS_METRICS.narou.map((info) => info.label);
    // 週間読者は Narou.fun から入る（残課題 B11、2026-09-23）
    expect(narou).toEqual(["評価者数", "評価ポイント", "評価平均", "週間読者"]);
    // 共通の7つは、どのサイトでも先に並ぶ（サイトをまたいで比べる軸）
    const forNarou = readerStatsMetricsFor("narou").map((info) => info.key);
    expect(forNarou.slice(0, 7)).toEqual([
      "pv",
      "unique",
      "bookmarks",
      "points",
      "likes",
      "comments",
      "reviews",
    ]);
    expect(forNarou).toHaveLength(11);
  });

  test("小数の指標（評価平均）を台帳へ入れられる", () => {
    const empty: PostingLedger = {
      schemaVersion: "1",
      sites: [],
      siteProfiles: [],
      posts: [],
      rankings: [],
      readerStats: [],
    };
    const next = withReaderStats(empty, {
      site: "narou",
      readAt: "2026-09-19T10:00:00.000Z",
      scope: "work",
      metrics: { points: 2, narou_raters: 3, narou_ratingAverage: 4.5 },
      source: "backup",
    });

    expect(next.readerStats[0].metrics).toEqual({
      points: 2,
      narou_raters: 3,
      narou_ratingAverage: 4.5,
    });
  });

  test("小数を受けるのは、小数の指標だけ（PVは整数のまま）", () => {
    const read = readPostingLedger(
      ledgerWith([{ ...GOOD_ROW, metrics: { pv: 12.5 } }])
    );
    // 直さずに飛ばす（0で埋めたり切り捨てたりしない）
    expect(read.ledger.readerStats).toHaveLength(0);
    expect(read.skippedReaderStatsRows).toHaveLength(1);
  });

  test("サイト固有の指標は、読み書きで往復する", () => {
    const read = readPostingLedger(
      ledgerWith([
        {
          ...GOOD_ROW,
          metrics: {
            points: 2,
            narou_raters: 0,
            narou_ratingPoints: 0,
            narou_ratingAverage: 0,
          },
        },
      ])
    );
    expect(read.ledger.readerStats[0].metrics).toEqual({
      points: 2,
      narou_raters: 0,
      narou_ratingPoints: 0,
      narou_ratingAverage: 0,
    });
    expect(read.skippedReaderStatsRows).toHaveLength(0);
  });
});
