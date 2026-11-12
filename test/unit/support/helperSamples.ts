import {
  buildReaderStatsEnvelope,
  READER_STATS_BUNDLE_KIND,
  READER_STATS_BUNDLE_VERSION,
  type ReaderStatsEnvelopeEntry,
} from "../../../src/core/readerStatsEnvelope";

/**
 * ヘルパー（統合小説執筆環境ヘルパー）が「まとめて渡す」で置く束の見本（単体テストと画面の自動テストで共有）。
 *
 * 形は、ヘルパーの `common/stash.js` の `makeBundle` と、`test/readEnvelope.test.js` が固定している
 * 封筒の形（2026-11-01 のなろうファンDB リニューアル後。ヘルパー 0.14.2 以降）に合わせた。
 * **数字・作品名・作品IDはすべて架空。**
 *
 * - Narou.fun：作品IDは小文字のNコード、記録の日時は「データ取得」の日の 0:00（日本時間）で
 *   `readAtBasis: "fetched"`、日ごとの表は前の日との差（ブクマが外された日は負の数）
 * - カクヨム：作品管理の1画面（全話ぶんの更新日つき）とアクセス数の画面（50話ずつ。更新日なし）
 *
 * 製品の組み立て（`buildReaderStatsEnvelope`）をそのまま使う——見本の形を試験の側で写すと、
 * 取り決めが変わったときに片方だけ古くなる。
 */

/** 日本時間の ISO（時差つき）。ヘルパーが話の更新日に書く形 */
export function jstIso(ms: number): string {
  const shifted = new Date(ms + 9 * 60 * 60 * 1000);
  return `${shifted.toISOString().slice(0, 19)}+09:00`;
}

/** 日本時間の暦日（YYYY-MM-DD）から `offset` 日ずらした日付 */
export function jstDay(base: string, offset: number): string {
  const time = Date.parse(`${base}T00:00:00+09:00`) + offset * 24 * 60 * 60 * 1000;
  return jstIso(time).slice(0, 10);
}

/* ────────────── Narou.fun ────────────── */

export const NAROU_FUN_NCODE = "n1234ab";
/** 別の方の作品（台帳に無いNコード） */
export const NAROU_FUN_OTHERS_NCODE = "n9999zz";
/** 「データ取得 2026/10/31」の 0:00（日本時間） */
export const NAROU_FUN_FETCHED_AT = "2026-10-30T15:00:00.000Z";
/** 日ごとの表の最初の日（27日ぶん。最後は 10/30） */
export const NAROU_FUN_FIRST_DAY = "2026-10-04";

/** 日ごとのブクマの増減（27日。外された日は負の数） */
export const NAROU_FUN_BOOKMARK_DELTAS: readonly number[] = [
  2, 1, 0, 3, 1, 0, 1, 2, -2, 0, 1, 1, 0, 2, 1, -1, 0, 3, 1, 0, 2, 1, 0, 1, -1, 2, 1,
];
/** 日ごとの評価ポイントの増減（27日） */
export const NAROU_FUN_RATING_DELTAS: readonly number[] = [
  0, 2, 0, 6, 0, 0, 2, 0, 0, 0, 2, 0, 0, 0, 4, 0, 0, 2, 0, 0, 0, 2, 0, 0, 0, 4, 0,
];

/** 作品全体の1行（ヘルパーが作品ページから読む7つの数） */
export const NAROU_FUN_WORK_METRICS = {
  points: 1200,
  bookmarks: 300,
  comments: 12,
  reviews: 1,
  narou_ratingPoints: 600,
  narou_raters: 70,
  narou_weeklyReaders: 45,
} as const;

/**
 * Narou.fun の作品ページから組んだ封筒（オブジェクト）。
 * `shiftDays` は、あくる日以降に読み直した形（データ取得の日が進み、日ごとの表が1日ぶんずれる）
 */
export function narouFunHelperEnvelope(
  options: { ncode?: string; shiftDays?: number; tags?: readonly string[] } = {}
): Record<string, unknown> {
  const shift = options.shiftDays ?? 0;
  // ずらした読み直しでは、日付も数の並びも同じ分だけずれる（重なる日の数は同じ。締まった日の数は変わらない）
  const rows: ReaderStatsEnvelopeEntry[] = [];
  for (let index = 0; index < NAROU_FUN_BOOKMARK_DELTAS.length; index++) {
    rows.push({
      scope: "work",
      period: "day",
      periodKey: jstDay(NAROU_FUN_FIRST_DAY, index + shift),
      metrics: {
        bookmarks: NAROU_FUN_BOOKMARK_DELTAS[index + shift] ?? 1,
        narou_ratingPoints: NAROU_FUN_RATING_DELTAS[index + shift] ?? 0,
      },
    });
  }
  const fetchedAt = new Date(Date.parse(NAROU_FUN_FETCHED_AT) + shift * 24 * 60 * 60 * 1000).toISOString();
  return JSON.parse(
    buildReaderStatsEnvelope({
      site: "narou",
      source: "narou.fun",
      workId: options.ncode ?? NAROU_FUN_NCODE,
      readAt: fetchedAt,
      readAtBasis: "fetched",
      title: "星を継ぐ者たち",
      tags: options.tags ?? ["異世界", "魔法"],
      completion: "ongoing",
      entries: [{ scope: "work", metrics: { ...NAROU_FUN_WORK_METRICS } }, ...rows],
    })
  ) as Record<string, unknown>;
}

/* ────────────── カクヨム ────────────── */

export const KAKUYOMU_WORK_ID = "16816927861924296900";
/** 作品管理を読んだ時刻（日本時間） */
export const KAKUYOMU_MANAGEMENT_READ_AT = "2026-10-31T10:00:00+09:00";
/** 見本の話数（アクセス数は50話ずつなので、7ページ目は20話） */
export const KAKUYOMU_EPISODES = 320;
export const KAKUYOMU_ACCESS_PAGE_SIZE = 50;
export const KAKUYOMU_ACCESS_PAGES = Math.ceil(KAKUYOMU_EPISODES / KAKUYOMU_ACCESS_PAGE_SIZE);

/** 作品管理で読む第n話のPV */
export function kakuyomuManagementPv(episode: number): number {
  return 4000 - episode * 10;
}

/** アクセス数の画面で読む第n話のPV（作品管理の少しあとなので、数が増えている） */
export function kakuyomuAccessPv(episode: number): number {
  return kakuyomuManagementPv(episode) + 5;
}

/** 作品管理を読んだ時点から、最後の2話だけは更新から72時間たっていない */
export function kakuyomuUpdatedAt(episode: number): string {
  const read = Date.parse(KAKUYOMU_MANAGEMENT_READ_AT);
  return episode >= KAKUYOMU_EPISODES - 1
    ? jstIso(read - 4 * 60 * 60 * 1000)
    : jstIso(Date.parse("2026-08-01T12:00:00+09:00") + episode * 3 * 60 * 60 * 1000);
}

/** カクヨムの作品管理（全話ぶん・更新日つき・直近30日のPV・今月のPV）の封筒 */
export function kakuyomuManagementEnvelope(
  options: { workId?: string; readAt?: string; withFacts?: boolean } = {}
): Record<string, unknown> {
  const entries: ReaderStatsEnvelopeEntry[] = [
    { scope: "work", metrics: { pv: 150000, bookmarks: 820, points: 1500, reviews: 60, likes: 4000, comments: 300 } },
  ];
  for (let index = 0; index < 30; index++) {
    entries.push({
      scope: "work",
      period: "day",
      periodKey: jstDay("2026-10-02", index),
      metrics: { pv: 400 + index * 3 },
    });
  }
  entries.push({ scope: "work", period: "month", periodKey: "2026-10", metrics: { pv: 12500 } });
  for (let episode = 1; episode <= KAKUYOMU_EPISODES; episode++) {
    entries.push({
      scope: "episode",
      episode,
      metrics: { pv: kakuyomuManagementPv(episode), likes: Math.max(0, 30 - Math.floor(episode / 12)) },
      updatedAt: kakuyomuUpdatedAt(episode),
    });
  }
  return JSON.parse(
    buildReaderStatsEnvelope({
      site: "kakuyomu",
      workId: options.workId ?? KAKUYOMU_WORK_ID,
      readAt: options.readAt ?? KAKUYOMU_MANAGEMENT_READ_AT,
      title: "架空の自分の題",
      ...(options.withFacts === false ? {} : { tags: ["異世界", "学園"], completion: "ongoing" as const }),
      entries,
    })
  ) as Record<string, unknown>;
}

/** アクセス数の `page` ページ目（1から）の封筒。更新日は無く、タグも無い */
export function kakuyomuAccessEnvelope(
  page: number,
  options: { workId?: string; readAt?: string } = {}
): Record<string, unknown> {
  const first = (page - 1) * KAKUYOMU_ACCESS_PAGE_SIZE + 1;
  const last = Math.min(page * KAKUYOMU_ACCESS_PAGE_SIZE, KAKUYOMU_EPISODES);
  const entries: ReaderStatsEnvelopeEntry[] = [];
  for (let episode = first; episode <= last; episode++) {
    entries.push({ scope: "episode", episode, metrics: { pv: kakuyomuAccessPv(episode) } });
  }
  // 画面ごとに数分ずつあとに読む（溜めた順＝読んだ順）
  const readAt =
    options.readAt ?? jstIso(Date.parse(KAKUYOMU_MANAGEMENT_READ_AT) + page * 60 * 1000);
  return JSON.parse(
    buildReaderStatsEnvelope({
      site: "kakuyomu",
      workId: options.workId ?? KAKUYOMU_WORK_ID,
      readAt,
      title: "架空の自分の題",
      entries,
    })
  ) as Record<string, unknown>;
}

/* ────────────── 束 ────────────── */

/**
 * 束の文字列（ヘルパーの `makeBundle` と同じ形）。**`ownedVia` は1件ずつへ添える**
 * （覚えた理由。管理画面で覚えたら "owner-page"、作者が「覚える」と答えたら "approved"）
 */
export function helperBundle(
  items: readonly Record<string, unknown>[],
  options: { handedAt?: string; ownedVia?: "owner-page" | "approved" } = {}
): string {
  return JSON.stringify({
    kind: READER_STATS_BUNDLE_KIND,
    version: READER_STATS_BUNDLE_VERSION,
    handedAt: options.handedAt ?? "2026-10-31T01:30:00.000Z",
    items: options.ownedVia ? items.map((item) => ({ ...item, ownedVia: options.ownedVia })) : items,
  });
}

/** 束の中の封筒たちの行の数の合計 */
export function entryCount(items: readonly Record<string, unknown>[]): number {
  return items.reduce((sum, item) => sum + (item.entries as unknown[]).length, 0);
}

/**
 * 実機で見つかった「8画面が作品1つにまとまった形」の見本。内訳は記録に残っていないので、
 * 作品管理 1画面＋アクセス数 7ページ（320話。50話ずつ）とした（溜めた順＝読んだ順）
 */
export function eightScreenItems(): Record<string, unknown>[] {
  const items: Record<string, unknown>[] = [kakuyomuManagementEnvelope()];
  for (let page = 1; page <= KAKUYOMU_ACCESS_PAGES; page++) items.push(kakuyomuAccessEnvelope(page));
  return items;
}
