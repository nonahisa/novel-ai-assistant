import * as path from "path";
import { beforeEach, describe, expect, test } from "vitest";
import { READER_STATS_ENVELOPE_VERSION } from "../../../src/core/readerStatsEnvelope";
import { importReaderStats } from "../../../src/features/readerStats";
import { buildReaderCharts } from "../../../src/core/readerStatsCharts";
import {
  emptyPostingLedger,
  readPostingLedger,
  repeatsReaderStats,
  withReaderStats,
  type PostingLedger,
  type ReaderStatsRecord,
} from "../../../src/models/posting";
import type { WorkEntry } from "../../../src/models/types";
import { env, FileSystemError, Uri, window, workspace } from "../support/vscodeStub";

/**
 * カクヨムの直近30日の日ごとのPVを、取り込むたびに積み直さない
 * （作者の裁定 2026-09-23。Narou.fun の日ごとの増減と同じ「同じ数は積まない」形）。
 *
 * ヘルパー 0.5.0 以降は、カクヨムの作品管理ページのグラフから直近30日の日ごとの
 * PVを送る。カクヨムの封筒の記録の日時は「押した時刻」なので、取り込むたびに
 * 日時が違い、まったく同じ記録の見分けでは止まらない——毎回30件ずつ太っていた。
 *
 * 1. 同じ封筒を2度（押した時刻だけ違う）取り込んでも、日ごとの行は倍にならない
 * 2. 数が違う日（今日の数が伸びた）は積み、グラフは新しいほうを採る
 * 3. 既に積まれてしまった重複は消さない。グラフは新しいほうを採る
 *
 * 数字・作品IDはすべて架空。
 */

const workId = "16816927859";

/** 2026-08-24 から30日ぶん（09-22 まで）の日の見出し */
const DAYS: readonly string[] = Array.from({ length: 30 }, (_, index) => {
  const when = new Date(Date.UTC(2026, 7, 24 + index));
  return when.toISOString().slice(0, 10);
});

function dayRow(periodKey: string, pv: number): Record<string, unknown> {
  return { scope: "work", period: "day", periodKey, metrics: { pv } };
}

/** 30日ぶんの日ごとのPV。`override` の日だけ数を替える */
function dailyRows(override: Record<string, number> = {}): Record<string, unknown>[] {
  return DAYS.map((key, index) => dayRow(key, override[key] ?? index + 1));
}

/** ヘルパー 0.5.0 がカクヨムの作品管理ページから作る形（作品全体・日ごと・今月・話ごと） */
function kakuyomuEnvelope(
  readAt: string,
  days: Record<string, unknown>[] = dailyRows()
): string {
  return JSON.stringify({
    "novelai-stats": READER_STATS_ENVELOPE_VERSION,
    site: "kakuyomu",
    workId,
    readAt,
    entries: [
      { scope: "work", metrics: { pv: 5000, bookmarks: 40 } },
      ...days,
      { scope: "work", period: "month", periodKey: "2026-09", metrics: { pv: 667 } },
      { scope: "episode", episode: 1, metrics: { pv: 900 } },
      { scope: "episode", episode: 2, metrics: { pv: 600 } },
    ],
  });
}

const firstClick = "2026-09-22T03:00:00.000Z";
const secondClick = "2026-09-22T09:00:00.000Z";

/* ------------------------------------------------------------------ *
 * 判定（models/posting.ts の repeatsReaderStats）
 * ------------------------------------------------------------------ */

function kakuyomuDay(patch: Partial<ReaderStatsRecord>): ReaderStatsRecord {
  return {
    site: "kakuyomu",
    readAt: firstClick,
    scope: "work",
    period: "day",
    periodKey: "2026-09-20",
    metrics: { pv: 12 },
    source: "helper",
    ...patch,
  };
}

describe("判定：カクヨムの日ごとのPVも、いま見えている数と同じなら積まない", () => {
  test("押した時刻が違っても、その日のPVが同じなら繰り返し", () => {
    const ledger = withReaderStats(emptyPostingLedger(), kakuyomuDay({}));
    expect(repeatsReaderStats(ledger, kakuyomuDay({ readAt: secondClick }))).toBe(true);
  });

  test("PVが違えば繰り返しではない（積む）", () => {
    const ledger = withReaderStats(emptyPostingLedger(), kakuyomuDay({}));
    expect(
      repeatsReaderStats(ledger, kakuyomuDay({ readAt: secondClick, metrics: { pv: 13 } }))
    ).toBe(false);
  });

  test("比べる相手は、その日のいちばん新しい記録（グラフが採るもの）", () => {
    // 既に積まれた2件：古いほうが12、新しいほうが15
    let ledger = withReaderStats(emptyPostingLedger(), kakuyomuDay({}));
    ledger = withReaderStats(
      ledger,
      kakuyomuDay({ readAt: secondClick, metrics: { pv: 15 } })
    );
    const later = "2026-09-23T03:00:00.000Z";
    expect(repeatsReaderStats(ledger, kakuyomuDay({ readAt: later, metrics: { pv: 15 } }))).toBe(
      true
    );
    // いま見えているのは15なので、12が戻ってきたら「数え直し」として積む
    expect(repeatsReaderStats(ledger, kakuyomuDay({ readAt: later, metrics: { pv: 12 } }))).toBe(
      false
    );
  });

  test("サイトが違えば比べない（なろうの同じ日の数とは別の記録）", () => {
    const ledger = withReaderStats(emptyPostingLedger(), kakuyomuDay({}));
    expect(
      repeatsReaderStats(ledger, kakuyomuDay({ site: "narou", readAt: secondClick }))
    ).toBe(false);
  });

  test("その時点の値・今月の値は、これまでどおり日時が違えば積む（日ごとだけを変える）", () => {
    const snapshot = kakuyomuDay({ period: undefined, periodKey: undefined, metrics: { pv: 5000 } });
    const month = kakuyomuDay({ period: "month", periodKey: "2026-09", metrics: { pv: 667 } });
    const episode = kakuyomuDay({
      scope: "episode",
      episode: 1,
      period: undefined,
      periodKey: undefined,
      metrics: { pv: 900 },
    });
    for (const row of [snapshot, month, episode]) {
      const ledger = withReaderStats(emptyPostingLedger(), row);
      expect(repeatsReaderStats(ledger, { ...row, readAt: secondClick })).toBe(false);
      // まったく同じ記録（日時まで同じ）は、これまでどおり積まない
      expect(repeatsReaderStats(ledger, { ...row })).toBe(true);
    }
  });
});

/* ------------------------------------------------------------------ *
 * 取り込み（features/readerStats.ts の importReaderStats）
 * ------------------------------------------------------------------ */

const work: WorkEntry = {
  id: "work_kakuyomu_daily",
  title: "星を継ぐ者たち",
  folderPath: path.join("C:", "novels", "kakuyomu-daily"),
  registeredAt: "2026-09-23T00:00:00.000Z",
};

const ledgerPath = Uri.file(
  path.join(work.folderPath, "設定", "投稿状態.json")
).fsPath;

const disk = new Map<string, Uint8Array>();
const informed: string[] = [];
const warned: string[] = [];

function writeLedger(ledger: unknown): void {
  disk.set(ledgerPath, new TextEncoder().encode(`${JSON.stringify(ledger)}\n`));
}

function storedLedger(): PostingLedger {
  return readPostingLedger(
    JSON.parse(new TextDecoder().decode(disk.get(ledgerPath)!))
  ).ledger;
}

function dayRecords(): ReaderStatsRecord[] {
  return (storedLedger().readerStats ?? []).filter((row) => row.period === "day");
}

beforeEach(() => {
  disk.clear();
  informed.length = 0;
  warned.length = 0;
  env.clipboard.text = "";
  workspace.textDocuments = [];
  writeLedger({
    schemaVersion: "1",
    sites: [],
    siteProfiles: [{ site: "kakuyomu", workId }],
    posts: [],
    rankings: [],
  });
  workspace.fs = {
    createDirectory: async () => undefined,
    readFile: async (uri: { fsPath: string }) => {
      const bytes = disk.get(uri.fsPath);
      if (!bytes) throw new FileSystemError("missing", "FileNotFound");
      return bytes;
    },
    writeFile: async (uri: { fsPath: string }, bytes: Uint8Array) => {
      disk.set(uri.fsPath, bytes);
    },
    rename: async (
      from: { fsPath: string },
      to: { fsPath: string },
      options?: { overwrite?: boolean }
    ) => {
      const bytes = disk.get(from.fsPath);
      if (!bytes) throw new FileSystemError("missing", "FileNotFound");
      if (!options?.overwrite && disk.has(to.fsPath)) {
        throw new FileSystemError("exists", "FileExists");
      }
      disk.set(to.fsPath, bytes);
      disk.delete(from.fsPath);
    },
    delete: async (uri: { fsPath: string }) => {
      disk.delete(uri.fsPath);
    },
    stat: async (uri: { fsPath: string }) => {
      if (!disk.has(uri.fsPath)) {
        throw new FileSystemError("missing", "FileNotFound");
      }
      return { type: 1, ctime: 0, mtime: 0, size: 0 };
    },
  } as unknown as typeof workspace.fs;
  Object.assign(window, {
    showQuickPick: async () => undefined,
    showInputBox: async () => undefined,
    showInformationMessage: async (message: string) => {
      informed.push(message);
      return undefined;
    },
    showWarningMessage: async (message: string) => {
      warned.push(message);
      return undefined;
    },
    showErrorMessage: async (message: string) => {
      warned.push(message);
      return undefined;
    },
  });
});

describe("取り込み：カクヨムの直近30日の日ごとのPV", () => {
  test("1回目は30日ぶんがそのまま入る", async () => {
    env.clipboard.text = kakuyomuEnvelope(firstClick);
    const result = await importReaderStats(work);

    expect(warned).toEqual([]);
    expect(result.changed).toBe(true);
    expect(dayRecords()).toHaveLength(30);
  });

  test("同じ数の封筒を、押した時刻だけ違えて2度取り込んでも、日ごとは倍にならない", async () => {
    env.clipboard.text = kakuyomuEnvelope(firstClick);
    await importReaderStats(work);
    env.clipboard.text = kakuyomuEnvelope(secondClick);
    const second = await importReaderStats(work);

    expect(warned).toEqual([]);
    expect(dayRecords()).toHaveLength(30);
    // 日ごとの30件は積まず、その時点・今月・話ごと（押した時刻が違う）は、これまでどおり積む
    expect(second.changed).toBe(true);
    expect(informed.at(-1)).toContain("30件は、取り込み済みの数と同じ");
    expect(informed.at(-1)).toContain("4件 取り込みました");
  });

  test("数が違う日（今日のPVが伸びた）は積み、グラフは新しいほうを採る", async () => {
    env.clipboard.text = kakuyomuEnvelope(firstClick);
    await importReaderStats(work);
    const today = DAYS[DAYS.length - 1];
    env.clipboard.text = kakuyomuEnvelope(secondClick, dailyRows({ [today]: 99 }));
    await importReaderStats(work);

    const days = dayRecords();
    expect(days).toHaveLength(31);
    expect(days.filter((row) => row.periodKey === today)).toHaveLength(2);
    expect(informed.at(-1)).toContain("29件は");
    const chart = buildReaderCharts(storedLedger().readerStats ?? [], null).day;
    expect(chart?.points.find((point) => point.key === today)?.value).toBe(99);
    expect(chart?.points).toHaveLength(30);
  });

  test("翌日の取り込みでは、重なった29日は積まず、新しい1日だけを足す", async () => {
    env.clipboard.text = kakuyomuEnvelope(firstClick);
    await importReaderStats(work);
    const shifted = [
      ...dailyRows().slice(1),
      dayRow("2026-09-23", 31),
    ];
    env.clipboard.text = kakuyomuEnvelope("2026-09-23T03:00:00.000Z", shifted);
    await importReaderStats(work);

    expect(dayRecords()).toHaveLength(31);
    expect(dayRecords().filter((row) => row.periodKey === "2026-09-23")).toHaveLength(1);
  });

  test("既に積まれてしまった重複は消さず、グラフは日ごとに新しいほうを採る", async () => {
    // 直す前の版で2度取り込んだ台帳（同じ30日が2回。2回目は今日だけ伸びている）
    const today = DAYS[DAYS.length - 1];
    const stacked = [
      ...dailyRows().map((row) => ({ ...row, readAt: firstClick, source: "helper" })),
      ...dailyRows({ [today]: 50 }).map((row) => ({
        ...row,
        readAt: secondClick,
        source: "helper",
      })),
    ].map((row) => ({ site: "kakuyomu", ...row }));
    writeLedger({
      schemaVersion: "1",
      sites: [],
      siteProfiles: [{ site: "kakuyomu", workId }],
      posts: [],
      rankings: [],
      readerStats: stacked,
    });

    // 3度目：今日は50のまま、ほかの日も同じ
    env.clipboard.text = kakuyomuEnvelope(
      "2026-09-22T12:00:00.000Z",
      dailyRows({ [today]: 50 })
    );
    await importReaderStats(work);

    // 60件は1件も減らず、3度目の30日は1件も足さない
    expect(dayRecords()).toHaveLength(60);
    const chart = buildReaderCharts(storedLedger().readerStats ?? [], null).day;
    expect(chart?.points).toHaveLength(30);
    expect(chart?.points.find((point) => point.key === today)?.value).toBe(50);
    // 足し合わせない（重なった日が2倍に見えない）
    expect(chart?.points.find((point) => point.key === DAYS[0])?.value).toBe(1);
  });
});
