import * as path from "path";
import { beforeEach, describe, expect, test } from "vitest";
import {
  buildReaderStatsEnvelope,
  parseReaderStatsEnvelope,
  READER_STATS_ENVELOPE_VERSION,
} from "../../../src/core/readerStatsEnvelope";
import { importReaderStats } from "../../../src/features/readerStats";
import { computeReaderRates } from "../../../src/core/readerRates";
import {
  buildReaderCharts,
  type ReaderCharts,
} from "../../../src/core/readerStatsCharts";
import {
  emptyPostingLedger,
  readerStatsMetricInfo,
  readPostingLedger,
  validateReaderStatsValue,
  withReaderStats,
  type PostingLedger,
  type ReaderStatsRecord,
} from "../../../src/models/posting";
import { buildWritingStatsPanelHtml } from "../../../src/views/writingStatsPanelHtml";
import type { WorkEntry } from "../../../src/models/types";
import { env, FileSystemError, Uri, window, workspace } from "../support/vscodeStub";

/**
 * Narou.fun の日ごとのブクマと評価の表を、日ごとの増減として受ける
 * （残課題 B11 の続き。作者の裁定 2026-09-23）。
 *
 * 1. 表の累計の**前の日との差**を、その日の数（日別）として持つ。**負の日も残す**
 *    ——台帳は「日別の増減の欄（ブックマーク・評価ポイント）」だけ負を受ける。
 *    ほかの欄（PV・評価者数…）と、日別でない行の検査は緩めない
 * 2. 記録の日時は、Narou.fun の「最終取得日時」。読めなかった封筒は押した時刻で、
 *    そうと分かる印（readAtBasis）がメモに残る
 * 3. グラフに日ごとの増減が載る。減った日は0の線より下
 * 4. 同じ表を2度取り込んでも、二重に積まない
 *
 * 数字・Nコードはすべて架空。
 */

const fetchedAt = "2026-09-21T16:26:00.000Z"; // 最終取得日時 2026/09/22 01:26（日本時間）

function dayRow(
  periodKey: string,
  metrics: Record<string, number>
): Record<string, unknown> {
  return { scope: "work", period: "day", periodKey, metrics };
}

/** 貼り込み係 0.7.0 が Narou.fun の作品ページ（表示件数10）から作る形 */
function dailyEnvelope(patch: Record<string, unknown> = {}): string {
  return JSON.stringify({
    "novelai-stats": READER_STATS_ENVELOPE_VERSION,
    site: "narou",
    source: "narou.fun",
    workId: "N1234AB",
    readAt: fetchedAt,
    readAtBasis: "fetched",
    entries: [
      {
        scope: "work",
        metrics: { points: 1216, bookmarks: 303, narou_ratingPoints: 610 },
      },
      dayRow("2026-09-19", { bookmarks: -1, narou_ratingPoints: 0 }),
      dayRow("2026-09-20", { bookmarks: 1, narou_ratingPoints: 0 }),
      dayRow("2026-09-21", { bookmarks: 0, narou_ratingPoints: 4 }),
      dayRow("2026-09-22", { bookmarks: 1, narou_ratingPoints: 0 }),
    ],
    ...patch,
  });
}

function record(patch: Partial<ReaderStatsRecord>): ReaderStatsRecord {
  return {
    site: "narou",
    readAt: fetchedAt,
    scope: "work",
    period: "day",
    periodKey: "2026-09-19",
    metrics: { bookmarks: -1 },
    source: "helper",
    ...patch,
  };
}

describe("台帳：日別の増減の欄だけ、負を受ける", () => {
  test("日別のブックマーク・評価ポイントの負は受ける", () => {
    const ledger = withReaderStats(
      emptyPostingLedger(),
      record({ metrics: { bookmarks: -3, narou_ratingPoints: -2 } })
    );
    expect(ledger.readerStats[0].metrics).toEqual({
      bookmarks: -3,
      narou_ratingPoints: -2,
    });
  });

  test("日別でも、増減の欄でないもの（PV・評価者数・週間読者…）の負は受けない", () => {
    for (const key of ["pv", "narou_raters", "narou_weeklyReaders", "likes", "points"]) {
      expect(
        () => withReaderStats(emptyPostingLedger(), record({ metrics: { [key]: -1 } })),
        key
      ).toThrow();
    }
  });

  test("日別でない行（その時点・月別・年別・累計）の負は、ブックマークでも受けない", () => {
    const cases: Partial<ReaderStatsRecord>[] = [
      { period: undefined, periodKey: undefined },
      { period: "month", periodKey: "2026-09" },
      { period: "year", periodKey: "2026" },
      { period: "total", periodKey: undefined },
    ];
    for (const patch of cases) {
      expect(
        () => withReaderStats(emptyPostingLedger(), record(patch)),
        JSON.stringify(patch)
      ).toThrow();
    }
  });

  test("小数の負は、増減の欄でも受けない", () => {
    expect(() =>
      withReaderStats(emptyPostingLedger(), record({ metrics: { bookmarks: -1.5 } }))
    ).toThrow();
  });

  test("手入力は、これまでどおり0以上だけ（打ち間違いの「-」を黙って入れない）", () => {
    const info = readerStatsMetricInfo("bookmarks")!;
    expect(validateReaderStatsValue("-1", info)).not.toBeNull();
  });

  test("負の日を持つ台帳を読み込める（行を飛ばさない）", () => {
    const read = readPostingLedger({
      schemaVersion: "1",
      sites: [],
      posts: [],
      rankings: [],
      readerStats: [record({}), record({ period: undefined, periodKey: undefined })],
    });
    // 日別の負は読める。その時点の負は読めないので、その行だけ生のまま控える
    expect(read.ledger.readerStats).toHaveLength(1);
    expect(read.ledger.readerStats[0].metrics.bookmarks).toBe(-1);
    expect(read.skippedReaderStats).toBe(1);
  });
});

describe("封筒：日別の増減の負と、記録の日時の印", () => {
  test("負の日を含む Narou.fun の封筒を受ける", () => {
    const result = parseReaderStatsEnvelope(dailyEnvelope());
    expect(result.ok, result.ok ? "" : result.reason).toBe(true);
    if (!result.ok) return;
    expect(result.envelope.readAtBasis).toBe("fetched");
    expect(result.envelope.readAt).toBe(fetchedAt);
    expect(
      result.envelope.entries.find((entry) => entry.periodKey === "2026-09-19")
        ?.metrics.bookmarks
    ).toBe(-1);
  });

  test("日別のPVの負・その時点のブックマークの負は、封筒ごと断る", () => {
    const pv = parseReaderStatsEnvelope(
      dailyEnvelope({ entries: [dayRow("2026-09-19", { pv: -1 })] })
    );
    expect(pv.ok).toBe(false);
    const snapshot = parseReaderStatsEnvelope(
      dailyEnvelope({ entries: [{ scope: "work", metrics: { bookmarks: -1 } }] })
    );
    expect(snapshot.ok).toBe(false);
    const month = parseReaderStatsEnvelope(
      dailyEnvelope({
        entries: [
          { scope: "work", period: "month", periodKey: "2026-09", metrics: { bookmarks: -1 } },
        ],
      })
    );
    expect(month.ok).toBe(false);
  });

  test("記録の日時の印は fetched／clicked だけ。無い・null は「押した時刻」（これまでの封筒）", () => {
    const clicked = parseReaderStatsEnvelope(dailyEnvelope({ readAtBasis: "clicked" }));
    expect(clicked.ok && clicked.envelope.readAtBasis).toBe("clicked");
    for (const value of [undefined, null]) {
      const none = parseReaderStatsEnvelope(dailyEnvelope({ readAtBasis: value }));
      expect(none.ok).toBe(true);
      if (none.ok) expect(none.envelope).not.toHaveProperty("readAtBasis");
    }
    // 知らない印は推測で読まない（版数・出どころと同じ流儀）
    expect(parseReaderStatsEnvelope(dailyEnvelope({ readAtBasis: "guessed" })).ok).toBe(false);
  });

  test("組み立てと読みが往復する", () => {
    const raw = buildReaderStatsEnvelope({
      site: "narou",
      source: "narou.fun",
      workId: "N1234AB",
      readAt: fetchedAt,
      readAtBasis: "fetched",
      entries: [
        {
          scope: "work",
          period: "day",
          periodKey: "2026-09-19",
          metrics: { bookmarks: -1 },
        },
      ],
    });
    const result = parseReaderStatsEnvelope(raw);
    expect(result.ok && result.envelope.readAtBasis).toBe("fetched");
  });
});

describe("グラフ：日ごとの増減", () => {
  const charts = (records: ReaderStatsRecord[]): ReaderCharts =>
    buildReaderCharts(records, null);

  test("ブックマークと評価ポイントの日ごとの増減が、負の日も含めて載る", () => {
    const built = charts([
      record({ periodKey: "2026-09-19", metrics: { bookmarks: -1, narou_ratingPoints: 0 } }),
      record({ periodKey: "2026-09-20", metrics: { bookmarks: 2, narou_ratingPoints: 4 } }),
    ]);
    const bookmarks = built.changes.find(
      (chart) => chart.metric === "bookmarks" && chart.period === "day"
    );
    expect(bookmarks?.points.map((point) => point.value)).toEqual([-1, 2]);
    expect(bookmarks?.label).toBe("ブックマーク");
    const rating = built.changes.find(
      (chart) => chart.metric === "narou_ratingPoints" && chart.period === "day"
    );
    expect(rating?.points.map((point) => point.value)).toEqual([0, 4]);
    // PVの日のグラフには混ざらない
    expect(built.day).toBeNull();
  });

  test("同じ日が何度も取り込まれていたら、いちばん新しい取り込みの値（足し合わせない）", () => {
    const built = charts([
      record({ readAt: "2026-09-20T16:26:00.000Z", metrics: { bookmarks: -1 } }),
      record({ readAt: "2026-09-21T16:26:00.000Z", metrics: { bookmarks: 3 } }),
      record({ readAt: "2026-09-21T16:26:00.000Z", metrics: { bookmarks: 3 } }),
    ]);
    const bookmarks = built.changes.find((chart) => chart.metric === "bookmarks");
    expect(bookmarks?.points).toEqual([
      { key: "2026-09-19", label: "9/19", value: 3 },
    ]);
  });

  test("増減の材料が無ければ、増減のグラフは出さない", () => {
    expect(charts([record({ period: undefined, periodKey: undefined, metrics: { bookmarks: 3 } })]).changes).toEqual([]);
  });

  test("月別のブックマークがあれば、月の増減のグラフも出る", () => {
    const built = charts([
      record({ period: "month", periodKey: "2026-08", metrics: { bookmarks: 12 } }),
    ]);
    expect(
      built.changes.find((chart) => chart.period === "month")?.points[0]
    ).toMatchObject({ key: "2026-08", value: 12 });
  });
});

describe("画面：負の日は0の線より下に、色を変えて描く", () => {
  const panelHtml = buildWritingStatsPanelHtml("NONCE123", "vscode-resource:");
  const panelScript = (() => {
    const found = panelHtml.match(/<script nonce="NONCE123">([\s\S]*?)<\/script>/);
    if (!found) throw new Error("スクリプトが見つかりません");
    return found[1];
  })();
  function extractFunction(source: string, name: string): string {
    const head = source.indexOf("function " + name + "(");
    expect(head, name + " が見つからない").toBeGreaterThanOrEqual(0);
    let depth = 0;
    let started = false;
    for (let index = head; index < source.length; index++) {
      if (source[index] === "{") {
        depth++;
        started = true;
      } else if (source[index] === "}") {
        depth--;
        if (started && depth === 0) return source.slice(head, index + 1);
      }
    }
    throw new Error(name + " の終わりが見つからない");
  }
  const needs = [
    "escapeHtml",
    "formatCount",
    "formatWhen",
    "estimateLabelWidth",
    "readerTickIndices",
    "readerBarChart",
    "readerLineChart",
    "readerChartBlock",
    "readerSignedCount",
  ];
  const render = (charts: ReaderCharts | null): string =>
    (
      new Function(
        [...needs, "renderReaderCharts"]
          .map((name) => extractFunction(panelScript, name))
          .join("\n") + "\nreturn renderReaderCharts;"
      )() as (charts: ReaderCharts | null) => string
    )(charts);

  test("増減のグラフが出て、減った日の棒は negative（0の線より下）", () => {
    const html = render(
      buildReaderCharts(
        [
          record({ periodKey: "2026-09-19", metrics: { bookmarks: -1 } }),
          record({ periodKey: "2026-09-20", metrics: { bookmarks: 2 } }),
        ],
        null
      )
    );
    expect(html).toContain("日ごとのブックマークの増減");
    expect(html).toContain('class="bar negative"');
    // 0の線は上端でも下端でもない（負の棒の分だけ上がる）
    const zero = /<line class="axis" x1="\d+" y1="([\d.]+)"/.exec(html);
    expect(Number(zero?.[1])).toBeGreaterThan(16);
    expect(Number(zero?.[1])).toBeLessThan(156);
    // 数には符号を付ける（「−1」「+2」）
    expect(html).toContain("−1");
    expect(html).toContain("+2");
    // 減った日があるときだけ、読み方を添える
    expect(html).toContain("0の線より下");
  });

  test("PVのグラフは、これまでどおり（負の棒も符号も無い）", () => {
    const html = render(
      buildReaderCharts(
        [
          {
            site: "kakuyomu",
            readAt: fetchedAt,
            scope: "work",
            period: "day",
            periodKey: "2026-09-22",
            metrics: { pv: 5 },
            source: "helper",
          },
        ],
        null
      )
    );
    expect(html).toContain("日ごとのPV");
    expect(html).not.toContain("negative");
    expect(html).not.toContain("増減");
  });
});

describe("率：記録の日時が最終取得日時なら、72時間の境目もその日時で見る", () => {
  test("最終取得日時から見て72時間たっていない話は、押した時刻から見て72時間たっていても基準にしない", () => {
    // 最終取得 09/22 01:26（日本時間）。押したのはその2日あと。
    // 第2話の更新は最終取得の71時間前＝押した時刻から見れば119時間前
    const updatedAt = new Date(Date.parse(fetchedAt) - 71 * 60 * 60 * 1000).toISOString();
    const records: ReaderStatsRecord[] = [
      { site: "narou", readAt: fetchedAt, scope: "episode", episode: 1, metrics: { pv: 100 }, source: "helper", updatedAt: "2026-09-01T00:00:00+09:00" },
      { site: "narou", readAt: fetchedAt, scope: "episode", episode: 2, metrics: { pv: 50 }, source: "helper", updatedAt },
    ];
    expect(computeReaderRates(records).base?.episode).toBe(1);
  });

  test("ブックマーク率の分子は、記録の日時の新しい作品全体の数（日別の増減は使わない）", () => {
    const records: ReaderStatsRecord[] = [
      { site: "narou", readAt: fetchedAt, scope: "episode", episode: 1, metrics: { pv: 1000 }, source: "helper" },
      { site: "narou", readAt: fetchedAt, scope: "work", metrics: { bookmarks: 303 }, source: "helper" },
      record({ periodKey: "2026-09-22", metrics: { bookmarks: -1 } }),
    ];
    const rates = computeReaderRates(records);
    expect(rates.bookmark.operands.map((operand) => operand.value)).toContain(303);
    expect(rates.bookmark.operands.map((operand) => operand.value)).not.toContain(-1);
  });
});

/* ------------------------------------------------------------------ *
 * 取り込み（features/readerStats.ts の importReaderStats）
 * ------------------------------------------------------------------ */

const work: WorkEntry = {
  id: "work_narou_fun_daily",
  title: "星を継ぐ者たち",
  folderPath: path.join("C:", "novels", "narou-fun-daily"),
  registeredAt: "2026-09-23T00:00:00.000Z",
};

const ledgerPath = Uri.file(
  path.join(work.folderPath, "設定", "投稿状態.json")
).fsPath;

const disk = new Map<string, Uint8Array>();
const informed: string[] = [];
const warned: string[] = [];

function storedLedger(): PostingLedger {
  return readPostingLedger(
    JSON.parse(new TextDecoder().decode(disk.get(ledgerPath)!))
  ).ledger;
}

beforeEach(() => {
  disk.clear();
  informed.length = 0;
  warned.length = 0;
  env.clipboard.text = "";
  workspace.textDocuments = [];
  disk.set(
    ledgerPath,
    new TextEncoder().encode(
      `${JSON.stringify({
        schemaVersion: "1",
        sites: [],
        siteProfiles: [{ site: "narou", workId: "n1234ab" }],
        posts: [],
        rankings: [],
      })}\n`
    )
  );
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

describe("取り込み：Narou.fun の日ごとの増減", () => {
  test("負の日を含めて台帳へ入り、記録の日時は最終取得日時、メモにそう残る", async () => {
    env.clipboard.text = dailyEnvelope();
    const result = await importReaderStats(work);

    expect(warned).toEqual([]);
    expect(result.changed).toBe(true);
    const stats = storedLedger().readerStats;
    expect(stats).toHaveLength(5);
    expect(stats.every((row) => row.readAt === fetchedAt)).toBe(true);
    expect(stats.find((row) => row.periodKey === "2026-09-19")?.metrics.bookmarks).toBe(-1);
    expect(stats[0].note).toContain("Narou.fun");
    expect(stats[0].note).toContain("最終取得日時");
  });

  test("最終取得日時を読めなかった封筒は、押した時刻だとメモに残る", async () => {
    env.clipboard.text = dailyEnvelope({
      readAt: "2026-09-23T01:00:00.000Z",
      readAtBasis: "clicked",
    });
    await importReaderStats(work);
    const note = storedLedger().readerStats[0].note ?? "";
    expect(note).toContain("押した時刻");
    expect(note).not.toContain("日時は最終取得日時");
  });

  test("同じ表を2度取り込んでも、二重に積まない", async () => {
    env.clipboard.text = dailyEnvelope();
    await importReaderStats(work);
    const second = await importReaderStats(work);

    expect(storedLedger().readerStats).toHaveLength(5);
    expect(second.changed).toBe(false);
    expect(informed.join("\n")).toContain("同じ");
  });

  test("翌日の取り込みでは、重なった日は積まず、新しい日と作品全体の数だけを足す", async () => {
    env.clipboard.text = dailyEnvelope();
    await importReaderStats(work);

    env.clipboard.text = dailyEnvelope({
      readAt: "2026-09-22T16:26:00.000Z",
      entries: [
        { scope: "work", metrics: { points: 1218, bookmarks: 304, narou_ratingPoints: 610 } },
        dayRow("2026-09-20", { bookmarks: 1, narou_ratingPoints: 0 }),
        dayRow("2026-09-21", { bookmarks: 0, narou_ratingPoints: 4 }),
        dayRow("2026-09-22", { bookmarks: 1, narou_ratingPoints: 0 }),
        dayRow("2026-09-23", { bookmarks: 1, narou_ratingPoints: 0 }),
      ],
    });
    const second = await importReaderStats(work);

    expect(second.changed).toBe(true);
    const stats = storedLedger().readerStats;
    // 1回目の5件 ＋ 作品全体1件 ＋ 新しい日（09/23）1件
    expect(stats).toHaveLength(7);
    expect(stats.filter((row) => row.periodKey === "2026-09-22")).toHaveLength(1);
    expect(informed.join("\n")).toContain("3件");
  });

  test("同じ日の値が変わっていたら（サイトが数え直した）、積んで、グラフは新しいほうを採る", async () => {
    env.clipboard.text = dailyEnvelope();
    await importReaderStats(work);
    env.clipboard.text = dailyEnvelope({
      readAt: "2026-09-22T16:26:00.000Z",
      entries: [dayRow("2026-09-22", { bookmarks: 2, narou_ratingPoints: 0 })],
    });
    await importReaderStats(work);

    const stats = storedLedger().readerStats;
    expect(stats.filter((row) => row.periodKey === "2026-09-22")).toHaveLength(2);
    const chart = buildReaderCharts(stats, null).changes.find(
      (entry) => entry.metric === "bookmarks" && entry.period === "day"
    );
    expect(chart?.points.find((point) => point.key === "2026-09-22")?.value).toBe(2);
  });
});
