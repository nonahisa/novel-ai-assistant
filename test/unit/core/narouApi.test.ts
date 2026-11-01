import { describe, expect, test } from "vitest";
import {
  NAROU_API_ATTRIBUTION,
  NarouApiError,
  applyNarouApiResult,
  describeNarouApiFailure,
  narouNovelApiUrl,
  narouRankinApiUrl,
  parseNarouNovelApi,
  parseNarouRankinApi,
} from "../../../src/core/narouApi";
import {
  emptyPostingLedger,
  readPostingLedger,
  readerStatsForSite,
  type PostingLedger,
} from "../../../src/models/posting";

/**
 * なろう小説API・なろう殿堂入りAPI（作者の指示 2026-11-02）。**本物の API は呼ばない**——
 * 返事の形は公式の仕様（https://dev.syosetu.com/man/api/ ・ /man/rankinapi/）どおりに組む。
 */

const NOVEL_OK = JSON.stringify([
  { allcount: 1 },
  {
    ncode: "N1234AB",
    global_point: 4808,
    fav_novel_cnt: 1111,
    all_point: 2586,
    all_hyoka_cnt: 300,
    review_cnt: 2,
    impression_cnt: 15,
    general_all_no: 19,
    general_lastup: "2026-10-30 18:00:00",
    end: 1,
    noveltype: 1,
    keyword: "異世界 ファンタジー　恋愛",
  },
]);

function narouLedger(): PostingLedger {
  return {
    ...emptyPostingLedger(),
    sites: [{ site: "narou", newEpisodeUrl: "https://syosetu.com/usernovelmanage/top/ncode/123/" }],
    siteProfiles: [{ site: "narou", workId: "n1234ab" }],
  };
}

describe("呼ぶ URL", () => {
  test("作品の数は out=json・ncode=その1作品・of=要る欄だけ", () => {
    const url = new URL(narouNovelApiUrl("N1234AB"));
    expect(url.origin + url.pathname).toBe("https://api.syosetu.com/novelapi/api/");
    expect(url.searchParams.get("out")).toBe("json");
    expect(url.searchParams.get("ncode")).toBe("n1234ab");
    expect(url.searchParams.get("of")).toBe("n-gp-f-a-ah-r-imp-ga-gl-e-nt-k");
    // 他人の作品を集める指定（検索語・並び順・件数）を付けない
    expect([...url.searchParams.keys()].sort()).toEqual(["ncode", "of", "out"]);
  });

  test("順位は殿堂入りAPIへ Nコード1つだけ（ランキングAPIは使わない）", () => {
    const url = new URL(narouRankinApiUrl("n1234ab"));
    expect(url.origin + url.pathname).toBe("https://api.syosetu.com/rank/rankin/");
    expect([...url.searchParams.keys()].sort()).toEqual(["ncode", "out"]);
    expect(url.toString()).not.toContain("rankget");
  });
});

describe("作品の数を読む", () => {
  test("欄を台帳の指標へ当てはめる（ヘルパーの Narou.fun の当てはめと同じ）", () => {
    const info = parseNarouNovelApi(NOVEL_OK, "n1234ab");
    expect(info.metrics).toEqual({
      points: 4808,
      bookmarks: 1111,
      narou_ratingPoints: 2586,
      narou_raters: 300,
      reviews: 2,
      comments: 15,
    });
    // 評価平均は API に無いので作らない
    expect(info.metrics.narou_ratingAverage).toBeUndefined();
    expect(info.episodes).toBe(19);
    expect(info.lastPostedAt).toBe("2026-10-30 18:00:00");
    expect(info.tags).toEqual(["異世界", "ファンタジー", "恋愛"]);
    expect(info.completion).toBe("ongoing");
  });

  test("完結の連載は完結、短編は決めない", () => {
    const done = JSON.parse(NOVEL_OK);
    done[1].end = 0;
    expect(parseNarouNovelApi(JSON.stringify(done), "n1234ab").completion).toBe("completed");
    done[1].noveltype = 2;
    expect(parseNarouNovelApi(JSON.stringify(done), "n1234ab").completion).toBeUndefined();
  });

  test("該当作品が無い（allcount 0）は not_found", () => {
    expect(() => parseNarouNovelApi(JSON.stringify([{ allcount: 0 }]), "n1234ab")).toThrow(
      expect.objectContaining({ kind: "not_found" })
    );
  });

  test("JSON でない・形が違う・別の作品が返ったは shape（本文を持つ）", () => {
    const cases = [
      "<html>error</html>",
      JSON.stringify({ allcount: 1 }),
      JSON.stringify([{ allcount: 1 }, { ncode: "N9999ZZ", global_point: 1 }]),
      JSON.stringify([{ allcount: 1 }, { ncode: "N1234AB", global_point: "4,808" }]),
      JSON.stringify([{ allcount: 1 }, { ncode: "N1234AB" }]),
    ];
    for (const text of cases) {
      let caught: unknown;
      try {
        parseNarouNovelApi(text, "n1234ab");
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(NarouApiError);
      expect((caught as NarouApiError).kind).toBe("shape");
      expect((caught as NarouApiError).body).toBe(text);
    }
  });
});

describe("殿堂入りの順位を読む", () => {
  test("rtype の日付と種別を、順位の記録の種別と日本時間の日付へ", () => {
    const entries = parseNarouRankinApi(
      JSON.stringify([
        { rtype: "20261020-d", pt: 120, rank: 45 },
        { rtype: "20261020-w", pt: 300, rank: 120 },
        { rtype: "20261001-m", pt: 900, rank: 200 },
        { rtype: "20261001-q", pt: 900, rank: 280 },
      ])
    );
    expect(entries).toEqual([
      { board: "日間", recordedAt: "2026-10-20T00:00:00+09:00", rank: 45, points: 120 },
      { board: "週間", recordedAt: "2026-10-20T00:00:00+09:00", rank: 120, points: 300 },
      { board: "月間", recordedAt: "2026-10-01T00:00:00+09:00", rank: 200, points: 900 },
      { board: "四半期", recordedAt: "2026-10-01T00:00:00+09:00", rank: 280, points: 900 },
    ]);
  });

  test("空の配列はランキングに入ったことが無いだけ（失敗ではない）", () => {
    expect(parseNarouRankinApi("[]")).toEqual([]);
  });

  test("「Error: Novel not found.」は not_found、形の違う行が1つでもあれば shape", () => {
    expect(() => parseNarouRankinApi("Error: Novel not found.")).toThrow(
      expect.objectContaining({ kind: "not_found" })
    );
    expect(() =>
      parseNarouRankinApi(JSON.stringify([{ rtype: "20261020-d", rank: 3 }, { rtype: "2026-10-20", rank: 1 }]))
    ).toThrow(expect.objectContaining({ kind: "shape" }));
    expect(() => parseNarouRankinApi(JSON.stringify([{ rtype: "20261020-d", rank: 0 }]))).toThrow(
      expect.objectContaining({ kind: "shape" })
    );
  });
});

describe("失敗の文（種類ごとに1文と次の一手）", () => {
  test("4つの種類で言うことが違い、どれも次の一手を1つ示す", () => {
    const api = "なろう小説API";
    const network = describeNarouApiFailure("network", api, { ncode: "n1234ab" });
    const http = describeNarouApiFailure("http", api, { ncode: "n1234ab", status: 503 });
    const notFound = describeNarouApiFailure("not_found", api, { ncode: "n1234ab" });
    const shape = describeNarouApiFailure("shape", api, { ncode: "n1234ab" });
    expect(network).toContain("つながりませんでした");
    expect(network).toContain("インターネット");
    expect(http).toContain("HTTP 503");
    expect(http).toContain("時間をおいて");
    expect(notFound).toContain("n1234ab");
    expect(notFound).toContain("削除・非公開");
    expect(notFound).toContain("投稿サイト設定");
    expect(shape).toContain("形と違いました");
    expect(shape).toContain("最新の版");
    expect(new Set([network, http, notFound, shape]).size).toBe(4);
  });
});

describe("台帳へ書く", () => {
  const novel = parseNarouNovelApi(NOVEL_OK, "n1234ab");
  const ranks = parseNarouRankinApi(JSON.stringify([{ rtype: "20261020-d", pt: 120, rank: 45 }]));

  test("数は読者の反応の形で、出どころの印 narou-api を付ける", () => {
    const applied = applyNarouApiResult(narouLedger(), {
      readAt: "2026-11-02T03:00:00.000Z",
      novel,
      ranks,
    });
    expect(applied.statsAdded).toBe(true);
    const row = applied.ledger.readerStats[0];
    expect(row).toMatchObject({
      site: "narou",
      scope: "work",
      source: "narou-api",
      metrics: novel.metrics,
    });
    expect(row.period).toBeUndefined();
    expect(row.note).toContain("総話数19");
    expect(applied.ledger.rankings).toEqual([
      {
        site: "narou",
        recordedAt: "2026-10-20T00:00:00+09:00",
        board: "日間",
        rank: 45,
        note: "なろう殿堂入りAPIから取得（120pt）",
        source: "narou-api",
      },
    ]);
    // タグと連載の状態はヘルパーと同じ道で写る
    expect(applied.ledger.siteFacts?.[0]).toMatchObject({
      site: "narou",
      tags: ["異世界", "ファンタジー", "恋愛"],
      completion: "ongoing",
    });
  });

  test("同じ日に何度取っても積み重ねない（同じ数・同じ順位）", () => {
    const first = applyNarouApiResult(narouLedger(), {
      readAt: "2026-11-02T03:00:00.000Z",
      novel,
      ranks,
    });
    const second = applyNarouApiResult(first.ledger, {
      readAt: "2026-11-02T05:00:00.000Z",
      novel,
      ranks,
    });
    expect(second.statsAdded).toBe(false);
    expect(second.ranksAdded).toBe(0);
    expect(second.ranksRepeated).toBe(1);
    expect(second.ledger.readerStats).toHaveLength(1);
    expect(second.ledger.rankings).toHaveLength(1);
  });

  test("同じ日に数が違えば積むが、見るときは同じ日のあとの方だけ（Narou.fun の数とは畳まない）", () => {
    const first = applyNarouApiResult(narouLedger(), { readAt: "2026-11-02T03:00:00.000Z", novel, ranks: [] });
    const later = { ...novel, metrics: { ...novel.metrics, points: 4900 } };
    const second = applyNarouApiResult(
      {
        ...first.ledger,
        readerStats: [
          ...first.ledger.readerStats,
          {
            site: "narou",
            readAt: "2026-11-02T00:00:00+09:00",
            scope: "work",
            metrics: { points: 4700 },
            source: "helper",
          },
        ],
      },
      { readAt: "2026-11-02T06:00:00.000Z", novel: later, ranks: [] }
    );
    expect(second.statsAdded).toBe(true);
    const shown = readerStatsForSite(second.ledger, "narou");
    expect(shown.filter((row) => row.source === "narou-api").map((row) => row.metrics.points)).toEqual([4900]);
    expect(shown.filter((row) => row.source === "helper")).toHaveLength(1);
  });

  test("台帳を読み直しても出どころの印は消えない（順位も反応も）", () => {
    const applied = applyNarouApiResult(narouLedger(), {
      readAt: "2026-11-02T03:00:00.000Z",
      novel,
      ranks,
    });
    const reread = readPostingLedger(JSON.parse(JSON.stringify(applied.ledger)));
    expect(reread.skippedReaderStats).toBe(0);
    expect(reread.ledger.readerStats[0].source).toBe("narou-api");
    expect(reread.ledger.rankings[0].source).toBe("narou-api");
  });

  test("出典の書き方", () => {
    expect(NAROU_API_ATTRIBUTION).toBe("出典：なろうデベロッパー（なろう小説API・なろう殿堂入りAPI）");
  });
});
