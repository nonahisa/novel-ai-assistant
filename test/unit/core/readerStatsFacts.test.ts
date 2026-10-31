import { describe, expect, test } from "vitest";
import {
  applyReaderStatsEnvelope,
  buildReaderStatsEnvelope,
  parseReaderStatsEnvelope,
  parseReaderStatsPaste,
  READER_STATS_BUNDLE_KIND,
  type ReaderStatsEnvelope,
} from "../../../src/core/readerStatsEnvelope";
import {
  readerStatsAlreadyImported,
  readerStatsBundleNotice,
} from "../../../src/core/readerStatsHelperLink";
import { buildReaderCharts } from "../../../src/core/readerStatsCharts";
import {
  emptyPostingLedger,
  readerStatsMetricInfo,
  readPostingLedger,
  SITE_READER_STATS_METRICS,
  siteFactsFor,
  withSites,
  type PostingLedger,
} from "../../../src/models/posting";

/**
 * 読者の反応の封筒に足された、省いてよい3つの欄（ヘルパー 0.16.0・0.17.0。作者の指示 2026-11-01）。
 *
 * - `tags`：サイトの画面のタグの並び。`[]` は「タグを全部外した」、欄なしは「分からない」
 * - `completion`：連載中（ongoing）／完結（completed）
 * - `ownedVia`：その作品を覚えた理由（owner-page／approved）。いまは受け取って残すだけ
 *
 * どれも**封筒（束の1件）の欄**で、形が違えば**その欄だけ捨てて行は通す**
 * （欄のせいで数の正しい封筒を丸ごと落とさない）。
 *
 * あわせて、アルファポリスの指標（0.17.0）が表に載り、台帳へ入ることも確かめる。
 */

const KAKUYOMU_POST = "https://kakuyomu.jp/my/works/1111/episodes/new";
const ALPHAPOLIS_POST = "https://www.alphapolis.co.jp/mypage/novel/save_episode/123456789";

function registered(): PostingLedger {
  return withSites(emptyPostingLedger(), [
    { site: "kakuyomu", newEpisodeUrl: KAKUYOMU_POST },
    { site: "alphapolis", newEpisodeUrl: ALPHAPOLIS_POST },
  ]);
}

function envelopeOf(raw: Record<string, unknown>): ReaderStatsEnvelope {
  const parsed = parseReaderStatsEnvelope(JSON.stringify(raw));
  if (!parsed.ok) throw new Error(parsed.reason);
  return parsed.envelope;
}

function kakuyomuRaw(extra: Record<string, unknown>, readAt = "2026-11-01T01:00:00.000Z") {
  return {
    "novelai-stats": 1,
    site: "kakuyomu",
    workId: "1111",
    readAt,
    entries: [{ scope: "work", metrics: { pv: 100 } }],
    ...extra,
  };
}

describe("封筒の3つの欄を受け取る", () => {
  test("tags・completion・ownedVia の付いた封筒が受け取られる", () => {
    const envelope = envelopeOf(
      kakuyomuRaw({ tags: ["異世界", "群像劇"], completion: "ongoing", ownedVia: "owner-page" })
    );
    expect(envelope.tags).toEqual(["異世界", "群像劇"]);
    expect(envelope.completion).toBe("ongoing");
    expect(envelope.ownedVia).toBe("owner-page");
  });

  test("tags が [] なら「タグが0個」として受ける（欄なしと区別する）", () => {
    expect(envelopeOf(kakuyomuRaw({ tags: [] })).tags).toEqual([]);
    expect(envelopeOf(kakuyomuRaw({})).tags).toBeUndefined();
    expect(envelopeOf(kakuyomuRaw({ tags: null })).tags).toBeUndefined();
  });

  test("形の違う欄は、その欄だけ捨てて行は通す", () => {
    const envelope = envelopeOf(
      kakuyomuRaw({
        tags: ["異世界", 3],
        completion: "hiatus",
        ownedVia: "stolen",
      })
    );
    expect(envelope.tags).toBeUndefined();
    expect(envelope.completion).toBeUndefined();
    expect(envelope.ownedVia).toBeUndefined();
    // 数は受け取れている
    expect(envelope.entries).toEqual([{ scope: "work", metrics: { pv: 100 } }]);
  });

  test("タグの約束（1つ60字・50個まで）を外れたら欄ごと捨てる", () => {
    expect(envelopeOf(kakuyomuRaw({ tags: ["あ".repeat(61)] })).tags).toBeUndefined();
    const many = Array.from({ length: 51 }, (_, index) => `タグ${index}`);
    expect(envelopeOf(kakuyomuRaw({ tags: many })).tags).toBeUndefined();
    expect(envelopeOf(kakuyomuRaw({ tags: "異世界" })).tags).toBeUndefined();
  });

  test("前後の空白・空・重複は落として受ける（ヘルパーと同じ整え方）", () => {
    expect(envelopeOf(kakuyomuRaw({ tags: [" 異世界 ", "", "異世界", "群像劇"] })).tags).toEqual([
      "異世界",
      "群像劇",
    ]);
  });

  test("新しい欄の無い古い封筒は、これまでどおり受け取れる", () => {
    const envelope = envelopeOf(kakuyomuRaw({}));
    expect(envelope).toEqual({
      "novelai-stats": 1,
      site: "kakuyomu",
      workId: "1111",
      readAt: "2026-11-01T01:00:00.000Z",
      entries: [{ scope: "work", metrics: { pv: 100 } }],
    });
  });

  test("組み立て（buildReaderStatsEnvelope）と読み取りが往復する", () => {
    const text = buildReaderStatsEnvelope({
      site: "kakuyomu",
      workId: "1111",
      readAt: "2026-11-01T01:00:00.000Z",
      tags: ["異世界"],
      completion: "completed",
      ownedVia: "approved",
      entries: [{ scope: "work", metrics: { pv: 1 } }],
    });
    const parsed = parseReaderStatsEnvelope(text);
    expect(parsed.ok && parsed.envelope.tags).toEqual(["異世界"]);
    expect(parsed.ok && parsed.envelope.completion).toBe("completed");
    expect(parsed.ok && parsed.envelope.ownedVia).toBe("approved");
  });

  test("束の1件にも同じ関所が効く", () => {
    const pasted = parseReaderStatsPaste(
      JSON.stringify({
        kind: READER_STATS_BUNDLE_KIND,
        version: 1,
        items: [kakuyomuRaw({ tags: ["異世界"], completion: "ongoing", ownedVia: "owner-page" })],
      })
    );
    expect(pasted.ok && pasted.kind).toBe("bundle");
    if (!pasted.ok || pasted.kind !== "bundle") return;
    const item = pasted.bundle.items[0].result;
    expect(item.ok && item.envelope.tags).toEqual(["異世界"]);
    expect(item.ok && item.envelope.ownedVia).toBe("owner-page");
  });
});

describe("アルファポリスの指標", () => {
  test("表に7つの固有の欄が載り、名前はサイトIDで始まる", () => {
    const keys = SITE_READER_STATS_METRICS.alphapolis.map((info) => info.key);
    expect(keys).toEqual([
      "alphapolis_points24h",
      "alphapolis_rankTotal",
      "alphapolis_rank24h",
      "alphapolis_hearts",
      "alphapolis_bookmarks",
      "alphapolis_yells",
      "alphapolis_typoReports",
    ]);
  });

  test("順位は「小さいほど良い」印を持ち、増減のグラフの欄（dailyChange）にはならない", () => {
    for (const key of ["alphapolis_rankTotal", "alphapolis_rank24h"]) {
      const info = readerStatsMetricInfo(key);
      expect(info?.lowerIsBetter, key).toBe(true);
      expect(info?.dailyChange, key).toBeUndefined();
      expect(info?.unit, key).toBe("位");
    }
    expect(readerStatsMetricInfo("alphapolis_points24h")?.lowerIsBetter).toBeUndefined();
  });

  test("アルファポリスの指標つきの封筒が受け取られ、台帳へ入る", () => {
    const envelope = envelopeOf({
      "novelai-stats": 1,
      site: "alphapolis",
      workId: "123456789",
      readAt: "2026-11-01T02:00:00.000Z",
      tags: ["ファンタジー"],
      completion: "completed",
      entries: [
        {
          scope: "work",
          metrics: {
            points: 12000,
            bookmarks: 40,
            alphapolis_points24h: 300,
            alphapolis_rankTotal: 1234,
            alphapolis_rank24h: 56,
            alphapolis_hearts: 7,
          },
        },
        {
          scope: "episode",
          episode: 1,
          metrics: {
            likes: 3,
            alphapolis_bookmarks: 2,
            alphapolis_yells: 1,
            alphapolis_typoReports: 0,
          },
        },
      ],
    });
    const applied = applyReaderStatsEnvelope(registered(), envelope);
    expect(applied.added).toBe(2);
    expect(applied.ledger.readerStats[0].metrics.alphapolis_rankTotal).toBe(1234);
    expect(applied.ledger.readerStats[1].metrics.alphapolis_typoReports).toBe(0);
    expect(siteFactsFor(applied.ledger, "alphapolis")?.tags).toEqual(["ファンタジー"]);
    expect(siteFactsFor(applied.ledger, "alphapolis")?.completion).toBe("completed");
  });

  test("順位はグラフ（増減の棒）に載らない", () => {
    const applied = applyReaderStatsEnvelope(
      registered(),
      envelopeOf({
        "novelai-stats": 1,
        site: "alphapolis",
        readAt: "2026-11-01T02:00:00.000Z",
        entries: [
          {
            scope: "work",
            period: "day",
            periodKey: "2026-11-01",
            metrics: { points: 10, alphapolis_rank24h: 3 },
          },
        ],
      })
    );
    const charts = buildReaderCharts(applied.ledger.readerStats, null);
    expect(charts.changes.map((chart) => chart.metric)).not.toContain("alphapolis_rank24h");
  });

  test("順位は整数だけ（小数は封筒ごと断る。ほかの欄と同じ関所）", () => {
    const parsed = parseReaderStatsEnvelope(
      JSON.stringify({
        "novelai-stats": 1,
        site: "alphapolis",
        readAt: "2026-11-01T02:00:00.000Z",
        entries: [{ scope: "work", metrics: { points: 1, alphapolis_rank24h: 1.5 } }],
      })
    );
    expect(parsed.ok).toBe(false);
  });
});

describe("台帳へ写す（今のタグ・付け替えの記録・連載の状態・覚えた理由）", () => {
  test("初めて届いたタグは今の値になり、付け替えの記録は作らない", () => {
    const applied = applyReaderStatsEnvelope(
      registered(),
      envelopeOf(kakuyomuRaw({ tags: ["異世界"], completion: "ongoing", ownedVia: "owner-page" }))
    );
    expect(applied.factsChanged).toBe(true);
    const facts = siteFactsFor(applied.ledger, "kakuyomu");
    expect(facts).toEqual({
      site: "kakuyomu",
      tags: ["異世界"],
      tagsAt: "2026-11-01T01:00:00.000Z",
      completion: "ongoing",
      completionAt: "2026-11-01T01:00:00.000Z",
      ownedVia: "owner-page",
      ownedViaAt: "2026-11-01T01:00:00.000Z",
    });
    expect(applied.ledger.tagChanges ?? []).toEqual([]);
  });

  test("前の値と違うタグが届いたら、付け替えた日と前後のタグを残す", () => {
    let ledger = applyReaderStatsEnvelope(
      registered(),
      envelopeOf(kakuyomuRaw({ tags: ["異世界", "群像劇"] }, "2026-10-01T00:00:00.000Z"))
    ).ledger;
    const applied = applyReaderStatsEnvelope(
      ledger,
      envelopeOf(kakuyomuRaw({ tags: ["異世界", "恋愛"] }, "2026-11-01T00:00:00.000Z"))
    );
    ledger = applied.ledger;
    expect(applied.factsChanged).toBe(true);
    expect(ledger.tagChanges).toEqual([
      {
        site: "kakuyomu",
        changedAt: "2026-11-01T00:00:00.000Z",
        before: ["異世界", "群像劇"],
        after: ["異世界", "恋愛"],
      },
    ]);
    expect(siteFactsFor(ledger, "kakuyomu")?.tags).toEqual(["異世界", "恋愛"]);
  });

  test("タグを全部外した（[]）も付け替えとして残す", () => {
    let ledger = applyReaderStatsEnvelope(
      registered(),
      envelopeOf(kakuyomuRaw({ tags: ["異世界"] }, "2026-10-01T00:00:00.000Z"))
    ).ledger;
    ledger = applyReaderStatsEnvelope(
      ledger,
      envelopeOf(kakuyomuRaw({ tags: [] }, "2026-11-01T00:00:00.000Z"))
    ).ledger;
    expect(ledger.tagChanges?.[0]).toMatchObject({ before: ["異世界"], after: [] });
  });

  test("同じタグ・欄の無い封筒は、今の値を変えず記録も増やさない", () => {
    const first = applyReaderStatsEnvelope(
      registered(),
      envelopeOf(kakuyomuRaw({ tags: ["異世界"] }, "2026-10-01T00:00:00.000Z"))
    ).ledger;
    const same = applyReaderStatsEnvelope(
      first,
      envelopeOf(kakuyomuRaw({ tags: ["異世界"] }, "2026-11-01T00:00:00.000Z"))
    );
    expect(same.factsChanged).toBe(false);
    expect(same.ledger.tagChanges ?? []).toEqual([]);
    // アクセス数の画面（タグの欄が無い）はタグに触らない
    const none = applyReaderStatsEnvelope(
      first,
      envelopeOf(kakuyomuRaw({}, "2026-11-02T00:00:00.000Z"))
    );
    expect(none.factsChanged).toBe(false);
    expect(siteFactsFor(none.ledger, "kakuyomu")?.tags).toEqual(["異世界"]);
  });

  test("束の中で古い画面があとから来ても、新しい値を上書きしない（readAt の新しい方が勝つ）", () => {
    let ledger = applyReaderStatsEnvelope(
      registered(),
      envelopeOf(kakuyomuRaw({ tags: ["新しい"], completion: "completed" }, "2026-11-01T00:00:00.000Z"))
    ).ledger;
    const older = applyReaderStatsEnvelope(
      ledger,
      envelopeOf(kakuyomuRaw({ tags: ["古い"], completion: "ongoing" }, "2026-10-01T00:00:00.000Z"))
    );
    ledger = older.ledger;
    expect(older.factsChanged).toBe(false);
    expect(siteFactsFor(ledger, "kakuyomu")?.tags).toEqual(["新しい"]);
    expect(siteFactsFor(ledger, "kakuyomu")?.completion).toBe("completed");
    expect(ledger.tagChanges ?? []).toEqual([]);
  });

  test("同じ値をあとで読み直したら日時だけ進み、その間の古い画面があとから来ても勝たない", () => {
    let ledger = applyReaderStatsEnvelope(
      registered(),
      envelopeOf(kakuyomuRaw({ tags: ["A"], completion: "ongoing" }, "2026-10-01T00:00:00.000Z"))
    ).ledger;
    const reread = applyReaderStatsEnvelope(
      ledger,
      envelopeOf(kakuyomuRaw({ tags: ["A"], completion: "ongoing" }, "2026-11-01T00:00:00.000Z"))
    );
    // 値は変わっていないので「書き換えた」とは言わない（日時の前進は数の保存に相乗りする）
    expect(reread.factsChanged).toBe(false);
    ledger = reread.ledger;
    expect(siteFactsFor(ledger, "kakuyomu")?.tagsAt).toBe("2026-11-01T00:00:00.000Z");
    const between = applyReaderStatsEnvelope(
      ledger,
      envelopeOf(kakuyomuRaw({ tags: ["B"], completion: "completed" }, "2026-10-15T00:00:00.000Z"))
    );
    expect(between.factsChanged).toBe(false);
    expect(siteFactsFor(between.ledger, "kakuyomu")?.tags).toEqual(["A"]);
    expect(siteFactsFor(between.ledger, "kakuyomu")?.completion).toBe("ongoing");
    expect(between.ledger.tagChanges ?? []).toEqual([]);
  });

  test("サイトの印は、作品の印（作者が決める値）を書き換えない", () => {
    const ledger: PostingLedger = {
      ...registered(),
      completion: { value: "ongoing", setAt: "2026-10-01T00:00:00.000Z" },
    };
    const applied = applyReaderStatsEnvelope(
      ledger,
      envelopeOf(kakuyomuRaw({ completion: "completed" }))
    );
    expect(applied.ledger.completion).toEqual({
      value: "ongoing",
      setAt: "2026-10-01T00:00:00.000Z",
    });
    expect(siteFactsFor(applied.ledger, "kakuyomu")?.completion).toBe("completed");
  });

  test("数が同じでもタグが変わった封筒は「まだ取り込んでいない」と見る（自動取り込みを飛ばさない）", () => {
    const first = applyReaderStatsEnvelope(
      registered(),
      envelopeOf(kakuyomuRaw({ tags: ["異世界"] }, "2026-11-01T01:00:00.000Z"))
    ).ledger;
    // 同じ数・同じ日時の封筒は取り込み済み
    expect(
      readerStatsAlreadyImported(
        envelopeOf(kakuyomuRaw({ tags: ["異世界"] }, "2026-11-01T01:00:00.000Z")),
        first
      )
    ).toBe(true);
    // 数は同じだがタグが違う
    expect(
      readerStatsAlreadyImported(
        envelopeOf(kakuyomuRaw({ tags: ["恋愛"] }, "2026-11-01T01:00:00.000Z")),
        first
      )
    ).toBe(false);
  });

  test("台帳に書いて読み直しても、今の値・付け替え・作品の印が残る", () => {
    let ledger: PostingLedger = {
      ...registered(),
      completion: { value: "completed", setAt: "2026-11-01T03:00:00.000Z" },
    };
    ledger = applyReaderStatsEnvelope(
      ledger,
      envelopeOf(kakuyomuRaw({ tags: ["a"], ownedVia: "approved" }, "2026-10-01T00:00:00.000Z"))
    ).ledger;
    ledger = applyReaderStatsEnvelope(
      ledger,
      envelopeOf(kakuyomuRaw({ tags: ["b"] }, "2026-11-01T00:00:00.000Z"))
    ).ledger;
    const reread = readPostingLedger(JSON.parse(JSON.stringify(ledger))).ledger;
    expect(reread.completion).toEqual(ledger.completion);
    expect(reread.siteFacts).toEqual(ledger.siteFacts);
    expect(reread.tagChanges).toEqual(ledger.tagChanges);
    expect(siteFactsFor(reread, "kakuyomu")?.ownedVia).toBe("approved");
  });

  test("新しい欄の無い台帳は、これまでどおり読める（欄は空のまま）", () => {
    const reread = readPostingLedger({
      schemaVersion: "1",
      sites: [{ site: "kakuyomu", newEpisodeUrl: KAKUYOMU_POST }],
      posts: [],
    }).ledger;
    expect(reread.completion).toBeUndefined();
    expect(reread.siteFacts ?? []).toEqual([]);
    expect(reread.tagChanges ?? []).toEqual([]);
  });

  test("束の知らせ：数が同じでタグだけ変わった作品は「記録は変えていません」と言わない", () => {
    const sameNumbers = readerStatsBundleNotice({
      works: [{ title: "氷の街", screens: 1, added: 0, repeated: 3, factsChanged: true }],
      failures: [],
    });
    expect(sameNumbers.message).not.toContain("記録は変えていません");
    expect(sameNumbers.message).toContain("タグ・連載の状態の変化を記録しました");
    const withNumbers = readerStatsBundleNotice({
      works: [{ title: "氷の街", screens: 1, added: 2, repeated: 0, factsChanged: true }],
      failures: [],
    });
    expect(withNumbers.message).toContain("（タグ・連載の状態も記録しました）");
  });

  test("壊れた作品の印は直さずに止める（作者の書いた値を推測で書き換えない）", () => {
    expect(() =>
      readPostingLedger({
        schemaVersion: "1",
        sites: [],
        posts: [],
        completion: { value: "finished", setAt: "2026-11-01T00:00:00.000Z" },
      })
    ).toThrow();
  });
});
