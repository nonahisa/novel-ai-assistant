import { describe, expect, test } from "vitest";
import {
  buildReaderStatsEnvelope,
  matchReaderStatsEnvelope,
  parseReaderStatsEnvelope,
  READER_STATS_ENVELOPE_VERSION,
} from "../../../src/core/readerStatsEnvelope";
import {
  assertReaderStatsRecords,
  emptyPostingLedger,
  latestReaderStats,
  parsePostingLedger,
  parseReaderStatsEpisode,
  readerStatsForSite,
  readPostingLedger,
  validateReaderStatsEpisode,
  validateReaderStatsPeriodKey,
  withReaderStats,
  withSiteProfile,
  withSites,
  type PostingLedger,
  type ReaderStatsRecord,
} from "../../../src/models/posting";

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

  /*
    **話ごとの記録が混ざっていても、新しい順は崩れない**（2026-09-22 に足した）。

    **なぜ要るか**：「3つの輪」の `collectReactions`（`features/threeCircles.ts`）は
    `readerStatsForSite(...).find((r) => r.scope === "work")` と書いている。
    **「新しい順に並んでいる」前提の上で、最初に見つかった作品全体の行を採る**
    作りである。ここが**話ごとの記録で乱される**と、**古い作品全体の記録**を
    掴んでしまい、紙に古い数字が出る。

    上の「サイトごとに、新しい順で取り出せる」は**作品全体の行だけ**で組んで
    いるので、この筋道が抜けていた。`collectReactions` は export されていない
    ので直接は測れないが、**その前提だけならここで留められる。**
  */
  test("話ごとの記録が混ざっても、新しい順は崩れない（作品全体の最新を取り違えない）", () => {
    let ledger = registered();
    ledger = withReaderStats(
      ledger,
      record({ readAt: "2026-09-01T00:00:00.000Z", metrics: { pv: 1 } })
    );
    // **いちばん新しいのは話ごとの記録**。作品全体の最新はこの下の 7 である
    ledger = withReaderStats(
      ledger,
      record({
        readAt: "2026-09-09T00:00:00.000Z",
        scope: "episode",
        metrics: { pv: 9 },
      })
    );
    ledger = withReaderStats(
      ledger,
      record({ readAt: "2026-09-07T00:00:00.000Z", metrics: { pv: 7 } })
    );

    const forSite = readerStatsForSite(ledger, "kakuyomu");

    // 並びは、種類によらず新しい順
    expect(forSite.map((entry) => entry.metrics.pv)).toEqual([9, 7, 1]);
    // **利用側と同じ取り方**をしたとき、作品全体の最新（7）が来る
    expect(
      forSite.find((entry) => entry.scope === "work")?.metrics.pv
    ).toBe(7);
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

  /*
    **壊れた行は、その行だけを飛ばす**（0.69.9。作者の裁定「読みを寛容に
    する」）。以前はここで台帳ぜんぶを止めていたが、`設定/` は同期するので
    **書いた版より古い版が読む**ことが現実に起きる——1行のために投稿系の
    機能が丸ごと止まるほうが害が大きい。

    **数字は1つも消えない。** 飛ばした行は生のまま控え、保存でそのまま
    書き戻す（`skippedReaderStatsRows`）。書き側の関所は緩めていない。
  */
  test("壊れた記録は、その行だけ飛ばして生のまま控える", () => {
    const base = {
      schemaVersion: "1",
      sites: [{ site: "narou", newEpisodeUrl: url.narou }],
    };
    const good = {
      site: "narou",
      readAt: "2026-09-05T00:00:00.000Z",
      scope: "work",
      metrics: { pv: 10 },
      source: "manual",
    };
    const broken = [
      // 数値でない（文字列を数として書き込まない）
      { ...good, metrics: { pv: "1234" } },
      // 知らないサイト
      { ...good, site: "pixiv" },
      // 範囲が読めない
      { ...good, scope: "chapter" },
      // 知らない出どころ（未来の版が足したもの）
      { ...good, source: "未来の出どころ" },
    ];

    for (const row of broken) {
      const read = readPostingLedger({ ...base, readerStats: [good, row] });
      expect(read.ledger.readerStats).toHaveLength(1);
      expect(read.ledger.readerStats[0].metrics).toEqual({ pv: 10 });
      expect(read.skippedReaderStatsRows).toEqual([row]);
      // 台帳そのものは読めている（投稿系の機能が止まらない）
      expect(read.ledger.sites).toHaveLength(1);
    }
  });

  test("入れ物の形が違えば、これまでどおり止める", () => {
    // 寛容にしたのは**行の中身まで**である。ここまで黙って通すと、
    // 「読めた」と「読めなかった」の区別が台帳から消える
    expect(() =>
      parsePostingLedger({
        schemaVersion: "1",
        sites: [{ site: "narou", newEpisodeUrl: url.narou }],
        readerStats: "壊れています",
      })
    ).toThrow();
  });
});

/**
 * **知らない指標が混ざった台帳**（0.33.9のレビュー、中1）。
 *
 * 台帳は `設定/` に置いてGitで同期する。**新しい版の拡張機能が足した指標を、
 * 古い版の機械が読む**ことが現実に起きる——そのとき、知らない欄しか無い行で
 * 台帳ぜんぶが読めなくなると、投稿系の機能が丸ごと止まる。
 * その行だけを読み飛ばし、ほかの行と台帳は読めるようにする。
 */
describe("知らない指標だけの行", () => {
  const base = {
    schemaVersion: "1",
    sites: [{ site: "narou", newEpisodeUrl: url.narou }],
    posts: [],
  };
  const known = {
    site: "narou",
    readAt: "2026-09-05T00:00:00.000Z",
    scope: "work",
    metrics: { pv: 10 },
    source: "manual",
  };
  const unknownOnly = {
    ...known,
    readAt: "2026-09-06T00:00:00.000Z",
    // 将来の版が足した指標（この版は知らない）
    metrics: { reviewsPerDay: 3 },
  };

  test("知らない欄しか無い行は読み飛ばし、ほかの行も台帳も読める", () => {
    const ledger = parsePostingLedger({
      ...base,
      readerStats: [known, unknownOnly],
    });

    expect(ledger.readerStats).toHaveLength(1);
    expect(ledger.readerStats[0].metrics).toEqual({ pv: 10 });
    // 台帳そのものは読めている（投稿系の機能が止まらない）
    expect(ledger.sites).toHaveLength(1);
  });

  test("読み飛ばした件数を返す（呼ぶ側が記録へ残せる）", () => {
    const result = readPostingLedger({
      ...base,
      readerStats: [known, unknownOnly, unknownOnly],
    });

    expect(result.skippedReaderStats).toBe(2);
    expect(result.ledger.readerStats).toHaveLength(1);
  });

  test("知っている欄が1つでもあれば、その行は残る（知らない欄だけ捨てる）", () => {
    const ledger = parsePostingLedger({
      ...base,
      readerStats: [{ ...known, metrics: { pv: 10, reviewsPerDay: 3 } }],
    });

    expect(ledger.readerStats[0].metrics).toEqual({ pv: 10 });
  });

  test("欄がひとつも無い行も、その行だけ飛ばして控える（0.69.9）", () => {
    // 手で消した跡も、未来の版の行も、**読めないことに変わりはない**。
    // 以前はここだけ「直さずに止める」と分けていたが、行ごとに飛ばす
    // 仕組みができたので、控えて書き戻すほうが失うものが少ない
    const empty = { ...known, metrics: {} };
    const read = readPostingLedger({ ...base, readerStats: [known, empty] });

    expect(read.ledger.readerStats).toHaveLength(1);
    expect(read.skippedReaderStatsRows).toEqual([empty]);
  });

  test("書き側は従来どおり拒否する（読みだけを緩める）", () => {
    expect(() =>
      withReaderStats(registered(), record({ metrics: {} }))
    ).toThrow();
    expect(() =>
      assertReaderStatsRecords([record({ metrics: {} })])
    ).toThrow();
  });
});

/**
 * **最新の反応の選び方**（0.33.9のレビュー、L4）。
 *
 * 貼り込み係の封筒は1回の読み取りで何行も入るので、**同じ `readAt` の行が
 * 並ぶ**。「最新の反応」に1話ぶんの数字が出ると、作品の勢いを読み違える。
 */
describe("同じ日時のときの並び", () => {
  test("作品全体を先にする", () => {
    let ledger = withReaderStats(
      registered(),
      record({ scope: "episode", episode: 3, metrics: { pv: 120 } })
    );
    ledger = withReaderStats(ledger, record({ metrics: { pv: 1234 } }));

    expect(latestReaderStats(ledger, "kakuyomu")?.scope).toBe("work");
    expect(latestReaderStats(ledger, "kakuyomu")?.metrics.pv).toBe(1234);
  });

  test("範囲が同じなら、累計・粒度なしを先にする", () => {
    let ledger = withReaderStats(
      registered(),
      record({ period: "day", periodKey: "2026-09-05", metrics: { pv: 12 } })
    );
    ledger = withReaderStats(ledger, record({ metrics: { pv: 1234 } }));

    expect(latestReaderStats(ledger, "kakuyomu")?.period).toBeUndefined();
    expect(latestReaderStats(ledger, "kakuyomu")?.metrics.pv).toBe(1234);
  });
});

/**
 * **期間の入力**（0.33.9のレビュー、L5）。形だけでなく、実在するかを見る。
 */
describe("期間の入力", () => {
  test("月は01〜12だけ", () => {
    expect(validateReaderStatsPeriodKey("month", "2026-09")).toBeNull();
    expect(validateReaderStatsPeriodKey("month", "2026-13")).toBeTruthy();
    expect(validateReaderStatsPeriodKey("month", "2026-00")).toBeTruthy();
  });

  test("日は実在する日付だけ", () => {
    expect(validateReaderStatsPeriodKey("day", "2026-09-05")).toBeNull();
    // 閏年の2月29日は実在する
    expect(validateReaderStatsPeriodKey("day", "2024-02-29")).toBeNull();
    expect(validateReaderStatsPeriodKey("day", "2026-02-29")).toBeTruthy();
    expect(validateReaderStatsPeriodKey("day", "2026-04-31")).toBeTruthy();
    expect(validateReaderStatsPeriodKey("day", "2026-09-00")).toBeTruthy();
  });

  /**
   * **読み込みは形だけを見る。** ここまで厳しくすると、手で打ち間違えた
   * 1行で台帳ぜんぶが読めなくなる（中1で直したのと同じ形の事故になる）。
   */
  test("台帳の読み込みは、実在しない日付でも止めない", () => {
    const ledger = parsePostingLedger({
      schemaVersion: "1",
      sites: [{ site: "narou", newEpisodeUrl: url.narou }],
      readerStats: [
        {
          site: "narou",
          readAt: "2026-09-05T00:00:00.000Z",
          scope: "work",
          period: "day",
          periodKey: "2026-02-30",
          metrics: { pv: 1 },
          source: "manual",
        },
      ],
    });

    expect(ledger.readerStats).toHaveLength(1);
  });
});

/**
 * **話番号の入力**（0.33.9のレビュー、L6）。
 *
 * 数値（PVなど）は「1,234」と打たれるので区切りを落とすが、**話番号で
 * 同じことをすると「1,2」が12話になる**——別の話の数字が混ざる。
 */
describe("話番号の入力", () => {
  test("カンマは受けない", () => {
    expect(parseReaderStatsEpisode("1,2")).toBeNull();
    expect(parseReaderStatsEpisode("1，2")).toBeNull();
    expect(validateReaderStatsEpisode("1,2")).toBeTruthy();
  });

  test("1以上の整数だけ。全角の数字は読む", () => {
    expect(parseReaderStatsEpisode("3")).toBe(3);
    expect(parseReaderStatsEpisode("３")).toBe(3);
    expect(parseReaderStatsEpisode(" 12 ")).toBe(12);
    expect(parseReaderStatsEpisode("0")).toBeNull();
    expect(parseReaderStatsEpisode("-1")).toBeNull();
    expect(parseReaderStatsEpisode("")).toBeNull();
    expect(validateReaderStatsEpisode("")).toBeTruthy();
    expect(validateReaderStatsEpisode("3")).toBeNull();
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
      expect(result.reason).toContain("読者反応手動入力");
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

  /**
   * **`null` は「欄なし」と同じに扱う**（0.33.9のレビュー、L3）。
   *
   * 封筒を作るのは別プロジェクト（ブラウザ拡張）で、読めなかった欄を
   * `null` で書くのは素直な書き方である。断ると、**封筒ごと取り込めない**
   * ——数字は正しいのに、書き方の流儀だけで落ちることになる。
   */
  test("null の欄は、書かれていないものとして読む", () => {
    const result = parseReaderStatsEnvelope(
      JSON.stringify({
        ...envelope,
        workId: null,
        entries: [
          {
            scope: "work",
            episode: null,
            period: null,
            periodKey: null,
            note: null,
            metrics: { pv: 1 },
          },
        ],
      })
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.envelope.workId).toBeUndefined();
    expect(result.envelope.entries[0]).toEqual({
      scope: "work",
      metrics: { pv: 1 },
    });
  });

  test("空文字の periodKey も、欄なしとして読む", () => {
    const result = parseReaderStatsEnvelope(
      JSON.stringify({
        ...envelope,
        entries: [{ scope: "work", periodKey: "   ", metrics: { pv: 1 } }],
      })
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.envelope.entries[0].periodKey).toBeUndefined();
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
