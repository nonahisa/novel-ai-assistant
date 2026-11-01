import { describe, expect, test } from "vitest";
import {
  applyReaderStatsRankings,
  buildReaderStatsEnvelope,
  parseRanking,
  parseReaderStatsPaste,
  rankingRecordFromHelper,
  READER_STATS_BUNDLE_KIND,
  type ReaderStatsRanking,
} from "../../../src/core/readerStatsEnvelope";
import {
  readerStatsBundleNotice,
  readerStatsBundlePending,
  routeReaderStatsRanking,
} from "../../../src/core/readerStatsHelperLink";
import {
  emptyPostingLedger,
  rankingBoards,
  readPostingLedger,
  withRanking,
  withSiteProfile,
  withSites,
  type PostingLedger,
} from "../../../src/models/posting";

/**
 * ヘルパーがランキングの画面で読んだ順位（束の一番上の段の `rankings`。2026-11-02）を
 * 受け取る関所と、台帳への積み方。
 *
 * 取り決め：1件は site・workId（必須）・title・board・boardLabel・span・genre・rank・date・readAt。
 * 見分けの鍵は site＋workId＋board＋date。読めない1件だけを捨て、束はまるごと断らない。
 * items が空でも rankings があれば受け取る。
 */

function ranking(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    site: "kakuyomu",
    workId: "1111",
    title: "星の庭",
    board: "rankings/fantasy/weekly/long",
    boardLabel: "週間異世界ファンタジーの長編ランキング",
    span: "weekly",
    genre: "異世界ファンタジー",
    rank: 12,
    date: "2026-11-02",
    readAt: "2026-11-02T12:03:00.000Z",
    ...overrides,
  };
}

function bundle(items: unknown[], rankings?: unknown): string {
  return JSON.stringify({
    kind: READER_STATS_BUNDLE_KIND,
    version: 1,
    handedAt: "2026-11-02T10:00:00.000+09:00",
    items,
    ...(rankings !== undefined ? { rankings } : {}),
  });
}

function onKakuyomu(workId: string): PostingLedger {
  return withSiteProfile(
    withSites(emptyPostingLedger(), [
      { site: "kakuyomu", newEpisodeUrl: `https://kakuyomu.jp/my/works/${workId}/episodes/new` },
    ]),
    "kakuyomu",
    { workId }
  );
}

function readOk(raw: Record<string, unknown>): ReaderStatsRanking {
  const read = parseRanking(raw);
  if (typeof read === "string") throw new Error(read);
  return read;
}

describe("束の rankings を読む", () => {
  test("取り決めの形の1件を読む", () => {
    const parsed = parseReaderStatsPaste(bundle([], [ranking()]));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.kind !== "bundle") throw new Error("束として読めていない");
    expect(parsed.bundle.items).toEqual([]);
    expect(parsed.bundle.rankings).toEqual([
      {
        position: 1,
        result: {
          ok: true,
          ranking: {
            site: "kakuyomu",
            workId: "1111",
            title: "星の庭",
            board: "rankings/fantasy/weekly/long",
            boardLabel: "週間異世界ファンタジーの長編ランキング",
            span: "weekly",
            genre: "異世界ファンタジー",
            rank: 12,
            date: "2026-11-02",
            readAt: "2026-11-02T12:03:00.000Z",
          },
        },
      },
    ]);
  });

  test("アルファポリスの1件（ヘルパー 0.19.0 の test/rankings.test.js と同じ形。ジャンルは無い）", () => {
    const read = parseRanking({
      site: "alphapolis",
      workId: "222222222",
      title: "架空の自分の題",
      board: "novel/ranking/hot",
      boardLabel: "HOTランキング",
      span: "24h",
      rank: 2,
      date: "2026-11-02",
      readAt: "2026-11-02T12:03:00.000Z",
    });
    expect(read).toMatchObject({ site: "alphapolis", board: "novel/ranking/hot", span: "24h", rank: 2 });
    expect(typeof read !== "string" && "genre" in read).toBe(false);
  });

  test.each([
    ["作品IDが無い", { workId: undefined }],
    ["作品IDが空", { workId: "  " }],
    ["区分が無い", { board: "" }],
    ["見出しが無い", { boardLabel: undefined }],
    ["知らない期間", { span: "hourly" }],
    ["0位", { rank: 0 }],
    ["小数の順位", { rank: 1.5 }],
    ["文字の順位", { rank: "3" }],
    ["日付の形が違う", { date: "2026/11/02" }],
    ["暦に無い日", { date: "2026-13-45" }],
    ["読んだ日時が読めない", { readAt: "きのう" }],
    ["知らないサイト", { site: "unknown" }],
    ["なろう本体（ヘルパーからは受けない）", { site: "narou" }],
    ["知らない読み取り元", { source: "somewhere" }],
  ])("読めない1件（%s）だけを捨て、束は断らない", (_name, overrides) => {
    const parsed = parseReaderStatsPaste(
      bundle([], [ranking({ board: "rankings/all/daily/long", boardLabel: "日間総合の長編ランキング" }), ranking(overrides)])
    );
    if (!parsed.ok || parsed.kind !== "bundle") throw new Error("束ごと断られた");
    const results = parsed.bundle.rankings ?? [];
    expect(results).toHaveLength(2);
    expect(results[0].result.ok).toBe(true);
    expect(results[1]).toMatchObject({ position: 2, result: { ok: false } });
  });

  test("作品名・ジャンルの形が違っても、順位そのものは落とさない（欄ごと捨てる）", () => {
    const read = readOk(ranking({ title: 5, genre: "" }));
    expect(read.title).toBeUndefined();
    expect(read.genre).toBeUndefined();
    expect(read.rank).toBe(12);
  });

  test("items が空でも、読める順位があれば受け取る", () => {
    const parsed = parseReaderStatsPaste(bundle([], [ranking()]));
    expect(parsed).toMatchObject({ ok: true, kind: "bundle" });
  });

  test("items が空で、順位も1件も読めなければ断る", () => {
    const parsed = parseReaderStatsPaste(bundle([], [ranking({ rank: -1 })]));
    expect(parsed).toEqual({ ok: false, reason: "まとめて渡された順位を、1件も読めませんでした。" });
  });

  test("items も rankings も空の束は、これまでどおり断る", () => {
    const parsed = parseReaderStatsPaste(bundle([]));
    expect(parsed).toEqual({
      ok: false,
      reason: "まとめて渡された読者の反応が、1件も入っていませんでした。",
    });
  });

  test("rankings が並びでなければ1件の失敗として残し、画面は読む", () => {
    const item = JSON.parse(
      buildReaderStatsEnvelope({
        site: "kakuyomu",
        workId: "1111",
        readAt: "2026-11-02T09:00:00.000+09:00",
        entries: [{ scope: "work", metrics: { pv: 10 } }],
      })
    );
    const parsed = parseReaderStatsPaste(bundle([item], { broken: true }));
    if (!parsed.ok || parsed.kind !== "bundle") throw new Error("束ごと断られた");
    expect(parsed.bundle.items).toHaveLength(1);
    expect(parsed.bundle.rankings).toEqual([
      { position: 1, result: { ok: false, reason: "順位の並びとして読めませんでした。" } },
    ]);
  });

  test("古い受け手との互換：rankings を持たない束は、これまでと同じ形で読める", () => {
    const item = JSON.parse(
      buildReaderStatsEnvelope({
        site: "kakuyomu",
        workId: "1111",
        readAt: "2026-11-02T09:00:00.000+09:00",
        entries: [{ scope: "work", metrics: { pv: 10 } }],
      })
    );
    const parsed = parseReaderStatsPaste(bundle([item]));
    if (!parsed.ok || parsed.kind !== "bundle") throw new Error("束として読めていない");
    expect(Object.keys(parsed.bundle).sort()).toEqual(["handedAt", "items"]);
  });
});

describe("台帳への積み方", () => {
  test("出どころ・区分・見出し・期間・ジャンルを持ち、日付の 0:00（日本時間）に置く", () => {
    expect(rankingRecordFromHelper(readOk(ranking()))).toEqual({
      site: "kakuyomu",
      recordedAt: "2026-11-02T00:00:00+09:00",
      board: "rankings/fantasy/weekly/long",
      rank: 12,
      note: "ヘルパーがランキングの画面から読み取り",
      source: "helper",
      boardLabel: "週間異世界ファンタジーの長編ランキング",
      span: "weekly",
      genre: "異世界ファンタジー",
    });
  });

  test("同じ鍵（サイト＋区分＋日付）は積まない——順位が違っても、束の中で重なっても", () => {
    const first = applyReaderStatsRankings(onKakuyomu("1111"), [
      readOk(ranking()),
      readOk(ranking({ rank: 9 })),
      readOk(ranking({ date: "2026-11-03", rank: 8 })),
    ]);
    expect(first.added).toBe(2);
    expect(first.repeated).toBe(1);
    expect(first.ledger.rankings.map((entry) => entry.rank)).toEqual([12, 8]);

    // 同じ束がもう一度届いても（呼び出しと貼り付けで2度）、増えない
    const again = applyReaderStatsRankings(first.ledger, [readOk(ranking())]);
    expect(again.added).toBe(0);
    expect(again.repeated).toBe(1);
  });

  test("手で記録した同じ日の順位とは別に積む（鍵の作りが違う）", () => {
    const manual = withRanking(onKakuyomu("1111"), {
      site: "kakuyomu",
      recordedAt: "2026-11-02T00:00:00+09:00",
      board: "rankings/fantasy/weekly/long",
      rank: 30,
    });
    const applied = applyReaderStatsRankings(manual, [readOk(ranking())]);
    expect(applied.added).toBe(1);
  });

  test("台帳を読み直しても、出どころと添え物が残る（印が落ちると手入力の顔になる）", () => {
    const applied = applyReaderStatsRankings(onKakuyomu("1111"), [readOk(ranking())]);
    const reread = readPostingLedger(JSON.parse(JSON.stringify(applied.ledger))).ledger;
    expect(reread.rankings).toEqual(applied.ledger.rankings);
  });

  test("古い台帳（手入力・API の順位だけ）はこれまでどおり読める。形の崩れた添え物は欄ごと読まない", () => {
    const raw = {
      ...onKakuyomu("1111"),
      rankings: [
        { site: "kakuyomu", recordedAt: "2026-10-01T12:00:00.000Z", board: "日間", rank: 40 },
        { site: "narou", recordedAt: "2026-10-01T00:00:00+09:00", board: "日間", rank: 5, source: "narou-api" },
        {
          site: "kakuyomu",
          recordedAt: "2026-10-02T00:00:00+09:00",
          board: "k:daily",
          rank: 3,
          source: "helper",
          boardLabel: 7,
          span: "hourly",
        },
      ],
    };
    const ledger = readPostingLedger(raw).ledger;
    expect(ledger.rankings).toEqual([
      { site: "kakuyomu", recordedAt: "2026-10-01T12:00:00.000Z", board: "日間", rank: 40 },
      { site: "narou", recordedAt: "2026-10-01T00:00:00+09:00", board: "日間", rank: 5, source: "narou-api" },
      { site: "kakuyomu", recordedAt: "2026-10-02T00:00:00+09:00", board: "k:daily", rank: 3, source: "helper" },
    ]);
  });

  test("ヘルパーの区分の鍵は、手で記録するときの種別の候補に出さない", () => {
    const applied = applyReaderStatsRankings(
      withRanking(onKakuyomu("1111"), {
        site: "kakuyomu",
        recordedAt: "2026-10-01T12:00:00.000Z",
        board: "日間",
        rank: 40,
      }),
      [readOk(ranking())]
    );
    expect(rankingBoards(applied.ledger, "kakuyomu")).toEqual(["日間"]);
  });
});

describe("作品の決め方（読者の反応の画面と同じ関所）", () => {
  test("台帳の作品IDで1つに決まる作品へ", () => {
    const route = routeReaderStatsRanking(readOk(ranking()), [
      { id: "a", ledger: onKakuyomu("1111") },
      { id: "b", ledger: onKakuyomu("2222") },
    ]);
    expect(route).toEqual({ kind: "work", id: "a" });
  });

  test("どの作品にも無い作品IDは決まらない（登録すれば直る印つき）", () => {
    const route = routeReaderStatsRanking(readOk(ranking({ workId: "9999" })), [
      { id: "a", ledger: onKakuyomu("1111") },
    ]);
    expect(route).toMatchObject({ kind: "none", registrable: true });
  });

  test("窓に戻ったとき、順位だけの束でも「まだ取り込んでいない順位」を数える", () => {
    const parsed = parseReaderStatsPaste(bundle([], [ranking(), ranking({ workId: "9999" })]));
    if (!parsed.ok || parsed.kind !== "bundle") throw new Error("束として読めていない");
    const ledger = onKakuyomu("1111");
    expect(readerStatsBundlePending(parsed.bundle, [{ id: "a", ledger }])).toEqual([
      { id: "a", screens: 0, ranks: 1 },
    ]);
    const done = applyReaderStatsRankings(ledger, [readOk(ranking())]).ledger;
    expect(readerStatsBundlePending(parsed.bundle, [{ id: "a", ledger: done }])).toEqual([]);
  });
});

describe("取り込みの知らせ", () => {
  test("画面と順位：「読者の反応 N画面と順位 M件を取り込みました」", () => {
    const notice = readerStatsBundleNotice({
      works: [{ title: "星の庭", screens: 2, added: 5, repeated: 0, ranks: 3, ranksRepeated: 0 }],
      failures: [],
    });
    expect(notice.level).toBe("info");
    expect(notice.message).toContain("読者の反応 2画面と順位 3件を取り込みました：「星の庭」2画面・順位3件。");
  });

  test("順位だけ：「順位 M件を取り込みました」（読者の反応と言わない）", () => {
    const notice = readerStatsBundleNotice({
      works: [{ title: "星の庭", screens: 0, added: 0, repeated: 0, ranks: 2, ranksRepeated: 0 }],
      failures: [],
      rankingsOnly: true,
    });
    expect(notice.message).toMatch(/^順位 2件を取り込みました：「星の庭」順位2件。/);
    expect(notice.message).not.toContain("読者の反応 ");
  });

  test("順位がすべて取り込み済みなら、変えていないと言う", () => {
    const notice = readerStatsBundleNotice({
      works: [{ title: "星の庭", screens: 0, added: 0, repeated: 0, ranks: 0, ranksRepeated: 2 }],
      failures: [],
      rankingsOnly: true,
    });
    expect(notice.message).toContain("順位は、すでに取り込んだものと同じでした：「星の庭」順位2件（2件）。記録は変えていません。");
  });

  test("順位だけで、どの作品にも決まらなければ、取り込めなかったと言う", () => {
    const notice = readerStatsBundleNotice({
      works: [],
      failures: [],
      rankingsOnly: true,
      ranksUnrouted: 2,
    });
    expect(notice.message).toContain("順位を取り込めませんでした。");
    expect(notice.message).toContain("どの作品のものか決まらなかった順位（2件）");
  });

  test("順位が絡まなければ、これまでの文のまま", () => {
    const notice = readerStatsBundleNotice({
      works: [{ title: "星の庭", screens: 2, added: 5, repeated: 1 }],
      failures: [],
    });
    expect(notice.message).toContain("読者の反応を取り込みました：「星の庭」2画面（同じ数で積まなかったもの 1件）。");
  });
});
