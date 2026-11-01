import * as path from "path";
import { beforeAll, beforeEach, describe, expect, test } from "vitest";
import {
  ReaderStatsHelperLink,
  type FingerprintMemory,
} from "../../../src/features/readerStatsHelperLink";
import { importReaderStats } from "../../../src/features/readerStats";
import { importHeldOwnWorkRankings } from "../../../src/features/ownWorkHeldStatsImport";
import {
  buildReaderStatsEnvelope,
  READER_STATS_BUNDLE_KIND,
  type ReaderStatsRanking,
} from "../../../src/core/readerStatsEnvelope";
import {
  emptyPostingLedger,
  readPostingLedger,
  withSiteProfile,
  withSites,
  type PostingLedger,
} from "../../../src/models/posting";
import type { WorkEntry } from "../../../src/models/types";
import { env, FileSystemError, Uri, window, workspace } from "../support/vscodeStub";

/**
 * まとめて渡された束の順位（`rankings`。ヘルパー 0.19.0、2026-11-02）を、作品の台帳の
 * 順位の記録へ取り込む。確かめるのは：
 *
 *   1. 作品は site＋workId で決め、その作品の台帳の rankings に出どころ helper で積む
 *   2. 同じ鍵は積まない（同じ束が2度届いても）
 *   3. items が空で順位だけの束も受け取り、知らせは「順位 M件を取り込みました」
 *   4. 画面と順位の束は「読者の反応 N画面と順位 M件を取り込みました」
 *   5. 作品の決まらない順位は、未登録の自分の作品のものなら控えへ、そうでなければ捨てて記録に残す
 *   6. 控えた順位は、登録したあとに取り込める
 */

function work(id: string, title: string): WorkEntry {
  return { id, title, folderPath: path.join("C:", "novels", id), registeredAt: "2026-11-01T00:00:00.000Z" };
}

function ledgerPath(entry: WorkEntry): string {
  return Uri.file(path.join(entry.folderPath, "設定", "投稿状態.json")).fsPath;
}

const disk = new Map<string, Uint8Array>();
const informed: string[] = [];
const warned: string[] = [];
const logged: string[] = [];

function writeLedger(entry: WorkEntry, ledger: PostingLedger): void {
  disk.set(ledgerPath(entry), new TextEncoder().encode(`${JSON.stringify(ledger, null, 2)}\n`));
}

function readLedger(entry: WorkEntry): PostingLedger {
  const bytes = disk.get(ledgerPath(entry));
  if (!bytes) throw new Error("台帳が無い");
  return readPostingLedger(JSON.parse(new TextDecoder().decode(bytes))).ledger;
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

function screen(workId: string, ownedVia?: "owner-page"): unknown {
  return {
    ...JSON.parse(
      buildReaderStatsEnvelope({
        site: "kakuyomu",
        workId,
        readAt: "2026-11-02T09:00:00.000+09:00",
        entries: [{ scope: "work", metrics: { pv: 100 } }],
      })
    ),
    ...(ownedVia ? { ownedVia } : {}),
  };
}

function bundleText(items: unknown[], rankings: unknown[]): string {
  return JSON.stringify({
    kind: READER_STATS_BUNDLE_KIND,
    version: 1,
    handedAt: "2026-11-02T10:00:00.000+09:00",
    items,
    rankings,
  });
}

class MemoryStub implements FingerprintMemory {
  readonly values = new Map<string, unknown>();
  get<T>(key: string, defaultValue: T): T {
    return (this.values.has(key) ? this.values.get(key) : defaultValue) as T;
  }
  async update(key: string, value: unknown): Promise<void> {
    this.values.set(key, value);
  }
}

let workA: WorkEntry;
let workB: WorkEntry;

beforeAll(() => {
  Object.assign(window, {
    createOutputChannel: () => ({
      appendLine: (line: string) => logged.push(line),
      show() {},
      dispose() {},
    }),
  });
});

beforeEach(() => {
  disk.clear();
  informed.length = 0;
  warned.length = 0;
  logged.length = 0;
  workA = work("wa", "星の庭");
  workB = work("wb", "海の門");
  writeLedger(workA, onKakuyomu("1111"));
  writeLedger(workB, onKakuyomu("2222"));
  env.clipboard.text = "";
  env.clipboard.readText = async () => env.clipboard.text;
  workspace.textDocuments = [];
  workspace.getConfiguration = (() => ({
    get: <T>(_key: string, defaultValue: T): T => defaultValue,
  })) as typeof workspace.getConfiguration;
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
    rename: async (from: { fsPath: string }, to: { fsPath: string }, options?: { overwrite?: boolean }) => {
      const bytes = disk.get(from.fsPath);
      if (!bytes) throw new FileSystemError("missing", "FileNotFound");
      if (!options?.overwrite && disk.has(to.fsPath)) throw new FileSystemError("exists", "FileExists");
      disk.set(to.fsPath, bytes);
      disk.delete(from.fsPath);
    },
    delete: async (uri: { fsPath: string }) => {
      disk.delete(uri.fsPath);
    },
    stat: async (uri: { fsPath: string }) => {
      if (!disk.has(uri.fsPath)) throw new FileSystemError("missing", "FileNotFound");
      return { type: 1, ctime: 0, mtime: 0, size: 0 };
    },
  } as unknown as typeof workspace.fs;
  Object.assign(window, {
    showQuickPick: async () => {
      throw new Error("まとめて渡された分では、作品を選ばせない");
    },
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

function link(memory: MemoryStub, extra: Partial<ConstructorParameters<typeof ReaderStatsHelperLink>[0]> = {}) {
  return new ReaderStatsHelperLink({
    listWorks: () => [workA, workB],
    memory,
    afterImport: async () => undefined,
    ...extra,
  });
}

describe("束の順位を作品の台帳へ", () => {
  test("順位だけの束（items が空）を受け取り、作品ごとに出どころ helper で積む", async () => {
    env.clipboard.text = bundleText(
      [],
      [
        ranking(),
        ranking({ board: "rankings/all/daily/long", boardLabel: "日間総合の長編ランキング", span: "daily", rank: 80 }),
        ranking({ workId: "2222", title: "海の門", rank: 3 }),
      ]
    );
    await link(new MemoryStub()).handleUri({ path: "/import-reader-stats" });

    const a = readLedger(workA).rankings;
    expect(a).toHaveLength(2);
    expect(a.every((entry) => entry.source === "helper")).toBe(true);
    expect(a[0]).toMatchObject({
      board: "rankings/fantasy/weekly/long",
      boardLabel: "週間異世界ファンタジーの長編ランキング",
      span: "weekly",
      genre: "異世界ファンタジー",
      rank: 12,
      recordedAt: "2026-11-02T00:00:00+09:00",
    });
    expect(readLedger(workB).rankings.map((entry) => entry.rank)).toEqual([3]);
    // 読者の反応の数には何も入らない
    expect(readLedger(workA).readerStats ?? []).toEqual([]);
    expect(warned).toEqual([]);
    expect(informed).toHaveLength(1);
    expect(informed[0]).toContain("順位 3件を取り込みました：「星の庭」順位2件・「海の門」順位1件。");
    expect(informed[0]).not.toContain("読者の反応 ");
  });

  test("同じ束が2度届いても積まない（2度目は「すでに取り込んだものと同じ」）", async () => {
    env.clipboard.text = bundleText([], [ranking()]);
    await importReaderStats(workA, { works: [workA, workB], clipboardText: env.clipboard.text });
    await importReaderStats(workA, { works: [workA, workB], clipboardText: env.clipboard.text });
    expect(readLedger(workA).rankings).toHaveLength(1);
    expect(informed[1]).toContain("順位は、すでに取り込んだものと同じでした");
  });

  test("画面と順位の束は「読者の反応 N画面と順位 M件を取り込みました」", async () => {
    await importReaderStats(workA, {
      works: [workA, workB],
      clipboardText: bundleText([screen("1111")], [ranking()]),
    });
    expect(readLedger(workA).readerStats ?? []).toHaveLength(1);
    expect(readLedger(workA).rankings).toHaveLength(1);
    expect(informed[0]).toContain("読者の反応 1画面と順位 1件を取り込みました：「星の庭」1画面・順位1件。");
  });

  test("読めない1件だけを捨て、残りは取り込み、捨てた理由を記録に残す", async () => {
    await importReaderStats(workA, {
      works: [workA, workB],
      clipboardText: bundleText([], [ranking(), ranking({ rank: 0 })]),
    });
    expect(readLedger(workA).rankings).toHaveLength(1);
    expect(logged.join("\n")).toContain("順位の2件目：順位の数を読めませんでした。");
  });

  test("どの作品にも決まらない順位は捨てて記録に残す（未登録の自分の作品でなければ）", async () => {
    await importReaderStats(workA, {
      works: [workA, workB],
      clipboardText: bundleText([], [ranking({ workId: "9999", title: "知らない作品" })]),
      noteOwnRankings: async () => [],
    });
    expect(readLedger(workA).rankings).toEqual([]);
    expect(warned.concat(informed).join("\n")).toContain("どの作品のものか決まらなかった順位（1件）");
    expect(logged.join("\n")).toContain("カクヨム 作品ID 9999「知らない作品」の週間異世界ファンタジーの長編ランキング");
  });

  test("未登録の自分の作品の順位は控えに渡し、控えたと言う（同じ束の本人しか開けない画面を添える）", async () => {
    const handed: { rankings: readonly ReaderStatsRanking[]; screens: number }[] = [];
    await importReaderStats(workA, {
      works: [workA, workB],
      clipboardText: bundleText([screen("9999", "owner-page")], [ranking({ workId: "9999" })]),
      noteOwnWorks: async () => undefined,
      noteOwnRankings: async (rankings, envelopes) => {
        handed.push({ rankings, screens: envelopes.length });
        return rankings;
      },
    });
    expect(handed).toHaveLength(1);
    expect(handed[0].rankings.map((entry) => entry.workId)).toEqual(["9999"]);
    expect(handed[0].screens).toBe(1);
    expect(warned.concat(informed).join("\n")).toContain("「未登録の自分の作品」の順位（1件）は控えました");
  });

  test("窓に戻ったとき、順位だけの束でも訊く（黙って捨てない）", async () => {
    env.clipboard.text = bundleText([], [ranking()]);
    await link(new MemoryStub()).checkOnFocus();
    // 訊いた（答えは返さないので取り込まない）
    expect(informed.some((message) => message.includes("まとめて渡した順位"))).toBe(true);
    expect(readLedger(workA).rankings).toEqual([]);
  });
});

describe("控えた順位を、登録したあとに取り込む", () => {
  test("登録された作品の分は台帳へ入り、決まらない分は控えに残る", async () => {
    const parse = (raw: Record<string, unknown>): ReaderStatsRanking => raw as unknown as ReaderStatsRanking;
    const held = [parse(ranking()), parse(ranking({ workId: "9999" }))];
    const result = await importHeldOwnWorkRankings(held, [workA, workB]);
    expect(readLedger(workA).rankings).toHaveLength(1);
    expect(result.remaining.map((entry) => entry.workId)).toEqual(["9999"]);
    expect(result.changedWorks.map((entry) => entry.id)).toEqual(["wa"]);
    // 知らせは出さない（読者の反応の控えの知らせと重ねない）
    expect(informed).toEqual([]);
    expect(warned).toEqual([]);
  });
});
