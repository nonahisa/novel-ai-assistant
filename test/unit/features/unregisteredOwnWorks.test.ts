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
import {
  buildReaderStatsEnvelope,
  parseReaderStatsEnvelope,
  type ReaderStatsEnvelope,
} from "../../../src/core/readerStatsEnvelope";
import type { WorkEntry } from "../../../src/models/types";

/**
 * 「未登録の自分の作品」の枠の操作（作者の指示 2026-11-01。設計書6.99.8）。
 *
 * - ［バックアップを取る］はサイトごとの画面を開き、**開く前に**待ちを始める
 * - なろうの数字ID が無ければ訊いて覚える。訊くのをやめたら何も開かない
 * - 届いたら訊かずに取り込む（作者の判断 2026-11-01）。どの作品のものか決まらない・
 *   登録済みのときだけ訊くか理由を言う。30分で止まる
 * - 管理画面で読んだ未登録の作品の読者の反応は控え、登録されたら取り込みへ渡す
 * - 取り込む前に中身を照らし、食い違えば止めて訊く
 * - ブラウザ版（フォルダーを見られない）では待たない
 */

type Stub = typeof vscode.window & Record<string, unknown>;
const win = vscode.window as Stub;
const original = {
  showInformationMessage: win.showInformationMessage,
  showWarningMessage: win.showWarningMessage,
  showInputBox: win.showInputBox,
  showQuickPick: win.showQuickPick,
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
  win.showQuickPick = original.showQuickPick;
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
  /*
    作者の判断（2026-11-01）「届いたバックアップは訊かずに取り込む」。0.119.0 までは
    「取り込みますか？」と訊いて、［取り込む］を押されるまで取り込まなかった
  */
  test("押したあとに来たバックアップらしいファイルを、訊かずに取り込んで登録する（押す前のファイルと別の名前は無視）", async () => {
    remember(ALPHAPOLIS);
    folder.files.set("氷の街の約束 (1).txt", 10); // 押す前からあった
    const read: string[] = [];
    fsStub.readFile = async (uri: { fsPath?: string; path?: string }) => {
      read.push(String(uri.path ?? uri.fsPath));
      return new TextEncoder().encode(ALPHAPOLIS_TEXT);
    };
    const own = service();
    await own.fetchBackup(ALPHAPOLIS);
    expect(infos.at(-1)).toContain("そのまま取り込んで登録します");
    folder.files.set("請求書.pdf", 5);
    folder.files.set("氷の街の約束.txt", 20);
    await own.pollNow(ALPHAPOLIS);
    await own.pollNow(ALPHAPOLIS);
    await vi.waitFor(() => expect(importAsNew).toHaveBeenCalledTimes(1));
    // 訊かない
    expect(infos.some((message) => message.includes("取り込みますか"))).toBe(false);
    expect(importAsNew.mock.calls[0][1]).toMatchObject({ site: "alphapolis", workId: "123456789" });
    // 訊かずに進む印（届いたファイルの名前）が取り込みへ渡る
    expect(importAsNew.mock.calls[0][2]).toMatchObject({ fileName: "氷の街の約束.txt" });
    // 読んだのは届いたファイルだけ（押す前からあったもの・別の名前は開かない）
    expect(read).toHaveLength(1);
    expect(read[0]).toContain("氷の街の約束.txt");
    expect(read[0]).not.toContain("(1)");
    await vi.waitFor(() => expect(own.list()).toEqual([]));
    expect(own.isWaiting(ALPHAPOLIS)).toBe(false);
  });

  test("一度に2つ届いたら、どれを取り込むか訊く（訊いただけでは取り込まない）", async () => {
    remember(ALPHAPOLIS);
    const own = service();
    await own.fetchBackup(ALPHAPOLIS);
    folder.files.set("氷の街の約束.txt", 20);
    folder.files.set("氷の街の約束 (1).txt", 30);
    await own.pollNow(ALPHAPOLIS);
    await own.pollNow(ALPHAPOLIS);
    await vi.waitFor(() =>
      expect(infos.filter((message) => message.includes("取り込みますか"))).toHaveLength(2)
    );
    expect(infos.find((message) => message.includes("取り込みますか"))).toContain(
      "一度に複数のファイルが届いたため"
    );
    expect(importAsNew).not.toHaveBeenCalled();
  });

  test("名前がほかの枠の作品にも当たるときは、どの作品のものか決まらないので訊く", async () => {
    const sequel: UnregisteredOwnWork = {
      ...ALPHAPOLIS,
      workId: "987654321",
      title: "氷の街の約束　～別視点～",
    };
    remember(ALPHAPOLIS, sequel);
    const own = service();
    await own.fetchBackup(ALPHAPOLIS);
    // 「氷の街の約束」は別視点の題の頭でもある
    folder.files.set("氷の街の約束.txt", 20);
    await own.pollNow(ALPHAPOLIS);
    await own.pollNow(ALPHAPOLIS);
    await vi.waitFor(() =>
      expect(infos.some((message) => message.includes("取り込みますか"))).toBe(true)
    );
    expect(infos.find((message) => message.includes("取り込みますか"))).toContain(
      "どの作品のものか決められませんでした"
    );
    expect(importAsNew).not.toHaveBeenCalled();
  });

  test("同じ作品がもう登録されていれば、取り込まずに理由を言い、待ちを止める（ファイルには触らない）", async () => {
    remember(ALPHAPOLIS);
    let read = 0;
    fsStub.readFile = async () => {
      read++;
      return new TextEncoder().encode(ALPHAPOLIS_TEXT);
    };
    const own = service({ registeredKeys: async () => new Set(["alphapolis:123456789"]) });
    await own.fetchBackup(ALPHAPOLIS);
    folder.files.set("氷の街の約束.txt", 20);
    await own.pollNow(ALPHAPOLIS);
    await own.pollNow(ALPHAPOLIS);
    await vi.waitFor(() =>
      expect(infos.some((message) => message.includes("もう登録してある作品なので"))).toBe(true)
    );
    expect(importAsNew).not.toHaveBeenCalled();
    expect(read).toBe(0);
    expect(own.isWaiting(ALPHAPOLIS)).toBe(false);
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

  test("訊いたときに［取り込む］を押すと、届いたファイルを読んで取り込む（訊いて取り込むときは確かめの窓を省かない）", async () => {
    remember(ALPHAPOLIS);
    fsStub.readFile = async () => new TextEncoder().encode(ALPHAPOLIS_TEXT);
    win.showInformationMessage = ((message: string) => {
      infos.push(message);
      return Promise.resolve(message.includes("取り込みますか") ? IMPORT_ARRIVED_LABEL : undefined);
    }) as Stub["showInformationMessage"];
    const own = service();
    await own.fetchBackup(ALPHAPOLIS);
    folder.files.set("氷の街の約束.txt", 100);
    folder.files.set("氷の街の約束 (1).txt", 100);
    await own.pollNow(ALPHAPOLIS);
    await own.pollNow(ALPHAPOLIS);
    // 押されたあとの処理（`whenNoticePicked`）が終わるのを待つ
    await vi.waitFor(() => expect(importAsNew).toHaveBeenCalled());
    expect(importAsNew.mock.calls[0][1]).toMatchObject({ site: "alphapolis", workId: "123456789" });
    expect(importAsNew.mock.calls[0][2]).toBeUndefined();
    await vi.waitFor(() => expect(own.list()).toEqual([]));
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
    expect(importAsNew.mock.calls[0][1]).toMatchObject({ site: "alphapolis", workId: "123456789" });
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

  test("［出さないにした作品を戻す］は出さないにした作品だけを並べ、選んだものを戻す", async () => {
    remember(
      { ...KAKUYOMU, hidden: true },
      { ...ALPHAPOLIS, title: "別の作品", hidden: true },
      { ...NAROU, title: "出している作品" }
    );
    const shown: string[] = [];
    win.showQuickPick = (async (items: readonly { label: string }[]) => {
      shown.push(...items.map((item) => item.label));
      return [items[0]];
    }) as unknown as Stub["showQuickPick"];
    const own = service();
    await own.restoreHidden();
    expect(shown).toEqual(["氷の街の約束", "別の作品"]);
    const byTitle = new Map(own.list().map((entry) => [entry.title, entry.hidden]));
    expect(byTitle.get("氷の街の約束")).toBeUndefined();
    expect(byTitle.get("別の作品")).toBe(true);
  });

  test("［出さないにした作品を戻す］で何も選ばなければ変えない", async () => {
    remember({ ...KAKUYOMU, hidden: true });
    win.showQuickPick = (async () => undefined) as Stub["showQuickPick"];
    const own = service();
    await own.restoreHidden();
    expect(own.list()[0].hidden).toBe(true);
  });
});

describe("読者の反応の控え", () => {
  function ownEnvelope(over: Record<string, unknown> = {}): ReaderStatsEnvelope {
    const parsed = parseReaderStatsEnvelope(
      buildReaderStatsEnvelope({
        site: "kakuyomu",
        workId: "16816927861924296900",
        readAt: "2026-11-01T07:47:50.743Z",
        title: "星の数ほどいるクズ",
        ownedVia: "owner-page",
        entries: [{ scope: "work", metrics: { pv: 120 } }],
        ...over,
      })
    );
    if (!parsed.ok) throw new Error(parsed.reason);
    return parsed.envelope;
  }

  test("管理画面で読んだ未登録の作品の数を控え、登録されたら控えから取り込みへ渡す", async () => {
    let registered = new Set<string>();
    const handed: ReaderStatsEnvelope[][] = [];
    const own = service({
      registeredKeys: async () => registered,
      importHeldStats: async (envelopes, lead) => {
        handed.push([...envelopes]);
        expect(lead).toContain("控えておいた読者の反応");
        return [];
      },
    });
    await own.note([ownEnvelope(), ownEnvelope({ ownedVia: "approved", workId: "1" })]);
    // 本人しか開けない画面の分だけ控える
    expect(own.pendingStats().map((envelope) => envelope.workId)).toEqual(["16816927861924296900"]);

    // まだ登録されていなければ渡さない
    await own.settleRegistered(registered);
    expect(handed).toEqual([]);

    // ほかの道（投稿サイト設定など）で同じサイト・作品ID が登録された
    registered = new Set(["kakuyomu:16816927861924296900"]);
    await own.settleRegistered(registered);
    expect(handed).toHaveLength(1);
    expect(handed[0][0].entries).toEqual(ownEnvelope().entries);
    // 渡して台帳に入った分は控えから外し、枠からも外す
    expect(own.pendingStats()).toEqual([]);
    expect(own.list()).toEqual([]);
  });

  test("取り込みの側が「まだ台帳に入っていない」と返した画面は控えに残す", async () => {
    const registered = new Set(["kakuyomu:16816927861924296900"]);
    const own = service({
      registeredKeys: async () => registered,
      importHeldStats: async (envelopes) => envelopes,
    });
    await own.note([ownEnvelope()]);
    await own.settleRegistered(registered);
    expect(own.pendingStats()).toHaveLength(1);
  });

  test("取り込みの側が失敗しても止まらず、控えは残す", async () => {
    const registered = new Set(["kakuyomu:16816927861924296900"]);
    const own = service({
      registeredKeys: async () => registered,
      importHeldStats: async () => {
        throw new Error("台帳を読めませんでした");
      },
    });
    await own.note([ownEnvelope()]);
    await expect(own.settleRegistered(registered)).resolves.toBeUndefined();
    expect(own.pendingStats()).toHaveLength(1);
  });

  test("重なって呼ばれても飛ばさず順に走らせ、名指しした作品の控えの数と取り込めた数を返す", async () => {
    let calls = 0;
    const own = service({
      // 一覧の控えはまだ古い（作品ID の鍵が無い）。名指しで取り込む
      registeredKeys: async () => new Set<string>(),
      importHeldStats: async () => {
        calls++;
        return [];
      },
    });
    await own.note([ownEnvelope()]);
    const [plain, named] = await Promise.all([
      own.flushHeldStats(),
      own.flushHeldStats({ justRegistered: { site: "kakuyomu", workId: "16816927861924296900" } }),
    ]);
    expect(plain).toEqual({ held: 0, imported: 0 });
    expect(named).toEqual({ held: 1, imported: 1 });
    expect(calls).toBe(1);
    expect(own.pendingStats()).toEqual([]);
  });

  test("枠のバックアップを取り込んで登録したら、その作品の控えを取り込みへ渡す", async () => {
    remember(ALPHAPOLIS);
    const handed: ReaderStatsEnvelope[] = [];
    const own = service({
      // 取り込んだあとは台帳に作品ID が入っている
      registeredKeys: async () => new Set(["alphapolis:123456789"]),
      importHeldStats: async (envelopes) => {
        handed.push(...envelopes);
        return [];
      },
    });
    await own.note([ownEnvelope({ site: "alphapolis", workId: "123456789", title: "氷の街の約束" })]);
    await own.importBytes(ALPHAPOLIS, {
      fileName: "氷の街の約束.txt",
      bytes: new TextEncoder().encode(ALPHAPOLIS_TEXT),
    });
    expect(handed.map((envelope) => envelope.workId)).toEqual(["123456789"]);
    expect(own.pendingStats()).toEqual([]);
  });

  /*
    リーダーの指示 3（2026-11-01）。作者が「登録しない」と決めた作品ID でも、管理画面で読んだ
    自分の作品は枠に出す（覚えの側は「登録しない」の覚えを見ない作り。それを確かめる）
  */
  test("「登録しない」と決めた作品ID でも、管理画面で読んだ自分の作品は覚えて控える", async () => {
    memory.values.set("novelai.readerStats.declinedWorkIds", ["kakuyomu:16816927861924296900"]);
    const own = service();
    await own.note([ownEnvelope()]);
    expect(own.list().map((entry) => entry.title)).toEqual(["星の数ほどいるクズ"]);
    expect(own.pendingStats()).toHaveLength(1);
  });
});

describe("なろうの数字ID の入れ方の説明", () => {
  test("確かめてあるバックアップの画面のアドレスを例に出す（管理の画面のアドレスは出さない）", async () => {
    remember(NAROU);
    let prompt = "";
    win.showInputBox = (async (options: { prompt?: string }) => {
      prompt = options.prompt ?? "";
      return undefined;
    }) as Stub["showInputBox"];
    await service().fetchBackup(NAROU);
    expect(prompt).toContain("https://syosetu.com/backup/top/ncode/");
    expect(prompt).not.toContain("管理");
  });
});
