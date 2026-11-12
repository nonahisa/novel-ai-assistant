import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { computeReaderRates, type ReaderRate, type ReaderRates } from "../../../src/core/readerRates";
import { buildReaderCharts } from "../../../src/core/readerStatsCharts";
import {
  applyReaderStatsEnvelope,
  parseReaderStatsPaste,
  type ReaderStatsEnvelope,
} from "../../../src/core/readerStatsEnvelope";
import { type PostingLedger, type ReaderStatsRecord } from "../../../src/models/posting";
import { onKakuyomu, onNarou } from "../support/helperHandoverHarness";
import {
  eightScreenItems,
  helperBundle,
  jstIso,
  kakuyomuAccessEnvelope,
  kakuyomuAccessPv,
  kakuyomuManagementEnvelope,
  KAKUYOMU_EPISODES,
  KAKUYOMU_MANAGEMENT_READ_AT,
  KAKUYOMU_WORK_ID,
  narouFunHelperEnvelope,
  NAROU_FUN_NCODE,
  NAROU_FUN_WORK_METRICS,
} from "../support/helperSamples";

/**
 * ヘルパーの「集計」（説明のページの「いまの数」「日ごとの数」「3つの率」。ヘルパーの `common/history.js`）と、
 * 受け手の計算（`readerRates.ts`・`readerStatsCharts.ts`）が、**同じ束から同じ数を出すか**
 * （ヘルパーの実機確認リスト 0.10.0「記録と集計：率の『実際の数』が、統合小説執筆環境の同じ作品の率と同じか」）。
 *
 * ヘルパー側の既存の突き合わせ（ヘルパーの `test/history.test.js`）は、封筒を受け手の**読み口**へ通して
 * 率の式だけを比べる。ここは **受け手の取り込み（`parseReaderStatsPaste` → `applyReaderStatsEnvelope`。
 * 台帳の「同じ数は積まない」を通る）を経た記録**から出した数を、ヘルパーが同じ封筒を `recordEnvelope` で
 * 畳んで出した数と比べる。取り込みの途中で行が積まれ過ぎたり抜けたりして率が化ければ、ここで見つかる。
 *
 * **ヘルパーのリポジトリは読むだけ**。見つからない環境（CI など）では突き合わせの組だけを飛ばし、
 * 固定の期待値（手で計算した数）の組は必ず走る。場所は環境変数 `NOVELAI_POST_HELPER_DIR`、無ければ
 * 親フォルダーをたどって `novel-post-helper` を探す（作業場は `.claude/worktrees` の下にあり、「隣」ではない）。
 */

/* ────────────── ヘルパーの集計を読み込む ────────────── */

function findHelperDir(): string | undefined {
  const fromEnv = process.env.NOVELAI_POST_HELPER_DIR;
  if (fromEnv && existsSync(path.join(fromEnv, "common", "history.js"))) return fromEnv;
  let folder = path.dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 12; depth++) {
    const candidate = path.join(folder, "novel-post-helper");
    if (existsSync(path.join(candidate, "common", "history.js"))) return candidate;
    const parent = path.dirname(folder);
    if (parent === folder) break;
    folder = parent;
  }
  return undefined;
}

interface HelperRate {
  label: string;
  formula: string;
  value?: number;
  percent?: string;
  expression?: string;
  missing?: string;
  operands: Array<{ label: string; value: number; readAt?: string }>;
}

interface HelperRates {
  episodeReadAt: string | null;
  base: { episode: number; pv?: number; updatedAt: string; updatedReadAt: string } | null;
  baseMissing?: string;
  dropout: HelperRate;
  bookmark: HelperRate;
  rating: HelperRate;
}

interface HelperWork {
  site: string;
  latest: Record<string, { value: number; readAt: string }>;
  daily: Record<string, { at: string; metrics: Record<string, number> }>;
  monthly: Record<string, { at: string; metrics: Record<string, number> }>;
}

interface HelperHistory {
  works: HelperWork[];
}

interface HelperHistoryApi {
  emptyHistory(): HelperHistory;
  recordEnvelope(
    history: HelperHistory,
    envelope: Record<string, unknown>,
    siteId: string,
    workId: string,
    now: Date
  ): HelperHistory;
  computeRates(work: HelperWork): HelperRates;
}

const helperDir = findHelperDir();
const History: HelperHistoryApi | undefined = helperDir
  ? (createRequire(import.meta.url)(path.join(helperDir, "common", "history.js")) as HelperHistoryApi)
  : undefined;

/* ────────────── 受け手の計算（取り込みを通した記録から） ────────────── */

interface ReceivedWork {
  readonly ledger: PostingLedger;
  readonly records: ReaderStatsRecord[];
}

/** 束の文字列を、受け手が束を取り込むのと同じ順（溜めた順）に、同じ台帳へ積む */
function receive(bundleText: string, start: PostingLedger, site: "kakuyomu" | "narou"): ReceivedWork {
  const parsed = parseReaderStatsPaste(bundleText);
  if (!parsed.ok || parsed.kind !== "bundle") throw new Error("束として読めませんでした");
  let ledger = start;
  for (const item of parsed.bundle.items) {
    if (!item.result.ok) throw new Error(`${item.position}件目が読めません：${item.result.reason}`);
    ledger = applyReaderStatsEnvelope(ledger, item.result.envelope as ReaderStatsEnvelope).ledger;
  }
  return { ledger, records: (ledger.readerStats ?? []).filter((row) => row.site === site) };
}

/** ヘルパーが同じ束の封筒を、溜めた順に記録へ畳む（`siteId` はヘルパーの表の id） */
function recordInHelper(
  bundleText: string,
  siteId: "kakuyomu" | "narouFun",
  workId: string
): HelperWork {
  if (!History) throw new Error("ヘルパーが見つかりません");
  const bundle = JSON.parse(bundleText) as { items: Array<Record<string, unknown>>; handedAt: string };
  let history = History.emptyHistory();
  for (const item of bundle.items) {
    history = History.recordEnvelope(history, item, siteId, workId, new Date(bundle.handedAt));
  }
  const found = history.works[0];
  if (!found) throw new Error("ヘルパーの記録に作品がありません");
  return found;
}

/** 日時は書き方でなく時刻で比べる（ヘルパーの `test/history.test.js` の `比べる形` と同じ） */
function rateShape(rate: ReaderRate | HelperRate): unknown {
  return {
    label: rate.label,
    formula: rate.formula,
    value: rate.value,
    percent: rate.percent,
    expression: rate.expression,
    missing: rate.missing,
    operands: rate.operands.map((operand) => ({
      label: operand.label,
      value: operand.value,
      readAt: operand.readAt ? Date.parse(operand.readAt) : undefined,
    })),
  };
}

function ratesShape(rates: ReaderRates | HelperRates): unknown {
  return {
    episodeReadAt: rates.episodeReadAt ? Date.parse(rates.episodeReadAt) : null,
    base: rates.base
      ? {
          episode: rates.base.episode,
          pv: rates.base.pv,
          updatedAt: Date.parse(rates.base.updatedAt),
          updatedReadAt: Date.parse(rates.base.updatedReadAt),
        }
      : null,
    baseMissing: rates.baseMissing,
    dropout: rateShape(rates.dropout),
    bookmark: rateShape(rates.bookmark),
    rating: rateShape(rates.rating),
  };
}

/** 受け手の「いまの数」：欄ごとに、作品全体の行（期間なし）のうち読み取り日時がいちばん新しい値 */
function receiverLatest(records: readonly ReaderStatsRecord[]): Record<string, number> {
  const newest = new Map<string, { time: number; value: number }>();
  for (const record of records) {
    if (record.scope !== "work" || record.period !== undefined) continue;
    const time = Date.parse(record.readAt);
    for (const [key, value] of Object.entries(record.metrics)) {
      const found = newest.get(key);
      if (value !== undefined && (!found || time >= found.time)) newest.set(key, { time, value });
    }
  }
  return Object.fromEntries([...newest].map(([key, entry]) => [key, entry.value]));
}

/* ────────────── 場面 ────────────── */

const kakuyomuStart = (): PostingLedger => onKakuyomu(KAKUYOMU_WORK_ID);
const narouStart = (): PostingLedger => onNarou(NAROU_FUN_NCODE);

/** 作品管理＋アクセス数の1〜2ページ目を、数分おいて2回に分けて渡した形（実際は2つの束。ここは1つの流れ） */
function incrementalItems(): Record<string, unknown>[] {
  const later = jstIso(Date.parse(KAKUYOMU_MANAGEMENT_READ_AT) + 3 * 60 * 60 * 1000);
  return [
    kakuyomuManagementEnvelope(),
    kakuyomuAccessEnvelope(1),
    kakuyomuAccessEnvelope(2),
    // 3時間あとに読み直した1ページ目（数は同じ）
    kakuyomuAccessEnvelope(1, { readAt: later }),
  ];
}

const scenes: Record<string, { bundle: string; start: () => PostingLedger; site: "kakuyomu" | "narou"; helperSite: "kakuyomu" | "narouFun"; workId: string }> = {
  "カクヨム：作品管理1＋アクセス数7ページ（8画面）": {
    bundle: helperBundle(eightScreenItems(), { ownedVia: "owner-page" }),
    start: kakuyomuStart,
    site: "kakuyomu",
    helperSite: "kakuyomu",
    workId: KAKUYOMU_WORK_ID,
  },
  "カクヨム：作品管理のあとアクセス数を足し、1ページ目を読み直した": {
    bundle: helperBundle(incrementalItems(), { ownedVia: "owner-page" }),
    start: kakuyomuStart,
    site: "kakuyomu",
    helperSite: "kakuyomu",
    workId: KAKUYOMU_WORK_ID,
  },
  "なろう（Narou.fun）：データ取得の日が2日ぶん（日ごとの表が1日ずれて重なる）": {
    bundle: helperBundle([narouFunHelperEnvelope(), narouFunHelperEnvelope({ shiftDays: 1 })], { ownedVia: "approved" }),
    start: narouStart,
    site: "narou",
    helperSite: "narouFun",
    workId: NAROU_FUN_NCODE,
  },
};

/* ────────────── 固定の期待値（ヘルパーが無くても走る） ────────────── */

describe("手で計算した数と同じになる（受け手の側）", () => {
  test("8画面：率は第1話のPV（アクセス数の数）で割る。基準は更新から72時間たった最後の話（第217話）", () => {
    const scene = scenes["カクヨム：作品管理1＋アクセス数7ページ（8画面）"];
    const received = receive(scene.bundle, scene.start(), scene.site);
    const rates = computeReaderRates(received.records);

    const first = kakuyomuAccessPv(1); // 3995
    const base = kakuyomuAccessPv(KAKUYOMU_EPISODES - 2); // 第217話
    expect(first).toBe(3995);
    expect(rates.base?.episode).toBe(217);
    expect(rates.dropout.operands.map((operand) => operand.value)).toEqual([base, first]);
    expect(rates.dropout.value).toBeCloseTo(1 - base / first, 10);
    // ブックマーク率 = 820 ÷ 3,995、評価率 = 60 ÷ 3,995（作品管理の作品全体の数）
    expect(rates.bookmark.percent).toBe(`${((820 / first) * 100).toFixed(1)}%`);
    expect(rates.rating.percent).toBe(`${((60 / first) * 100).toFixed(1)}%`);
    // いまの数は作品管理の作品全体の行
    expect(receiverLatest(received.records)).toMatchObject({
      pv: 150000,
      bookmarks: 820,
      points: 1500,
      reviews: 60,
      likes: 4000,
      comments: 300,
    });
  });

  test("Narou.fun：評価率は評価者数で割る。話ごとのPVが無いので、率は出さずに理由を言う（話ごとの記録が1件も無い）", () => {
    const scene = scenes["なろう（Narou.fun）：データ取得の日が2日ぶん（日ごとの表が1日ずれて重なる）"];
    const received = receive(scene.bundle, scene.start(), scene.site);
    const rates = computeReaderRates(received.records);

    expect(rates.bookmark.missing).toBe("話ごとの記録がありません");
    expect(rates.rating.missing).toBe("話ごとの記録がありません");
    expect(rates.rating.operands[0]).toMatchObject({ value: NAROU_FUN_WORK_METRICS.narou_raters });
    expect(rates.rating.operands[0].label).toContain("評価者数");
    expect(receiverLatest(received.records)).toMatchObject({ bookmarks: 300, narou_raters: 70 });
    // 日ごとのブックマークの増減：重なった日は1日1つ、27日＋ずれた1日
    const bookmarks = buildReaderCharts(received.records, null).changes.find(
      (chart) => chart.metric === "bookmarks" && chart.period === "day"
    );
    expect(bookmarks?.points).toHaveLength(28);
  });
});

/* ────────────── ヘルパーの集計との突き合わせ ────────────── */

describe.skipIf(!History)("ヘルパーの集計（common/history.js）と同じ数になる", () => {
  test.each(Object.keys(scenes))("%s", (name) => {
    const scene = scenes[name];
    const received = receive(scene.bundle, scene.start(), scene.site);
    const helperWork = recordInHelper(scene.bundle, scene.helperSite, scene.workId);

    // 3つの率（式・数・実際の数の式・材料の日時・出せない理由まで）。
    // 両方が「出せない」で一致しただけにならないよう、カクヨムの場面は率が実際に出ていることも見る
    if (scene.site === "kakuyomu") {
      const mine = computeReaderRates(received.records);
      expect([mine.dropout.value, mine.bookmark.value, mine.rating.value].every((value) => value !== undefined)).toBe(true);
    }
    expect(ratesShape(computeReaderRates(received.records))).toEqual(
      ratesShape((History as HelperHistoryApi).computeRates(helperWork))
    );

    // いまの数：ヘルパーの「いまの数」（欄ごとの最新）と、受け手の作品全体の最新
    const mine = receiverLatest(received.records);
    for (const [key, entry] of Object.entries(helperWork.latest)) {
      expect(mine[key], `いまの数「${key}」`).toBe(entry.value);
    }

    // 日ごとの数：ヘルパーの daily（日付→数）と、受け手のグラフの日ごとの点
    const charts = buildReaderCharts(received.records, null);
    const helperDaily = Object.entries(helperWork.daily);
    if (scene.site === "kakuyomu") {
      const pointOf = new Map(charts.day?.points.map((point) => [point.key, point.value]));
      for (const [date, entry] of helperDaily) expect(pointOf.get(date), `日ごとのPV ${date}`).toBe(entry.metrics.pv);
      expect(charts.day?.points).toHaveLength(helperDaily.length);
    } else {
      const bookmarks = charts.changes.find((chart) => chart.metric === "bookmarks" && chart.period === "day");
      const pointOf = new Map(bookmarks?.points.map((point) => [point.key, point.value]));
      for (const [date, entry] of helperDaily) expect(pointOf.get(date), `日ごとのブクマの増減 ${date}`).toBe(entry.metrics.bookmarks);
      expect(bookmarks?.points).toHaveLength(helperDaily.length);
    }

    // 月ごとの数（カクヨムの今月のPV）
    if (scene.site === "kakuyomu") {
      const monthly = Object.entries(helperWork.monthly);
      const month = charts.month?.points ?? [];
      for (const [key, entry] of monthly) {
        expect(month.find((point) => point.key === key)?.value, `月ごとのPV ${key}`).toBe(entry.metrics.pv);
      }
    }
  });

  test("束の見本は、ヘルパーの makeBundle が作る形（kind・version・items・handedAt）と同じ", () => {
    const stashPath = path.join(helperDir as string, "common", "stash.js");
    const Stash = createRequire(import.meta.url)(stashPath) as {
      makeBundle(
        items: Array<{ key: string; storedAt: string; siteId: string; workId: string; envelope: Record<string, unknown> }>,
        now: Date,
        ownWorks: Array<{ siteId: string; workId: string; how: string }>
      ): Record<string, unknown>;
    };
    const items = eightScreenItems();
    const made = Stash.makeBundle(
      items.map((envelope, index) => ({
        key: `kakuyomu|${index === 0 ? "work" : "accesses"}|${KAKUYOMU_WORK_ID}|${index}`,
        storedAt: new Date(Date.parse("2026-10-31T01:00:00.000Z") + index * 1000).toISOString(),
        siteId: "kakuyomu",
        workId: KAKUYOMU_WORK_ID,
        envelope,
      })),
      new Date("2026-10-31T01:30:00.000Z"),
      [{ siteId: "kakuyomu", workId: KAKUYOMU_WORK_ID, how: "owner-page" }]
    );
    // 見本（helperBundle）と、本物の束の作り手が同じ形になる
    expect(JSON.parse(helperBundle(items, { ownedVia: "owner-page" }))).toEqual(made);
  });
});
