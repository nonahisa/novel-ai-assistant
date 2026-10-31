import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import * as vscode from "vscode";
import {
  IMPORT_ARRIVED_LABEL,
  UNREGISTERED_OWN_WORKS_KEY,
  UnregisteredOwnWorks,
  type OwnWorksMemory,
  type UnregisteredOwnWorksDeps,
} from "../../../src/features/unregisteredOwnWorks";
import { IMPORT_ANYWAY_LABEL } from "../../../src/features/ownWorkBackupImport";
import { BACKUP_WAIT_LIMIT_MS, type DownloadFolderLister } from "../../../src/core/backupArrivalWatch";
import type { UnregisteredOwnWork } from "../../../src/core/unregisteredOwnWorks";
import type { ReaderStatsEnvelope } from "../../../src/core/readerStatsEnvelope";
import type { WorkEntry } from "../../../src/models/types";

/**
 * 「未登録の自分の作品」の枠の操作（作者の指示 2026-11-01。設計書6.99.8）。
 *
 * - ［バックアップを取る］はサイトごとの画面を開き、**開く前に**待ちを始める
 * - なろうの数字ID が無ければ訊いて覚える。訊くのをやめたら何も開かない
 * - 届いたら訊く（勝手に取り込まない）。30分で止まる
 * - 取り込む前に中身を照らし、食い違えば止めて訊く
 * - ブラウザ版（フォルダーを見られない）では待たない
 */

type Stub = typeof vscode.window & Record<string, unknown>;
const win = vscode.window as Stub;
const original = {
  showInformationMessage: win.showInformationMessage,
  showWarningMessage: win.showWarningMessage,
  showInputBox: win.showInputBox,
};
const fsStub = vscode.workspace.fs as unknown as Record<string, unknown>;

class Memory implements OwnWorksMemory {
  readonly values = new Map<string, unknown>();
  get<T>(key: string, defaultValue: T): T {
    return (this.values.has(key) ? this.values.get(key) : defaultValue) as T;
  }
  async update(key: string, value: unknown): Promise<void> {
    this.values.set(key, value);
  }
}

/** 一時フォルダーの代わりの、名前と大きさだけを持つフォルダー */
class FakeFolder implements DownloadFolderLister {
  readonly files = new Map<string, number>();
  async names() {
    return [...this.files.keys()];
  }
  async size(name: string) {
    return this.files.get(name);
  }
}

const KAKUYOMU: UnregisteredOwnWork = {
  site: "kakuyomu",
  workId: "16818093000000000001",
  title: "氷の街の約束",
  ownedVia: "owner-page",
  lastSeenAt: "2026-11-01T10:00:00.000Z",
};
const NAROU: UnregisteredOwnWork = { ...KAKUYOMU, site: "narou", workId: "n4190fx" };
const ALPHAPOLIS: UnregisteredOwnWork = { ...KAKUYOMU, site: "alphapolis", workId: "123456789" };

const ALPHAPOLIS_TEXT = [
  "第一章『はじまり』",
  "１話　出会い",
  "",
  "　氷の街で、二人は出会った。",
  "",
  "２話　約束",
  "",
  "　春になったら、また会おうと言った。",
  "",
].join("\r\n");

let memory: Memory;
let folder: FakeFolder;
let opened: string[];
let order: string[];
let clock: number;
let tick: (() => void) | undefined;
let infos: string[];
let importAsNew: ReturnType<typeof vi.fn>;

function service(over: Partial<UnregisteredOwnWorksDeps> = {}): UnregisteredOwnWorks {
  return new UnregisteredOwnWorks(memory, {
    importAsNew: importAsNew as unknown as UnregisteredOwnWorksDeps["importAsNew"],
    openLink: async (url) => {
      order.push("open");
      opened.push(url);
    },
    canWatch: () => true,
    downloadFolder: async () => "C:/Users/someone/Downloads",
    lister: async () => ({
      names: async () => {
        order.push("names");
        return folder.names();
      },
      size: (name) => folder.size(name),
    }),
    schedule: (fn) => {
      tick = fn;
      return { dispose: () => (tick = undefined) };
    },
    now: () => clock,
    ...over,
  });
}

function remember(...entries: UnregisteredOwnWork[]): void {
  memory.values.set(UNREGISTERED_OWN_WORKS_KEY, entries);
}

beforeEach(() => {
  memory = new Memory();
  folder = new FakeFolder();
  opened = [];
  order = [];
  clock = Date.parse("2026-11-01T10:00:00.000Z");
  tick = undefined;
  infos = [];
  importAsNew = vi.fn(async () => ({ id: "new", title: "氷の街の約束", folderPath: "C:/w", registeredAt: "x" }) as WorkEntry);
  win.showInformationMessage = (async (message: string) => {
    infos.push(message);
    return undefined;
  }) as Stub["showInformationMessage"];
});

afterEach(() => {
  win.showInformationMessage = original.showInformationMessage;
  win.showWarningMessage = original.showWarningMessage;
  win.showInputBox = original.showInputBox;
  delete fsStub.readFile;
});

describe("［バックアップを取る］", () => {
  test("カクヨムは作品管理の画面を開き、メニューから落とすよう案内する。開く前に待ちを始める", async () => {
    remember(KAKUYOMU);
    const own = service();
    await own.fetchBackup(KAKUYOMU);
    expect(opened).toEqual(["https://kakuyomu.jp/my/works/16818093000000000001"]);
    expect(order.indexOf("names")).toBeLessThan(order.indexOf("open"));
    expect(own.isWaiting(KAKUYOMU)).toBe(true);
    expect(infos.at(-1)).toContain("「小説をバックアップ」から");
  });

  test("アルファポリスは書き出しの URL を開く", async () => {
    remember(ALPHAPOLIS);
    await service().fetchBackup(ALPHAPOLIS);
    expect(opened).toEqual(["https://www.alphapolis.co.jp/mypage/novel/export/123456789/UTF-8/LF"]);
  });

  test("なろうは数字ID が無ければ訊き、覚えてからバックアップの画面を開く", async () => {
    remember(NAROU);
    const asked: unknown[] = [];
    win.showInputBox = (async (options: unknown) => {
      asked.push(options);
      return "https://syosetu.com/usernovelmanage/top/ncode/1702430/";
    }) as Stub["showInputBox"];
    const own = service();
    await own.fetchBackup(NAROU);
    expect(asked).toHaveLength(1);
    expect(opened).toEqual(["https://syosetu.com/backup/top/ncode/1702430/"]);
    expect(own.list()[0].narouBackupId).toBe("1702430");

    // 2回目は訊かない
    await own.fetchBackup(own.list()[0]);
    expect(asked).toHaveLength(1);
  });

  test("なろうの数字ID を訊くのをやめたら、何も開かず待ちもしない", async () => {
    remember(NAROU);
    win.showInputBox = (async () => undefined) as Stub["showInputBox"];
    const own = service();
    await own.fetchBackup(NAROU);
    expect(opened).toEqual([]);
    expect(own.isWaiting(NAROU)).toBe(false);
  });

  test("フォルダーを見られないところ（ブラウザ版）では開かず、理由を言う", async () => {
    remember(KAKUYOMU);
    const own = service({ canWatch: () => false });
    await own.fetchBackup(KAKUYOMU);
    expect(opened).toEqual([]);
    expect(infos.at(-1)).toContain("ブラウザ版");
  });
});

describe("待ち", () => {
  test("押したあとに来たバックアップらしい名前に気づいて訊く（押す前のファイルと別の名前は無視）", async () => {
    remember(KAKUYOMU);
    folder.files.set("氷の街の約束_20261001.zip", 10); // 押す前からあった
    const own = service();
    await own.fetchBackup(KAKUYOMU);
    folder.files.set("請求書.pdf", 5);
    folder.files.set("氷の街の約束_20261101.zip", 20);
    await own.pollNow(KAKUYOMU);
    await own.pollNow(KAKUYOMU);
    const asked = infos.filter((message) => message.includes("届きました"));
    expect(asked).toEqual([
      "「氷の街の約束」のバックアップ（氷の街の約束_20261101.zip）が届きました。取り込みますか？",
    ]);
    // 訊いただけで取り込まない
    expect(importAsNew).not.toHaveBeenCalled();
    expect(tick).toBeDefined();
  });

  test("30分で止まり、そう知らせる", async () => {
    remember(KAKUYOMU);
    const own = service();
    await own.fetchBackup(KAKUYOMU);
    clock += BACKUP_WAIT_LIMIT_MS;
    await own.pollNow(KAKUYOMU);
    expect(own.isWaiting(KAKUYOMU)).toBe(false);
    expect(tick).toBeUndefined();
    expect(infos.at(-1)).toContain("30分待ちましたが");
  });

  test("［取り込む］を押すと届いたファイルを読んで取り込み、枠を忘れて待ちを止める", async () => {
    remember(ALPHAPOLIS);
    fsStub.readFile = async () => new TextEncoder().encode(ALPHAPOLIS_TEXT);
    let answered: Promise<unknown> | undefined;
    win.showInformationMessage = ((message: string) => {
      infos.push(message);
      const answer = message.includes("届きました") ? IMPORT_ARRIVED_LABEL : undefined;
      answered = Promise.resolve(answer);
      return answered;
    }) as Stub["showInformationMessage"];
    const own = service();
    await own.fetchBackup(ALPHAPOLIS);
    folder.files.set("氷の街の約束.txt", 100);
    await own.pollNow(ALPHAPOLIS);
    await own.pollNow(ALPHAPOLIS);
    // 押されたあとの処理（`whenNoticePicked`）が終わるのを待つ
    await vi.waitFor(() => expect(importAsNew).toHaveBeenCalledTimes(1));
    expect(importAsNew.mock.calls[0][1]).toEqual({ site: "alphapolis", workId: "123456789" });
    await vi.waitFor(() => expect(own.list()).toEqual([]));
    expect(own.isWaiting(ALPHAPOLIS)).toBe(false);
  });
});

describe("取り込む前に照らす", () => {
  test("題が合えば、枠のサイトと作品ID を引き継いで取り込みへ渡す", async () => {
    remember(ALPHAPOLIS);
    const work = await service().importBytes(ALPHAPOLIS, {
      fileName: "氷の街の約束 (1).txt",
      bytes: new TextEncoder().encode(ALPHAPOLIS_TEXT),
    });
    expect(work?.id).toBe("new");
    expect(importAsNew).toHaveBeenCalledTimes(1);
    expect(importAsNew.mock.calls[0][1]).toEqual({ site: "alphapolis", workId: "123456789" });
  });

  test("食い違えば止めて訊き、やめたら取り込まない（枠は残る）", async () => {
    remember(ALPHAPOLIS);
    const warned: string[] = [];
    win.showWarningMessage = (async (message: string) => {
      warned.push(message);
      return undefined;
    }) as Stub["showWarningMessage"];
    const own = service();
    const work = await own.importBytes(ALPHAPOLIS, {
      fileName: "炎の街.txt",
      bytes: new TextEncoder().encode(ALPHAPOLIS_TEXT),
    });
    expect(work).toBeUndefined();
    expect(warned[0]).toContain("ではないかもしれません");
    expect(importAsNew).not.toHaveBeenCalled();
    expect(own.list()).toHaveLength(1);
  });

  test("食い違っても［それでも取り込む］なら取り込みへ渡す", async () => {
    remember(ALPHAPOLIS);
    win.showWarningMessage = (async () => IMPORT_ANYWAY_LABEL) as Stub["showWarningMessage"];
    await service().importBytes(ALPHAPOLIS, {
      fileName: "炎の街.txt",
      bytes: new TextEncoder().encode(ALPHAPOLIS_TEXT),
    });
    expect(importAsNew).toHaveBeenCalledTimes(1);
  });

  test("バックアップとして読めない名前は読まずに断る", async () => {
    remember(ALPHAPOLIS);
    await service().importBytes(ALPHAPOLIS, { fileName: "写真.png", bytes: new Uint8Array([1]) });
    expect(importAsNew).not.toHaveBeenCalled();
  });
});

describe("覚えと出さない", () => {
  test("本人しか開けない画面で読んだ作品を覚え、出さないを選んだら印を付ける", async () => {
    const own = service();
    let fired = 0;
    own.onDidChange(() => fired++);
    await own.note([
      {
        format: "novelai-stats",
        version: 1,
        site: "kakuyomu",
        workId: "999",
        readAt: "2026-11-01T00:00:00.000Z",
        title: "届いた作品",
        ownedVia: "owner-page",
        entries: [],
      } as unknown as ReaderStatsEnvelope,
    ]);
    expect(own.list().map((entry) => entry.title)).toEqual(["届いた作品"]);
    await own.hide(own.list()[0]);
    expect(own.list()[0].hidden).toBe(true);
    expect(fired).toBe(2);
  });
});
