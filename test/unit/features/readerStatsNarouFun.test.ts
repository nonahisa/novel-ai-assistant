import * as path from "path";
import { beforeEach, describe, expect, test } from "vitest";
import {
  buildReaderStatsEnvelope,
  matchReaderStatsEnvelope,
  parseReaderStatsEnvelope,
  READER_STATS_ENVELOPE_VERSION,
  type ReaderStatsEnvelope,
} from "../../../src/core/readerStatsEnvelope";
import { importReaderStats } from "../../../src/features/readerStats";
import { computeReaderRates } from "../../../src/core/readerRates";
import {
  emptyPostingLedger,
  readerStatsMetricsFor,
  readPostingLedger,
  withSiteProfile,
  withSites,
  type PostingLedger,
  type ReaderStatsRecord,
} from "../../../src/models/posting";
import type { WorkEntry } from "../../../src/models/types";
import { env, FileSystemError, Uri, window, workspace } from "../support/vscodeStub";

/**
 * Narou.fun（なろうの分析サイト）の封筒を受ける（残課題 B11。作者の依頼、2026-09-23）。
 *
 * 母艦は、なろうの封筒を「規約の判断により」断ってきた。**その判断はなろう本体
 * （syosetu.com）を機械で読むことについて**であって、作者が自分で開いた
 * Narou.fun の頁を読んだ封筒は別の出どころである。封筒の `source` で分ける。
 *
 * 分けたうえで、**なろう本体の封筒は断り続ける**。そして Narou.fun は
 * **誰の作品の頁でも開ける**ので、貼り込み係には作者の作品かどうかが分からない
 * ——台帳のなろうの作品ID（Nコード）と照合できないものは受けない。
 */

/** Narou.fun の作品頁から読んだ形（数字は架空） */
function narouFunEnvelope(patch: Record<string, unknown> = {}): string {
  return JSON.stringify({
    "novelai-stats": READER_STATS_ENVELOPE_VERSION,
    site: "narou",
    source: "narou.fun",
    workId: "N1234AB",
    readAt: "2026-09-23T01:00:00.000Z",
    entries: [
      {
        scope: "work",
        metrics: {
          points: 1200,
          bookmarks: 300,
          comments: 12,
          reviews: 1,
          narou_ratingPoints: 600,
          narou_raters: 70,
          narou_weeklyReaders: 45,
        },
      },
    ],
    ...patch,
  });
}

function parsed(raw: string): ReaderStatsEnvelope {
  const result = parseReaderStatsEnvelope(raw);
  if (!result.ok) throw new Error(`封筒を読めていない：${result.reason}`);
  return result.envelope;
}

const narouPostUrl =
  "https://syosetu.com/usernovelmanage/isnoveluploadmenu/ncode/n1234ab/";

describe("出どころで分ける", () => {
  test("Narou.fun の封筒は受ける", () => {
    const result = parseReaderStatsEnvelope(narouFunEnvelope());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.envelope.site).toBe("narou");
    expect(result.envelope.source).toBe("narou.fun");
    expect(result.envelope.workId).toBe("N1234AB");
    // なろう固有の欄（週間読者を含む）が落ちずに届く
    expect(result.envelope.entries[0].metrics).toEqual({
      points: 1200,
      bookmarks: 300,
      comments: 12,
      reviews: 1,
      narou_ratingPoints: 600,
      narou_raters: 70,
      narou_weeklyReaders: 45,
    });
  });

  test("なろう本体の封筒（出どころなし）は、これまでどおり断る", () => {
    for (const source of [undefined, null]) {
      const result = parseReaderStatsEnvelope(narouFunEnvelope({ source }));
      expect(result.ok, String(source)).toBe(false);
      if (result.ok) continue;
      expect(result.reason).toContain("読者反応手動入力");
    }
  });

  test("知らない出どころは受けない（推測で読まない）", () => {
    for (const source of ["kasasagi", "syosetu.com", "", 1]) {
      const result = parseReaderStatsEnvelope(narouFunEnvelope({ source }));
      expect(result.ok, String(source)).toBe(false);
    }
  });

  test("出どころとサイトが合わない封筒は受けない（Narou.fun はなろうの数だけ）", () => {
    const result = parseReaderStatsEnvelope(
      narouFunEnvelope({ site: "kakuyomu" })
    );
    expect(result.ok).toBe(false);
  });

  test("Narou.fun の封筒に作品ID（Nコード）が無ければ受けない", () => {
    for (const workId of [undefined, null, "   "]) {
      const result = parseReaderStatsEnvelope(narouFunEnvelope({ workId }));
      expect(result.ok, String(workId)).toBe(false);
      if (result.ok) continue;
      expect(result.reason).toContain("Nコード");
    }
  });

  test("カクヨムの封筒は、出どころの欄が無くても今までどおり受ける", () => {
    const result = parseReaderStatsEnvelope(
      buildReaderStatsEnvelope({
        site: "kakuyomu",
        readAt: "2026-09-23T01:00:00.000Z",
        entries: [{ scope: "work", metrics: { pv: 1 } }],
      })
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.envelope.source).toBeUndefined();
  });

  test("組み立てと読み取りが往復する（出どころの欄を含めて）", () => {
    const built = buildReaderStatsEnvelope({
      site: "narou",
      source: "narou.fun",
      workId: "N1234AB",
      readAt: "2026-09-23T01:00:00.000Z",
      entries: [{ scope: "work", metrics: { bookmarks: 300 } }],
    });
    const envelope = parsed(built);
    expect(envelope.source).toBe("narou.fun");
    expect(envelope.site).toBe("narou");
  });
});

describe("Narou.fun の封筒の照合（誰の作品の頁でも開けるため、Nコードで確かめる）", () => {
  function narouLedger(workId?: string): PostingLedger {
    const ledger = withSites(emptyPostingLedger(), []);
    return withSiteProfile(ledger, "narou", workId ? { workId } : { genre: "ハイファンタジー" });
  }

  test("台帳のNコードと合えば通す（大文字・小文字は問わない）", () => {
    expect(
      matchReaderStatsEnvelope(parsed(narouFunEnvelope()), narouLedger("n1234ab"))
    ).toBeNull();
    expect(
      matchReaderStatsEnvelope(parsed(narouFunEnvelope()), narouLedger("N1234AB"))
    ).toBeNull();
  });

  test("Nコードが投稿ページのURLにしか無くても、そこから照合する", () => {
    const ledger = withSites(emptyPostingLedger(), [
      { site: "narou", newEpisodeUrl: narouPostUrl },
    ]);
    expect(matchReaderStatsEnvelope(parsed(narouFunEnvelope()), ledger)).toBeNull();
  });

  test("台帳に無いNコード（ほかの方の作品の頁）の封筒は受けない", () => {
    const reason = matchReaderStatsEnvelope(
      parsed(narouFunEnvelope({ workId: "N9999ZZ" })),
      narouLedger("n1234ab")
    );
    expect(reason).toContain("N9999ZZ");
  });

  test("台帳になろうのNコードが無ければ、照合できないので受けない", () => {
    // カクヨムの封筒は「台帳に作品IDが無ければ通す」が、Narou.fun はそれでは足りない
    const reason = matchReaderStatsEnvelope(
      parsed(narouFunEnvelope()),
      narouLedger()
    );
    expect(reason).not.toBeNull();
    expect(reason).toContain("Nコード");
  });

  test("なろうに載っていると分かっていない作品では受けない", () => {
    const ledger = withSiteProfile(emptyPostingLedger(), "kakuyomu", {
      workId: "1177354054892",
    });
    expect(matchReaderStatsEnvelope(parsed(narouFunEnvelope()), ledger)).not.toBeNull();
  });
});

describe("なろう固有の欄に週間読者がある", () => {
  test("Narou.fun の「週間読者」を、なろう固有の欄として持てる", () => {
    const labels = readerStatsMetricsFor("narou").map((info) => info.label);
    expect(labels).toContain("週間読者");
    // 共通の欄（ユニーク）へ当てはめない——1週間の窓の人数で、累計のユニークではない
    const keys = readerStatsMetricsFor("narou").map((info) => info.key);
    expect(keys).toContain("narou_weeklyReaders");
  });
});

describe("なろうの評価率は、評価者数で割る", () => {
  /*
    **評価率の分子は「評価した人数」である。** カクヨムではレビュー人数（★を
    付けた人数）がそれに当たるが、なろうの「レビュー」は**書かれたレビューの
    件数**で、評価した人数は「評価者数」（narou_raters）である。Narou.fun から
    レビュー 0 が入ると、なろうの評価率が 0% と出て、助言が「目安に届いて
    いない」と言いかねない。
  */
  const readAt = "2026-09-23T03:00:00.000Z";
  const records: ReaderStatsRecord[] = [
    {
      site: "narou",
      readAt,
      scope: "work",
      metrics: { bookmarks: 300, reviews: 0, narou_raters: 70 },
      source: "helper",
    },
    // 第1話のPVは Narou.fun に無い。手入力で入れた形
    {
      site: "narou",
      readAt,
      scope: "episode",
      episode: 1,
      metrics: { pv: 1000 },
      source: "manual",
    },
  ];

  test("なろうでは、評価率に評価者数を使う（レビューの件数を使わない）", () => {
    const rates = computeReaderRates(records);
    expect(rates.rating.operands[0]).toMatchObject({ value: 70 });
    expect(rates.rating.operands[0].label).toContain("評価者数");
    expect(rates.rating.percent).toBe("7.0%");
  });

  test("カクヨムは今までどおりレビュー人数で割る", () => {
    const kakuyomu = records.map((record) => ({
      ...record,
      site: "kakuyomu" as const,
      metrics:
        record.scope === "work"
          ? { bookmarks: 300, reviews: 20 }
          : record.metrics,
    }));
    const rates = computeReaderRates(kakuyomu);
    expect(rates.rating.operands[0]).toMatchObject({ value: 20 });
    expect(rates.rating.percent).toBe("2.0%");
  });

  test("第1話のPVが無ければ、なろうの率は出さずに理由を言う（Narou.fun には話ごとのPVが無い）", () => {
    const rates = computeReaderRates([
      records[0],
      // なろうのバックアップにある話ごとの反応（PVは無い）
      {
        site: "narou",
        readAt,
        scope: "episode",
        episode: 1,
        metrics: { likes: 3 },
        source: "backup",
      },
    ]);
    expect(rates.bookmark.percent).toBeUndefined();
    expect(rates.bookmark.missing).toBe("第1話のPVがありません");
    expect(rates.rating.missing).toBe("第1話のPVがありません");
    expect(rates.dropout.missing).toBeDefined();
  });
});

/* ------------------------------------------------------------------ *
 * 取り込みの口を通す（クリップボード → 台帳）
 * ------------------------------------------------------------------ */

const work: WorkEntry = {
  id: "work_narou_fun",
  title: "星を継ぐ者たち",
  folderPath: path.join("C:", "novels", "narou-fun"),
  registeredAt: "2026-09-23T00:00:00.000Z",
};

const ledgerPath = Uri.file(
  path.join(work.folderPath, "設定", "投稿状態.json")
).fsPath;

const disk = new Map<string, Uint8Array>();
const informed: string[] = [];
const warned: string[] = [];

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

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
    utf8(
      `${JSON.stringify(
        {
          schemaVersion: "1",
          sites: [],
          siteProfiles: [{ site: "narou", workId: "n1234ab" }],
          posts: [],
          rankings: [],
        },
        null,
        2
      )}\n`
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

describe("Narou.fun の封筒を取り込む", () => {
  test("台帳のNコードと合えば、なろうの記録として入り、出どころがメモに残る", async () => {
    env.clipboard.text = narouFunEnvelope();

    const result = await importReaderStats(work);

    expect(warned).toEqual([]);
    expect(result.changed).toBe(true);
    const stats = storedLedger().readerStats;
    expect(stats).toHaveLength(1);
    expect(stats[0]).toMatchObject({
      site: "narou",
      scope: "work",
      readAt: "2026-09-23T01:00:00.000Z",
      source: "helper",
      metrics: { bookmarks: 300, narou_raters: 70, narou_weeklyReaders: 45 },
    });
    // 台帳の出どころは「貼り付け」のまま（一覧を増やすと古い版が台帳ごと読めなくなる）。
    // どこから来た数かは、メモで見えるようにする
    expect(stats[0].note).toContain("Narou.fun");
    expect(informed.join("\n")).toContain("Narou.fun");
  });

  test("ほかの方の作品の頁の封筒は、台帳へ何も書かない", async () => {
    env.clipboard.text = narouFunEnvelope({ workId: "N9999ZZ" });

    const result = await importReaderStats(work);

    expect(result.changed).toBe(false);
    expect(warned.join("\n")).toContain("N9999ZZ");
    expect(storedLedger().readerStats).toHaveLength(0);
  });

  test("なろう本体の封筒は、台帳へ何も書かない", async () => {
    env.clipboard.text = narouFunEnvelope({ source: undefined });

    const result = await importReaderStats(work);

    expect(result.changed).toBe(false);
    expect(warned.join("\n")).toContain("読者反応手動入力");
    expect(storedLedger().readerStats).toHaveLength(0);
  });
});
