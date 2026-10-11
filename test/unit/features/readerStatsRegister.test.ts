import * as path from "path";
import { beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import {
  ReaderStatsHelperLink,
  type FingerprintMemory,
} from "../../../src/features/readerStatsHelperLink";
import { importReaderStats } from "../../../src/features/readerStats";
import {
  DECLINED_READER_STATS_IDS_KEY,
  REGISTER_WORK_ID_LABEL,
} from "../../../src/features/readerStatsRegister";
import {
  buildReaderStatsEnvelope,
  READER_STATS_BUNDLE_KIND,
} from "../../../src/core/readerStatsEnvelope";
import {
  emptyPostingLedger,
  readPostingLedger,
  siteProfile,
  withSiteProfile,
  withSites,
  type PostingLedger,
} from "../../../src/models/posting";
import type { WorkEntry } from "../../../src/models/types";
import { env, FileSystemError, Uri, window, workspace } from "../support/vscodeStub";

/**
 * 登録の無い作品IDの読者の反応を、その場で作品に登録して取り込む（作者の裁定 2026-10-11）。
 *
 * 作者の書庫にはカクヨムの作品IDを登録した作品が1つも無く、ヘルパーで渡すたびに
 * 「この作品IDを登録した作品が見つかりませんでした」で終わっていた。確かめるのは：
 *
 *   1. 未登録のIDが届く → 知らせにボタン → 作品を選ぶ → 登録 → その場で取り込む
 *   2. 作品名だけで決めない（既定で作品を選んだことにしない）
 *   3. 選んだ作品に別のIDがあれば、確かめずに上書きしない
 *   4. 「登録しない」を覚えて、次からボタンを出さない（手で貼り付けたときは出す）
 */

const KAKUYOMU_ID = "1177354054934574437";

function work(id: string, title: string): WorkEntry {
  return {
    id,
    title,
    folderPath: path.join("C:", "novels", id),
    registeredAt: "2026-10-11T00:00:00.000Z",
  };
}

function ledgerPath(entry: WorkEntry): string {
  return Uri.file(path.join(entry.folderPath, "設定", "投稿状態.json")).fsPath;
}

const disk = new Map<string, Uint8Array>();
const informed: string[] = [];
const warned: string[] = [];
/** 注意の知らせごとのボタン（warned と同じ並び） */
const warnButtons: string[][] = [];
/** モーダルの確かめ */
const modals: string[] = [];
const picks: { items: QuickItem[]; options: { title?: string; placeHolder?: string } }[] = [];
let noticeAnswer: string | undefined;
let modalAnswer: string | undefined;
let pickItem: (items: QuickItem[]) => QuickItem | undefined;

interface QuickItem {
  label: string;
  description?: string;
  detail?: string;
  workId?: string;
  choice?: string;
}

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function writeLedger(entry: WorkEntry, ledger: PostingLedger): void {
  disk.set(ledgerPath(entry), utf8(`${JSON.stringify(ledger, null, 2)}\n`));
}

function ledgerOf(entry: WorkEntry): PostingLedger {
  const bytes = disk.get(ledgerPath(entry));
  if (!bytes) return emptyPostingLedger();
  return readPostingLedger(JSON.parse(new TextDecoder().decode(bytes))).ledger;
}

function rows(entry: WorkEntry): NonNullable<PostingLedger["readerStats"]> {
  return ledgerOf(entry).readerStats ?? [];
}

function kakuyomuItem(workId: string, readAt = "2026-10-11T10:00:00.000+09:00"): unknown {
  return JSON.parse(
    buildReaderStatsEnvelope({
      site: "kakuyomu",
      workId,
      readAt,
      entries: [{ scope: "work", metrics: { pv: 100 } }],
    })
  );
}

function bundleText(items: unknown[]): string {
  return JSON.stringify({
    kind: READER_STATS_BUNDLE_KIND,
    version: 1,
    handedAt: "2026-10-11T01:10:00.000Z",
    items,
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

let memory: MemoryStub;
let works: WorkEntry[];
let refreshed: string[];
let cheat: WorkEntry;
let other: WorkEntry;

function link(): ReaderStatsHelperLink {
  return new ReaderStatsHelperLink({
    listWorks: () => works,
    memory,
    afterImport: async (entry) => {
      refreshed.push(entry.id);
    },
  });
}

function byWork(id: string): (items: QuickItem[]) => QuickItem | undefined {
  return (items) => items.find((item) => item.workId === id);
}

function byChoice(choice: string): (items: QuickItem[]) => QuickItem | undefined {
  return (items) => items.find((item) => item.choice === choice);
}

beforeAll(() => {
  Object.assign(window, {
    createOutputChannel: () => ({
      appendLine: () => undefined,
      show() {},
      dispose() {},
    }),
  });
});

beforeEach(() => {
  disk.clear();
  informed.length = 0;
  warned.length = 0;
  warnButtons.length = 0;
  modals.length = 0;
  picks.length = 0;
  noticeAnswer = REGISTER_WORK_ID_LABEL;
  modalAnswer = undefined;
  pickItem = () => undefined;
  memory = new MemoryStub();
  refreshed = [];
  cheat = work("cheat", "教科書チート");
  other = work("other", "別の作品");
  works = [other, cheat];
  // どちらもカクヨムを登録していない（作者の書庫の実際）
  writeLedger(cheat, emptyPostingLedger());
  writeLedger(other, emptyPostingLedger());
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
    showQuickPick: async (
      items: QuickItem[],
      options: { title?: string; placeHolder?: string }
    ) => {
      picks.push({ items, options });
      return pickItem(items);
    },
    showInputBox: async () => undefined,
    showInformationMessage: async (message: string) => {
      informed.push(message);
      return undefined;
    },
    showWarningMessage: async (message: string, ...rest: unknown[]) => {
      if (typeof rest[0] === "object" && rest[0] !== null) {
        modals.push(message);
        return modalAnswer;
      }
      const buttons = rest.filter((entry): entry is string => typeof entry === "string");
      warned.push(message);
      warnButtons.push(buttons);
      return buttons.includes(REGISTER_WORK_ID_LABEL) ? noticeAnswer : undefined;
    },
    showErrorMessage: async (message: string) => {
      warned.push(message);
      warnButtons.push([]);
      return undefined;
    },
  });
});

describe("まとめて渡された分（URI）", () => {
  test("未登録のIDが届く → 知らせのボタン → 作品を選ぶ → 登録 → その場で取り込む", async () => {
    env.clipboard.text = bundleText([kakuyomuItem(KAKUYOMU_ID)]);
    pickItem = byWork("cheat");

    await link().handleUri({ path: "/import-reader-stats" });

    // 断るだけでなく、ボタンを付けて知らせる（知らせは1つ）
    expect(warned[0]).toContain(`カクヨム 作品ID ${KAKUYOMU_ID}`);
    expect(warnButtons[0]).toEqual([REGISTER_WORK_ID_LABEL]);

    await vi.waitFor(() => expect(rows(cheat)).toHaveLength(1));
    expect(siteProfile(ledgerOf(cheat), "kakuyomu")?.workId).toBe(KAKUYOMU_ID);
    // 選ばなかった作品には触らない
    expect(siteProfile(ledgerOf(other), "kakuyomu")).toBeUndefined();
    expect(rows(other)).toHaveLength(0);
    await vi.waitFor(() => expect(refreshed).toEqual(["cheat"]));
    // 取り込みの知らせに、登録したことも添える
    expect(informed.at(-1)).toContain("「教科書チート」にカクヨムの作品ID");
    expect(informed.at(-1)).toContain("読者の反応を取り込みました：「教科書チート」1画面");
  });

  test("選ぶ画面は作品名で決めない（先頭は作品でない）・IDとURLを出す・登録しないも選べる", async () => {
    env.clipboard.text = bundleText([kakuyomuItem(KAKUYOMU_ID)]);
    pickItem = () => undefined;

    await link().handleUri({ path: "/import-reader-stats" });
    await vi.waitFor(() => expect(picks).toHaveLength(1));

    const { items, options } = picks[0];
    // 先頭で Enter を押しても、どの作品にも登録しない
    expect(items[0].workId).toBeUndefined();
    expect(items.filter((item) => item.workId).map((item) => item.label)).toEqual([
      "別の作品",
      "教科書チート",
    ]);
    expect(items.some((item) => item.choice === "decline")).toBe(true);
    expect(`${options.title ?? ""}${options.placeHolder ?? ""}`).toContain(KAKUYOMU_ID);
    expect(`${options.title ?? ""}${options.placeHolder ?? ""}`).toContain(
      `https://kakuyomu.jp/works/${KAKUYOMU_ID}`
    );
    // 封筒に作品名が無いので、おすすめは出さない
    expect(items.some((item) => (item.description ?? "").includes("おすすめ"))).toBe(false);
    // 閉じたら何も書かない
    expect(siteProfile(ledgerOf(cheat), "kakuyomu")).toBeUndefined();
    expect(rows(cheat)).toHaveLength(0);
  });

  test("選んだ作品にカクヨムの別のIDがあれば、確かめて、断れば上書きしない", async () => {
    writeLedger(
      cheat,
      withSiteProfile(emptyPostingLedger(), "kakuyomu", {
        workId: "1111",
        genre: "現代ファンタジー",
      })
    );
    env.clipboard.text = bundleText([kakuyomuItem(KAKUYOMU_ID)]);
    pickItem = byWork("cheat");
    modalAnswer = undefined;

    await link().handleUri({ path: "/import-reader-stats" });

    await vi.waitFor(() => expect(modals).toHaveLength(1));
    expect(modals[0]).toContain("1111");
    expect(modals[0]).toContain(KAKUYOMU_ID);
    // 少し待っても書かない
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(siteProfile(ledgerOf(cheat), "kakuyomu")).toEqual({
      workId: "1111",
      genre: "現代ファンタジー",
    });
    expect(rows(cheat)).toHaveLength(0);
    expect(refreshed).toEqual([]);
  });

  test("確かめて「置き換える」なら、作品IDだけを替えてほかの欄は残し、取り込む", async () => {
    writeLedger(
      cheat,
      withSiteProfile(emptyPostingLedger(), "kakuyomu", {
        workId: "1111",
        genre: "現代ファンタジー",
        note: "作者のメモ",
      })
    );
    env.clipboard.text = bundleText([kakuyomuItem(KAKUYOMU_ID)]);
    pickItem = byWork("cheat");
    modalAnswer = "置き換える";

    await link().handleUri({ path: "/import-reader-stats" });

    await vi.waitFor(() => expect(rows(cheat)).toHaveLength(1));
    expect(siteProfile(ledgerOf(cheat), "kakuyomu")).toEqual({
      workId: KAKUYOMU_ID,
      genre: "現代ファンタジー",
      note: "作者のメモ",
    });
  });

  test("「登録しない」を覚えて、次からボタンを出さない（取り込めなかった理由は言う）", async () => {
    env.clipboard.text = bundleText([kakuyomuItem(KAKUYOMU_ID)]);
    pickItem = byChoice("decline");
    const helper = link();

    await helper.handleUri({ path: "/import-reader-stats" });
    await vi.waitFor(() =>
      expect(memory.get<string[]>(DECLINED_READER_STATS_IDS_KEY, [])).toEqual([
        `kakuyomu:${KAKUYOMU_ID}`,
      ])
    );
    expect(siteProfile(ledgerOf(cheat), "kakuyomu")).toBeUndefined();

    warned.length = 0;
    warnButtons.length = 0;
    informed.length = 0;
    picks.length = 0;
    await helper.handleUri({ path: "/import-reader-stats" });

    // 押したのに何も起きない、にはしない。ただしボタンは出さない
    const notices = [...warned, ...informed];
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("登録しないことにした");
    expect(warnButtons.flat()).not.toContain(REGISTER_WORK_ID_LABEL);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(picks).toHaveLength(0);
  });

  test("「登録しない」にしたIDでも、手で貼り付けて取り込むときはボタンを出し、登録すれば覚えを外す", async () => {
    await memory.update(DECLINED_READER_STATS_IDS_KEY, [`kakuyomu:${KAKUYOMU_ID}`]);
    env.clipboard.text = bundleText([kakuyomuItem(KAKUYOMU_ID)]);
    pickItem = byWork("cheat");

    await importReaderStats(cheat, {
      works,
      register: {
        memory,
        manual: true,
        afterImport: async (entry) => {
          refreshed.push(entry.id);
        },
      },
    });

    expect(warnButtons[0]).toEqual([REGISTER_WORK_ID_LABEL]);
    await vi.waitFor(() => expect(rows(cheat)).toHaveLength(1));
    await vi.waitFor(() =>
      expect(memory.get<string[]>(DECLINED_READER_STATS_IDS_KEY, [])).toEqual([])
    );
  });

  test("登録した作品の分と、未登録の分が混ざっていても、知らせは1つでボタンを付ける", async () => {
    writeLedger(other, withSiteProfile(emptyPostingLedger(), "kakuyomu", { workId: "2222" }));
    env.clipboard.text = bundleText([kakuyomuItem("2222"), kakuyomuItem(KAKUYOMU_ID)]);
    noticeAnswer = undefined;

    await link().handleUri({ path: "/import-reader-stats" });

    expect(rows(other)).toHaveLength(1);
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain("「別の作品」1画面");
    expect(warned[0]).toContain(REGISTER_WORK_ID_LABEL);
    expect(warnButtons[0]).toEqual([REGISTER_WORK_ID_LABEL]);
  });
});

describe("1件の封筒（URI）", () => {
  test("どの作品とも照合できなければ、ボタンを付けて知らせ、選んだ作品に登録して取り込む", async () => {
    // なろうだけ登録した作品がある（カクヨムの封筒はどこも通らない）
    writeLedger(
      other,
      withSites(emptyPostingLedger(), [
        { site: "narou", newEpisodeUrl: "https://syosetu.com/usernovelmanage/top/" },
      ])
    );
    env.clipboard.text = JSON.stringify(kakuyomuItem(KAKUYOMU_ID));
    pickItem = byWork("cheat");

    await link().handleUri({ path: "/import-reader-stats" });

    expect(warned[0]).toContain(KAKUYOMU_ID);
    expect(warnButtons[0]).toEqual([REGISTER_WORK_ID_LABEL]);
    await vi.waitFor(() => expect(rows(cheat)).toHaveLength(1));
    expect(siteProfile(ledgerOf(cheat), "kakuyomu")?.workId).toBe(KAKUYOMU_ID);
    await vi.waitFor(() => expect(refreshed).toEqual(["cheat"]));
  });
});
