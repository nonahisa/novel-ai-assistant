import * as path from "path";
import { beforeEach, describe, expect, test } from "vitest";
import {
  importReaderStats,
  recordReaderStats,
} from "../../src/features/readerStats";
import { buildReaderStatsEnvelope } from "../../src/core/readerStatsEnvelope";
import type { WorkEntry } from "../../src/models/types";
import { env, FileSystemError, Uri, window, workspace } from "./support/vscodeStub";

/**
 * 読者の反応の2つの入口（設計書6.79.7）。
 *
 *   - 「読者の反応を貼り付けて取り込む」——作者が自分で開いた管理画面から、
 *     貼り込み係が作った封筒を受け取る
 *   - 「読者の反応を手入力する」——ヘルパーの無いサイト（なろう等）でも使える
 *
 * **どちらもサイトへは触りにいかない。** ここで確かめるのは、訊く順と、
 * 取り違えを止めること、そして空の記録を作らないことである。
 */

const work: WorkEntry = {
  id: "work_stats",
  title: "氷の街",
  folderPath: path.join("C:", "novels", "stats"),
  registeredAt: "2026-09-05T00:00:00.000Z",
};

const ledgerPath = Uri.file(
  path.join(work.folderPath, "設定", "投稿状態.json")
).fsPath;

const narouUrl =
  "https://syosetu.com/usernovelmanage/isnoveluploadmenu/ncode/n1234ab/";
const kakuyomuUrl = "https://kakuyomu.jp/my/works/1177354054892/episodes/new";

interface PickItem {
  label: string;
  [key: string]: unknown;
}

interface ReaderStatsEntry {
  site: string;
  readAt: string;
  scope: string;
  episode?: number;
  period?: string;
  periodKey?: string;
  metrics: Record<string, number>;
  source: string;
  note?: string;
}

const disk = new Map<string, Uint8Array>();
const informed: string[] = [];
const warned: string[] = [];

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function writeLedger(ledger: unknown): void {
  disk.set(ledgerPath, utf8(JSON.stringify(ledger, null, 2)));
}

function readLedger(): { readerStats?: ReaderStatsEntry[] } {
  const bytes = disk.get(ledgerPath);
  if (!bytes) throw new Error("台帳が書かれていません");
  return JSON.parse(new TextDecoder().decode(bytes));
}

function bothSites(): void {
  writeLedger({
    schemaVersion: "1",
    sites: [
      { site: "narou", newEpisodeUrl: narouUrl },
      { site: "kakuyomu", newEpisodeUrl: kakuyomuUrl },
    ],
    posts: [],
  });
}

/** 選択画面の答え方（`recordRanking.test.ts` と同じ形） */
function stubQuickPick(
  answers: Array<(items: PickItem[]) => unknown>
): PickItem[][] {
  const captured: PickItem[][] = [];
  let index = 0;
  Object.assign(window, {
    showQuickPick: async (items: PickItem[]) => {
      captured.push(items);
      const answer = answers[index++];
      return answer ? answer(items) : undefined;
    },
  });
  return captured;
}

/** 入力欄の答え方。**検証も本物と同じように通す**（迂回すると意味が無い） */
function stubInputs(values: Array<string | undefined>): Array<{
  title?: string;
  rejected?: string;
}> {
  const asked: Array<{ title?: string; rejected?: string }> = [];
  let index = 0;
  Object.assign(window, {
    showInputBox: async (options?: {
      title?: string;
      validateInput?: (value: string) => string | undefined;
    }) => {
      const value = values[index++];
      const rejected =
        value !== undefined && options?.validateInput
          ? options.validateInput(value)
          : undefined;
      asked.push({ title: options?.title, rejected: rejected ?? undefined });
      return value;
    },
  });
  return asked;
}

beforeEach(() => {
  disk.clear();
  informed.length = 0;
  warned.length = 0;
  env.clipboard.text = "";
  workspace.textDocuments = [];
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

describe("読者の反応を手入力する", () => {
  test("投稿サイトを登録していなければ、設定へ誘導して何も書かない", async () => {
    const picks = stubQuickPick([]);
    stubInputs([]);

    const result = await recordReaderStats(work);

    expect(result.changed).toBe(false);
    expect(warned.join("")).toContain("投稿サイトの設定");
    expect(picks).toHaveLength(0);
    expect(disk.has(ledgerPath)).toBe(false);
  });

  test("サイト・範囲・粒度の順に訊き、空欄の数値は飛ばす", async () => {
    bothSites();

    const picks = stubQuickPick([
      (items) => items.find((item) => item.site === "narou"),
      (items) => items.find((item) => item.scope === "work"),
      (items) => items.find((item) => item.period === "day"),
    ]);
    // 期間 → PV → ユニーク → ブックマーク → 評価 → いいね → コメント → レビュー
    const asked = stubInputs([
      "2026-09-05",
      "1234",
      "",
      "56",
      "",
      "",
      "",
      "",
    ]);

    const result = await recordReaderStats(work);

    expect(result.changed).toBe(true);
    // 訊く順（サイト → 範囲 → 粒度）
    expect(picks).toHaveLength(3);
    // 期間の入力は、その場で形を確かめている
    expect(asked[0].rejected).toBeUndefined();

    const saved = readLedger().readerStats ?? [];
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({
      site: "narou",
      scope: "work",
      period: "day",
      periodKey: "2026-09-05",
      source: "manual",
    });
    // **空欄は欄ごと持たない**（読めなかった値を0として残さない）
    expect(saved[0].metrics).toEqual({ pv: 1234, bookmarks: 56 });
    expect(saved[0].episode).toBeUndefined();
    expect(informed.join("")).toContain("小説家になろう");
  });

  test("話を選べば、話番号を訊いて記録に残す", async () => {
    bothSites();

    stubQuickPick([
      (items) => items.find((item) => item.site === "kakuyomu"),
      (items) => items.find((item) => item.scope === "episode"),
      (items) => items.find((item) => item.period === null),
    ]);
    // 話番号 → 数値7つ（PVだけ入れる）
    stubInputs(["3", "120", "", "", "", "", "", ""]);

    const result = await recordReaderStats(work);

    expect(result.changed).toBe(true);
    const saved = (readLedger().readerStats ?? [])[0];
    expect(saved.scope).toBe("episode");
    expect(saved.episode).toBe(3);
    // 「その時点の値」は粒度を持たない
    expect(saved.period).toBeUndefined();
    expect(saved.periodKey).toBeUndefined();
  });

  test("数値が1つも入らなければ、記録しない", async () => {
    bothSites();
    const before = disk.get(ledgerPath);

    stubQuickPick([
      (items) => items.find((item) => item.site === "narou"),
      (items) => items.find((item) => item.scope === "work"),
      (items) => items.find((item) => item.period === null),
    ]);
    stubInputs(["", "", "", "", "", "", ""]);

    const result = await recordReaderStats(work);

    expect(result.changed).toBe(false);
    expect(disk.get(ledgerPath)).toEqual(before);
    expect(informed.concat(warned).join("")).toContain("記録しませんでした");
  });

  /**
   * **数値の段のEscは「入力おわり」**（0.33.9のレビュー、中2）。
   *
   * 数値は7問あり、読めるのは2つか3つというのが普通である。残りを空欄で
   * 送り続けるより、Escで抜けるほうが自然な操作になる——ここで捨てると、
   * 打った値が黙って消える。取りやめの出口は、前の3つの選択画面にある
   * （順位のメモのEscを「メモ無し」として扱うのと同じ判断）。
   */
  test("数値の途中でEscを押したら、そこまでの値で記録する", async () => {
    bothSites();

    stubQuickPick([
      (items) => items.find((item) => item.site === "narou"),
      (items) => items.find((item) => item.scope === "work"),
      (items) => items.find((item) => item.period === null),
    ]);
    // PV・ユニーク・ブックマークを入れて、4問目（評価）でEsc
    stubInputs(["1234", "567", "89", undefined]);

    const result = await recordReaderStats(work);

    expect(result.changed).toBe(true);
    const saved = (readLedger().readerStats ?? [])[0];
    expect(saved.metrics).toEqual({ pv: 1234, unique: 567, bookmarks: 89 });
  });

  test("1問目でEscを押したら、記録せずに知らせる", async () => {
    bothSites();
    const before = disk.get(ledgerPath);

    stubQuickPick([
      (items) => items.find((item) => item.site === "narou"),
      (items) => items.find((item) => item.scope === "work"),
      (items) => items.find((item) => item.period === null),
    ]);
    stubInputs([undefined]);

    const result = await recordReaderStats(work);

    expect(result.changed).toBe(false);
    expect(disk.get(ledgerPath)).toEqual(before);
    expect(informed.concat(warned).join("")).toContain("記録しませんでした");
  });

  /**
   * **話番号にカンマは効かせない**（0.33.9のレビュー、L6）。
   *
   * 数値の欄は「1,234」と打たれるので区切りを落とすが、話番号で同じことを
   * すると「1,2」が12話になる——別の話の数字が混ざって、あとから分けられない。
   */
  test("話番号にカンマが入っていたら、入力欄で断る", async () => {
    bothSites();

    stubQuickPick([
      (items) => items.find((item) => item.site === "kakuyomu"),
      (items) => items.find((item) => item.scope === "episode"),
      (items) => items.find((item) => item.period === null),
    ]);
    const asked = stubInputs(["1,2", undefined]);

    await recordReaderStats(work);

    expect(asked[0].rejected).toBeTruthy();
  });
});

describe("読者の反応を貼り付けて取り込む", () => {
  function envelope(patch: Record<string, unknown> = {}): string {
    const built = JSON.parse(
      buildReaderStatsEnvelope({
        site: "kakuyomu",
        workId: "1177354054892",
        readAt: "2026-09-05T09:00:00.000Z",
        entries: [
          {
            scope: "work",
            period: "day",
            periodKey: "2026-09-05",
            metrics: { pv: 1234, likes: 12 },
          },
          { scope: "episode", episode: 3, metrics: { pv: 120 } },
        ],
      })
    ) as Record<string, unknown>;
    return JSON.stringify({ ...built, ...patch });
  }

  test("封筒を受け取って追記し、件数を知らせる", async () => {
    bothSites();
    env.clipboard.text = envelope();

    const result = await importReaderStats(work);

    expect(result.changed).toBe(true);
    const saved = readLedger().readerStats ?? [];
    expect(saved).toHaveLength(2);
    // 貼り込み係から来たことを残す（手入力と混ぜない）
    expect(saved.every((entry) => entry.source === "helper")).toBe(true);
    expect(saved[0]).toMatchObject({
      site: "kakuyomu",
      readAt: "2026-09-05T09:00:00.000Z",
      scope: "work",
      period: "day",
      periodKey: "2026-09-05",
    });
    expect(saved[1].episode).toBe(3);
    expect(informed.join("")).toContain("2件");
  });

  test("クリップボードが封筒でなければ、何も書かずに知らせる", async () => {
    bothSites();
    env.clipboard.text = "きょうは雨が降っていた。";

    const result = await importReaderStats(work);

    expect(result.changed).toBe(false);
    expect(readLedger().readerStats).toBeUndefined();
    expect(warned.join("")).toBeTruthy();
  });

  test("投稿先として登録していないサイトの封筒は取り込まない", async () => {
    writeLedger({
      schemaVersion: "1",
      sites: [{ site: "narou", newEpisodeUrl: narouUrl }],
      posts: [],
    });
    env.clipboard.text = envelope();

    const result = await importReaderStats(work);

    expect(result.changed).toBe(false);
    expect(readLedger().readerStats).toBeUndefined();
    expect(warned.join("")).toContain("カクヨム");
  });

  test("作品IDが食い違う封筒は取り込まない（取り違え防止）", async () => {
    writeLedger({
      schemaVersion: "1",
      sites: [
        { site: "narou", newEpisodeUrl: narouUrl },
        { site: "kakuyomu", newEpisodeUrl: kakuyomuUrl },
      ],
      siteProfiles: [{ site: "kakuyomu", workId: "9999999999" }],
      posts: [],
    });
    env.clipboard.text = envelope();

    const result = await importReaderStats(work);

    expect(result.changed).toBe(false);
    expect(readLedger().readerStats).toBeUndefined();
    expect(warned.join("")).toContain("作品ID");
  });

  test("なろうの封筒は受け取らない（読み取りは手入力だけ）", async () => {
    bothSites();
    env.clipboard.text = envelope({ site: "narou" });

    const result = await importReaderStats(work);

    expect(result.changed).toBe(false);
    expect(readLedger().readerStats).toBeUndefined();
    expect(warned.join("")).toContain("手入力");
  });
});
