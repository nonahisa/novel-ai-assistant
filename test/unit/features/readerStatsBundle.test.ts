import * as path from "path";
import { beforeAll, beforeEach, describe, expect, test } from "vitest";
import {
  ReaderStatsHelperLink,
  type FingerprintMemory,
} from "../../../src/features/readerStatsHelperLink";
import { importReaderStats } from "../../../src/features/readerStats";
import {
  buildReaderStatsEnvelope,
  READER_STATS_BUNDLE_KIND,
  type ReaderStatsEnvelopeEntry,
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
 * まとめて渡された読者の反応（ヘルパー 0.9.0 の「まとめて渡す」）を取り込む。
 *
 * ヘルパーは開いた画面ごとに溜めた封筒を1つにまとめてクリップボードへ置き、
 * `vscode://nonahisa.novel-ai-assistant/import-reader-stats` を開く。確かめるのは：
 *
 *   1. 2つの作品の画面が混ざっていても、作品ごとに振り分けて取り込む
 *   2. 同じ作品の作品管理とアクセス数が重なっても、二重に積まない
 *   3. 作品の決まらない画面は取り込まず、残りを止めずに理由を1つの知らせで言う
 *   4. 知らない版なら何も書かず、両方を新しくするよう言う
 *   5. URI・窓に戻ったとき・「貼り付けて取り込む」のどれからでも同じに取り込める
 */

function work(id: string, title: string): WorkEntry {
  return {
    id,
    title,
    folderPath: path.join("C:", "novels", id),
    registeredAt: "2026-09-23T00:00:00.000Z",
  };
}

function ledgerPath(entry: WorkEntry): string {
  return Uri.file(path.join(entry.folderPath, "設定", "投稿状態.json")).fsPath;
}

const disk = new Map<string, Uint8Array>();
const informed: string[] = [];
const warned: string[] = [];
const logged: string[] = [];
let answer: string | undefined;
/** この文字を含む場所へ書こうとしたら失敗させる（1つの作品の保存の失敗） */
let failWritesUnder: string | undefined;

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function writeLedger(entry: WorkEntry, ledger: PostingLedger): void {
  disk.set(ledgerPath(entry), utf8(`${JSON.stringify(ledger, null, 2)}\n`));
}

function rows(entry: WorkEntry): NonNullable<PostingLedger["readerStats"]> {
  const bytes = disk.get(ledgerPath(entry));
  if (!bytes) return [];
  return (
    readPostingLedger(JSON.parse(new TextDecoder().decode(bytes))).ledger.readerStats ?? []
  );
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

function onNarou(workId: string): PostingLedger {
  return withSiteProfile(
    withSites(emptyPostingLedger(), [
      { site: "narou", newEpisodeUrl: "https://syosetu.com/usernovelmanage/top/" },
    ]),
    "narou",
    { workId }
  );
}

function kakuyomuItem(
  workId: string | undefined,
  readAt: string,
  entries: ReaderStatsEnvelopeEntry[] = [{ scope: "work", metrics: { pv: 100 } }]
): unknown {
  return JSON.parse(buildReaderStatsEnvelope({ site: "kakuyomu", workId, readAt, entries }));
}

function narouFunItem(workId: string): unknown {
  return JSON.parse(
    buildReaderStatsEnvelope({
      site: "narou",
      source: "narou.fun",
      workId,
      readAt: "2026-09-23T01:00:00.000Z",
      readAtBasis: "fetched",
      entries: [{ scope: "work", metrics: { points: 1200, bookmarks: 300 } }],
    })
  );
}

function bundleText(items: unknown[], version: unknown = 1): string {
  return JSON.stringify({
    kind: READER_STATS_BUNDLE_KIND,
    version,
    handedAt: "2026-09-23T05:10:00.000Z",
    items,
  });
}

/** 2作品の画面（作品A 2画面・作品B 1画面・どちらでもない 1画面） */
function mixedBundle(): string {
  return bundleText([
    kakuyomuItem("1111", "2026-09-23T10:00:00.000+09:00"),
    narouFunItem("N1234AB"),
    kakuyomuItem("9999", "2026-09-23T10:01:00.000+09:00"),
    kakuyomuItem("1111", "2026-09-23T10:02:00.000+09:00", [
      { scope: "episode", episode: 1, metrics: { pv: 20 } },
    ]),
  ]);
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

let memory: MemoryStub;
let works: WorkEntry[];
let refreshed: string[];
let workA: WorkEntry;
let workB: WorkEntry;

function link(): ReaderStatsHelperLink {
  return new ReaderStatsHelperLink({
    listWorks: () => works,
    memory,
    afterImport: async (entry) => {
      refreshed.push(entry.id);
    },
  });
}

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
  answer = undefined;
  failWritesUnder = undefined;
  memory = new MemoryStub();
  refreshed = [];
  workA = work("wa", "作品A");
  workB = work("wb", "作品B");
  works = [workA, workB];
  writeLedger(workA, onKakuyomu("1111"));
  writeLedger(workB, onNarou("n1234ab"));
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
      // 区切り（\ と /）とドライブ名の大小に依らずに比べる
      if (
        failWritesUnder &&
        uri.fsPath.replace(/\\/g, "/").toLowerCase().includes(failWritesUnder)
      ) {
        throw new Error("書き込めませんでした（試験）");
      }
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
      if (!disk.has(uri.fsPath)) throw new FileSystemError("missing", "FileNotFound");
      return { type: 1, ctime: 0, mtime: 0, size: 0 };
    },
  } as unknown as typeof workspace.fs;

  Object.assign(window, {
    showQuickPick: async () => {
      throw new Error("まとめて渡された分では、作品を選ばせない");
    },
    showInputBox: async () => undefined,
    showInformationMessage: async (message: string, ...buttons: string[]) => {
      informed.push(message);
      return buttons.length > 0 ? answer : undefined;
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

describe("URI で呼ばれたとき", () => {
  test("2つの作品の画面を振り分けて取り込み、1つの知らせで作品ごとの画面の数を言う", async () => {
    env.clipboard.text = mixedBundle();

    await link().handleUri({ path: "/import-reader-stats" });

    expect(rows(workA)).toHaveLength(2);
    expect(rows(workA).every((row) => row.site === "kakuyomu")).toBe(true);
    expect(rows(workB)).toHaveLength(1);
    expect(rows(workB)[0]).toMatchObject({ site: "narou", metrics: { points: 1200 } });
    // 取り込めないものがあるので注意の知らせ1つ（画面ごとに出さない）
    expect(informed).toEqual([]);
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain("読者の反応を取り込みました：「作品A」2画面・「作品B」1画面");
    expect(warned[0]).toContain("取り込めなかったもの（1画面）：カクヨム 作品ID 9999");
    expect(warned[0]).toContain("「投稿サイトの設定」で作品IDを登録");
    expect(refreshed).toEqual(["wa", "wb"]);
  });

  test("同じ作品の作品管理とアクセス数が重なっても、二重に積まない", async () => {
    const days: ReaderStatsEnvelopeEntry[] = [
      { scope: "work", period: "day", periodKey: "2026-09-21", metrics: { pv: 30 } },
      { scope: "work", period: "day", periodKey: "2026-09-22", metrics: { pv: 40 } },
    ];
    env.clipboard.text = bundleText([
      kakuyomuItem("1111", "2026-09-23T10:00:00.000+09:00", [
        { scope: "work", metrics: { pv: 500 } },
        ...days,
      ]),
      kakuyomuItem("1111", "2026-09-23T10:02:00.000+09:00", [
        ...days,
        { scope: "episode", episode: 1, metrics: { pv: 200 } },
      ]),
    ]);

    await link().handleUri({ path: "/import-reader-stats" });

    expect(rows(workA)).toHaveLength(4);
    expect(rows(workA).filter((row) => row.period === "day")).toHaveLength(2);
    expect(informed).toHaveLength(1);
    expect(informed[0]).toContain("「作品A」2画面（同じ数で積まなかったもの 2件）");
  });

  test("同じ束をもう一度渡されても積まず、変えていないと言う", async () => {
    env.clipboard.text = bundleText([kakuyomuItem("1111", "2026-09-23T10:00:00.000+09:00")]);
    const helper = link();

    await helper.handleUri({ path: "/import-reader-stats" });
    await helper.handleUri({ path: "/import-reader-stats" });

    expect(rows(workA)).toHaveLength(1);
    expect(informed.at(-1)).toContain("すでに取り込んだ数と同じでした");
  });

  test("1つの作品の保存に失敗しても、ほかの作品は取り込む", async () => {
    failWritesUnder = `/novels/${workA.id}/`;
    env.clipboard.text = mixedBundle();

    await link().handleUri({ path: "/import-reader-stats" });

    expect(rows(workA)).toHaveLength(0);
    expect(rows(workB)).toHaveLength(1);
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain("「作品B」1画面");
    expect(warned[0]).toContain("「作品A」の2画面：保存できませんでした");
    expect(refreshed).toEqual(["wb"]);
  });

  test("知らない版なら何も書かず、両方を新しくするよう言う", async () => {
    env.clipboard.text = bundleText(
      [kakuyomuItem("1111", "2026-09-23T10:00:00.000+09:00")],
      2
    );

    await link().handleUri({ path: "/import-reader-stats" });

    expect(rows(workA)).toHaveLength(0);
    expect(warned).toEqual(["ヘルパーと統合小説執筆環境の片方が古いようです。両方を新しくしてください。"]);
  });

  test("どの画面も作品が決まらなければ、何も書かずに理由と直し方を言う", async () => {
    env.clipboard.text = bundleText([
      kakuyomuItem("9999", "2026-09-23T10:00:00.000+09:00"),
      kakuyomuItem(undefined, "2026-09-23T10:01:00.000+09:00"),
    ]);

    await link().handleUri({ path: "/import-reader-stats" });

    expect(rows(workA)).toHaveLength(0);
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain("読者の反応を取り込めませんでした。");
    expect(warned[0]).toContain("作品IDが入っていない");
    expect(refreshed).toEqual([]);
  });
});

describe("VS Code に戻ったとき", () => {
  test("まだ取り込んでいない画面を作品ごとに言って1度だけ訊き、「取り込む」で振り分ける", async () => {
    env.clipboard.text = mixedBundle();
    answer = "取り込む";
    const helper = link();

    await helper.checkOnFocus();

    expect(informed[0]).toContain("まとめて渡した読者の反応");
    expect(informed[0]).toContain("「作品A」2画面・「作品B」1画面");
    expect(rows(workA)).toHaveLength(2);
    expect(rows(workB)).toHaveLength(1);

    // 同じデータでは二度訊かない
    informed.length = 0;
    await helper.checkOnFocus();
    expect(informed).toEqual([]);
  });

  test("「取り込まない」なら書かず、同じデータで二度訊かない", async () => {
    env.clipboard.text = mixedBundle();
    answer = "取り込まない";
    const helper = link();

    await helper.checkOnFocus();
    await helper.checkOnFocus();

    expect(informed).toHaveLength(1);
    expect(rows(workA)).toHaveLength(0);
  });

  test("もう取り込んである画面しか無ければ訊かない（「貼り付けて取り込む」で入れたあと、など）", async () => {
    env.clipboard.text = mixedBundle();
    await importReaderStats(workA, { works });
    informed.length = 0;
    warned.length = 0;

    await link().checkOnFocus();

    expect(informed).toEqual([]);
    expect(warned).toEqual([]);
  });

  test("作品の決まる画面が1つも無ければ訊かない", async () => {
    env.clipboard.text = bundleText([kakuyomuItem("9999", "2026-09-23T10:00:00.000+09:00")]);

    await link().checkOnFocus();

    expect(informed).toEqual([]);
    expect(warned).toEqual([]);
  });

  test("知らない版は、理由を1度だけ言う", async () => {
    env.clipboard.text = bundleText([kakuyomuItem("1111", "2026-09-23T10:00:00.000+09:00")], 9);
    const helper = link();

    await helper.checkOnFocus();
    await helper.checkOnFocus();

    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain("片方が古い");
  });
});

describe("「読者の反応を貼り付けて取り込む」", () => {
  test("まとめて渡された分を貼っても、登録した作品ぜんぶへ振り分ける", async () => {
    env.clipboard.text = mixedBundle();

    const result = await importReaderStats(workA, { works });

    expect(result.changed).toBe(true);
    expect(result.changedWorks?.map((entry) => entry.id)).toEqual(["wa", "wb"]);
    expect(rows(workA)).toHaveLength(2);
    expect(rows(workB)).toHaveLength(1);
  });

  test("作品の一覧を渡されなければ、選んだ作品の分だけを取り込む", async () => {
    env.clipboard.text = mixedBundle();

    const result = await importReaderStats(workA);

    expect(result.changedWorks?.map((entry) => entry.id)).toEqual(["wa"]);
    expect(rows(workA)).toHaveLength(2);
    expect(rows(workB)).toHaveLength(0);
    expect(warned[0]).toContain("取り込めなかったもの（2画面）");
  });

  test("1件の封筒は、これまでどおり1件の道で取り込む", async () => {
    env.clipboard.text = JSON.stringify(
      kakuyomuItem("1111", "2026-09-23T10:00:00.000+09:00")
    );

    const result = await importReaderStats(workA, { works });

    expect(result).toEqual({ changed: true });
    expect(rows(workA)).toHaveLength(1);
    expect(informed[0]).toContain("カクヨム の読者の反応を 1件 取り込みました");
  });
});
