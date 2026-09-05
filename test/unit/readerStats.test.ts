import { describe, expect, test } from "vitest";
import {
  buildReaderStatsEnvelope,
  matchReaderStatsEnvelope,
  parseReaderStatsEnvelope,
  READER_STATS_ENVELOPE_VERSION,
} from "../../src/core/readerStatsEnvelope";
import {
  emptyPostingLedger,
  latestReaderStats,
  parsePostingLedger,
  readerStatsForSite,
  withReaderStats,
  withSiteProfile,
  withSites,
  type PostingLedger,
  type ReaderStatsRecord,
} from "../../src/models/posting";

/**
 * 読者の反応の取り込み（設計書6.79.7）。
 *
 * **こちらからサイトを読みにいかない。** 台帳へ入るのは、作者が手で打った値か、
 * 作者が自分で開いた管理画面から貼り込み係が作った封筒だけである。
 *
 * ここで確かめるのは3つ。
 *
 *   1. 台帳は**追記だけ**で、中身の無い記録は受け取らない
 *   2. 封筒は**形が合うものだけ**を受け取る（版数・サイト・数値）
 *   3. 照合で取り違えを止める（未登録のサイト・作品IDの食い違い）
 */

const url = {
  narou: "https://syosetu.com/usernovelmanage/isnoveluploadmenu/ncode/n1234ab/",
  kakuyomu: "https://kakuyomu.jp/my/works/1177354054892/episodes/new",
};

function registered(): PostingLedger {
  return withSites(emptyPostingLedger(), [
    { site: "narou", newEpisodeUrl: url.narou },
    { site: "kakuyomu", newEpisodeUrl: url.kakuyomu },
  ]);
}

function record(patch: Partial<ReaderStatsRecord> = {}): ReaderStatsRecord {
  return {
    site: "kakuyomu",
    readAt: "2026-09-05T00:00:00.000Z",
    scope: "work",
    metrics: { pv: 1234 },
    source: "manual",
    ...patch,
  };
}

describe("読者の反応の台帳", () => {
  test("追記だけで、既にある記録は1つも変わらない", () => {
    let ledger = withReaderStats(registered(), record({ metrics: { pv: 100 } }));
    const first = ledger.readerStats[0];
    ledger = withReaderStats(
      ledger,
      record({ readAt: "2026-09-06T00:00:00.000Z", metrics: { pv: 200 } })
    );

    expect(ledger.readerStats).toHaveLength(2);
    // **畳まない**（同じ日に2回読めば2件——履歴だから）
    expect(ledger.readerStats[0]).toEqual(first);
    expect(ledger.readerStats[1].metrics).toEqual({ pv: 200 });
  });

  test("中身の無い記録は受け取らない（数値が1つも無い）", () => {
    expect(() => withReaderStats(registered(), record({ metrics: {} }))).toThrow();
  });

  test("負の数・小数は受け取らない", () => {
    expect(() =>
      withReaderStats(registered(), record({ metrics: { pv: -1 } }))
    ).toThrow();
    expect(() =>
      withReaderStats(registered(), record({ metrics: { pv: 1.5 } }))
    ).toThrow();
    // 0は「読んだが0だった」という意味を持つので受ける
    expect(
      withReaderStats(registered(), record({ metrics: { likes: 0 } }))
        .readerStats[0].metrics
    ).toEqual({ likes: 0 });
  });

  test("粒度と期間キーは対で持つ", () => {
    const ledger = withReaderStats(
      registered(),
      record({ period: "month", periodKey: "2026-09" })
    );
    expect(ledger.readerStats[0].periodKey).toBe("2026-09");

    // 日別なのに月のキー、月別なのにキーが無い、はどちらも読めない
    expect(() =>
      withReaderStats(registered(), record({ period: "day", periodKey: "2026-09" }))
    ).toThrow();
    expect(() =>
      withReaderStats(registered(), record({ period: "year" }))
    ).toThrow();
  });

  test("空のメモは持たせない（台帳が中身の無い欄で膨らまない）", () => {
    const saved = withReaderStats(registered(), record({ note: "   " }))
      .readerStats[0];
    expect(saved.note).toBeUndefined();
    expect(Object.keys(saved)).not.toContain("episode");
  });

  test("サイトごとに、新しい順で取り出せる", () => {
    let ledger = registered();
    ledger = withReaderStats(
      ledger,
      record({ readAt: "2026-09-01T00:00:00.000Z", metrics: { pv: 1 } })
    );
    ledger = withReaderStats(
      ledger,
      record({ readAt: "2026-09-05T00:00:00.000Z", metrics: { pv: 5 } })
    );
    ledger = withReaderStats(
      ledger,
      record({ site: "narou", readAt: "2026-09-09T00:00:00.000Z", metrics: { pv: 9 } })
    );

    expect(
      readerStatsForSite(ledger, "kakuyomu").map((entry) => entry.metrics.pv)
    ).toEqual([5, 1]);
    expect(latestReaderStats(ledger, "kakuyomu")?.metrics.pv).toBe(5);
    expect(latestReaderStats(ledger, "alphapolis")).toBeUndefined();
  });

  test("この欄が無い台帳（旧形式）は、空として読む", () => {
    const ledger = parsePostingLedger({
      schemaVersion: "1",
      sites: [{ site: "narou", newEpisodeUrl: url.narou }],
      posts: [],
    });
    expect(ledger.readerStats).toEqual([]);
  });

  test("台帳を読み書きしても、記録は元の形のまま残る", () => {
    const written = withReaderStats(
      registered(),
      record({
        scope: "episode",
        episode: 3,
        period: "day",
        periodKey: "2026-09-05",
        metrics: { pv: 1234, likes: 12 },
        source: "helper",
        note: "更新直後",
      })
    );

    const round = parsePostingLedger(JSON.parse(JSON.stringify(written)));
    expect(round.readerStats).toEqual(written.readerStats);
  });

  test("壊れた記録は直さずに止める", () => {
    const base = {
      schemaVersion: "1",
      sites: [{ site: "narou", newEpisodeUrl: url.narou }],
    };
    // 数値でない
    expect(() =>
      parsePostingLedger({
        ...base,
        readerStats: [
          {
            site: "narou",
            readAt: "2026-09-05T00:00:00.000Z",
            scope: "work",
            metrics: { pv: "1234" },
            source: "manual",
          },
        ],
      })
    ).toThrow();
    // 知らないサイト
    expect(() =>
      parsePostingLedger({
        ...base,
        readerStats: [
          {
            site: "pixiv",
            readAt: "2026-09-05T00:00:00.000Z",
            scope: "work",
            metrics: { pv: 1 },
            source: "manual",
          },
        ],
      })
    ).toThrow();
    // 範囲が読めない
    expect(() =>
      parsePostingLedger({
        ...base,
        readerStats: [
          {
            site: "narou",
            readAt: "2026-09-05T00:00:00.000Z",
            scope: "chapter",
            metrics: { pv: 1 },
            source: "manual",
          },
        ],
      })
    ).toThrow();
  });
});

/**
 * 逆向きの封筒（設計書6.79.7の3）。
 *
 * **貼り込みの封筒（`novelai-post`）とは別の形である。** 向こうは母艦→ブラウザ、
 * こちらはブラウザ→母艦で、渡すものも読む側も違う。
 */
describe("読者の反応の封筒", () => {
  const envelope = {
    "novelai-stats": READER_STATS_ENVELOPE_VERSION,
    site: "kakuyomu",
    workId: "1177354054892",
    readAt: "2026-09-05T09:00:00.000Z",
    entries: [
      { scope: "work", period: "day", periodKey: "2026-09-05", metrics: { pv: 1234 } },
      { scope: "episode", episode: 3, metrics: { pv: 120, likes: 4 } },
    ],
  };

  test("形が合えば受け取る", () => {
    const result = parseReaderStatsEnvelope(JSON.stringify(envelope));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.envelope.site).toBe("kakuyomu");
    expect(result.envelope.workId).toBe("1177354054892");
    expect(result.envelope.entries).toHaveLength(2);
    expect(result.envelope.entries[1]).toEqual({
      scope: "episode",
      episode: 3,
      metrics: { pv: 120, likes: 4 },
    });
  });

  test("封筒でなければ、静かに断る（クリップボードには何でも入る）", () => {
    for (const raw of ["", "   ", "ただの本文", "{}", "[1,2,3]"]) {
      const result = parseReaderStatsEnvelope(raw);
      expect(result.ok, raw).toBe(false);
    }
  });

  test("版数が違えば受け取らない", () => {
    const result = parseReaderStatsEnvelope(
      JSON.stringify({ ...envelope, "novelai-stats": 2 })
    );
    expect(result.ok).toBe(false);
  });

  test("読み取りに対応していないサイトの封筒は受け取らない", () => {
    // なろうは規約でAPI以外の自動収集を禁じている（6.79.7の判定）。
    // pixiv・ハーメルン・noteも同じ扱いで、手入力だけを残す
    for (const site of ["narou", "note"]) {
      const result = parseReaderStatsEnvelope(
        JSON.stringify({ ...envelope, site })
      );
      expect(result.ok, site).toBe(false);
      if (result.ok) continue;
      expect(result.reason).toContain("手入力");
    }
  });

  test("entriesが無い・空・数値でない封筒は受け取らない", () => {
    const broken = [
      { ...envelope, entries: undefined },
      { ...envelope, entries: [] },
      { ...envelope, entries: [{ scope: "work", metrics: { pv: "1234" } }] },
      { ...envelope, entries: [{ scope: "work", metrics: {} }] },
      { ...envelope, entries: [{ scope: "work", metrics: { pv: -5 } }] },
      { ...envelope, entries: [{ scope: "作品", metrics: { pv: 1 } }] },
      { ...envelope, readAt: undefined },
      // 粒度と期間は対で持つ（「日別」だけでは、いつの日か読めない）
      {
        ...envelope,
        entries: [{ scope: "work", period: "day", metrics: { pv: 1 } }],
      },
      {
        ...envelope,
        entries: [
          { scope: "work", period: "month", periodKey: "2026-09-05", metrics: { pv: 1 } },
        ],
      },
      // 作品全体の行に話数は付かない
      {
        ...envelope,
        entries: [{ scope: "work", episode: 3, metrics: { pv: 1 } }],
      },
    ];
    for (const raw of broken) {
      expect(parseReaderStatsEnvelope(JSON.stringify(raw)).ok).toBe(false);
    }
  });

  test("組み立てと読み取りが往復する（別プロジェクトとの約束を固定する）", () => {
    const built = buildReaderStatsEnvelope({
      site: "alphapolis",
      workId: "  123456/7890123  ",
      readAt: "2026-09-05T09:00:00.000Z",
      entries: [{ scope: "work", metrics: { pv: 10 } }],
    });
    const result = parseReaderStatsEnvelope(built);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.envelope.workId).toBe("123456/7890123");
    // 空の作品IDは欄ごと書かない（向こう側が「IDが空」として照合しないように）
    const noId = parseReaderStatsEnvelope(
      buildReaderStatsEnvelope({
        site: "alphapolis",
        readAt: "2026-09-05T09:00:00.000Z",
        entries: [{ scope: "work", metrics: { pv: 10 } }],
      })
    );
    expect(noId.ok).toBe(true);
    if (!noId.ok) return;
    expect(noId.envelope.workId).toBeUndefined();
  });
});

/**
 * 取り違え防止（設計書6.79.7の4、6.79.6と同じ考え方）。
 *
 * **別の作品の数字を混ぜない。** いちど混ざると、どれが誰の数字だったかは
 * あとから分けられない。
 */
describe("封筒と台帳の照合", () => {
  const envelope = parseReaderStatsEnvelope(
    buildReaderStatsEnvelope({
      site: "kakuyomu",
      workId: "1177354054892",
      readAt: "2026-09-05T09:00:00.000Z",
      entries: [{ scope: "work", metrics: { pv: 1 } }],
    })
  );

  function ok() {
    if (!envelope.ok) throw new Error("封筒を読めていない");
    return envelope.envelope;
  }

  test("登録してあるサイトで、作品IDも合っていれば通す", () => {
    const ledger = withSiteProfile(registered(), "kakuyomu", {
      workId: "1177354054892",
    });
    expect(matchReaderStatsEnvelope(ok(), ledger)).toBeNull();
  });

  test("台帳に作品IDが無ければ、サイトが合っていれば通す", () => {
    expect(matchReaderStatsEnvelope(ok(), registered())).toBeNull();
  });

  test("投稿先として登録していないサイトは断る", () => {
    const ledger = withSites(emptyPostingLedger(), [
      { site: "narou", newEpisodeUrl: url.narou },
    ]);
    const reason = matchReaderStatsEnvelope(ok(), ledger);
    expect(reason).toContain("カクヨム");
  });

  test("作品IDが食い違えば断る（別の作品の数字を混ぜない）", () => {
    const ledger = withSiteProfile(registered(), "kakuyomu", {
      workId: "9999999999",
    });
    const reason = matchReaderStatsEnvelope(ok(), ledger);
    expect(reason).toContain("作品ID");
  });
});
