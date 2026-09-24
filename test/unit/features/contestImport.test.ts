import * as path from "path";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import {
  CONTEST_INBOX_KEY,
  chooseContestForWork,
  importContestsFromClipboard,
  importSummary,
  type ContestImportDeps,
  type ContestMemory,
} from "../../../src/features/contestImport";
import { invalidateWorkGoals } from "../../../src/core/workGoalsStore";
import { parseWorkGoals, type WorkGoals } from "../../../src/models/workGoals";
import type { WorkEntry } from "../../../src/models/types";
import { env, FileSystemError, Uri, window, workspace } from "../support/vscodeStub";

/**
 * 公募の一覧の取り込みと、応募先への入れ方（設計書6.3.6.1）。
 *
 *   1. クリップボードの一覧（ヘルパーの封筒・貼り付けた文）を置き場へ取り込む
 *   2. **読めなかった件数を必ず言う。0件を黙って成功にしない**
 *   3. 選んだ公募を、確かめてから作品の応募先へ入れる（公式のリンク・いつの情報か付き）
 *   4. 取り込み直して締切・字数が変わっていれば、違いを並べて作者に選ばせる（黙って書き換えない）
 *
 * 見本の公募名・主催はすべて作り物である。
 */

const PORTAL_TEXT = [
  "第3回 みずうみ文学賞",
  " 締切：2026年10月31日（土）23:59",
  " 賞典：賞状＋賞金10万円",
  " 字数：400字詰原稿用紙で50枚以上100枚以下",
  " 主催：みずうみ文学振興会",
  "◇",
  "気になる！",
  "12",
  "ラジオ風短編賞",
  " 締切",
  "上期：募集期間：毎年1月〜6月",
  " 字数：4,000字以下",
  " 主催：作り物オフィス",
].join("\n");

function envelope(items: unknown[]): string {
  return JSON.stringify({
    "novelai-contests": 1,
    source: "novelportal",
    pageUrl: "https://creative-story.net/bungakusyou/",
    readAt: "2026-09-23T10:00:00.000+09:00",
    items,
  });
}

const MIZUUMI_ITEM = {
  name: "第3回 みずうみ文学賞",
  url: "https://example.com/mizuumi",
  section: "2026年10月締切",
  text: PORTAL_TEXT.split("\n").slice(0, 5).join("\n"),
};

class MemoryStub implements ContestMemory {
  readonly values = new Map<string, unknown>();
  get<T>(key: string, defaultValue: T): T {
    return (this.values.has(key) ? this.values.get(key) : defaultValue) as T;
  }
  async update(key: string, value: unknown): Promise<void> {
    this.values.set(key, JSON.parse(JSON.stringify(value)));
  }
}

function work(id: string, title: string): WorkEntry {
  return {
    id,
    title,
    folderPath: path.join("C:", "novels", id),
    registeredAt: "2026-09-23T00:00:00.000Z",
  };
}

function goalsPath(entry: WorkEntry): string {
  return Uri.file(path.join(entry.folderPath, ".aiwriter", "goals.json")).fsPath;
}

const disk = new Map<string, Uint8Array>();
const informed: string[] = [];
const warned: string[] = [];
const modalDetails: string[] = [];
let memory: MemoryStub;
let works: WorkEntry[];
let refreshed: string[];
/** 通知のボタンへの答え（問いの文に含まれる言葉 → 押すボタン） */
let answers: [string, string][];
/** 選択画面で選ぶ項目のラベル（先頭の一致） */
let pickLabel: string | undefined;
let pickAllMany = false;

function deps(): ContestImportDeps {
  return {
    memory,
    listWorks: () => works,
    afterSave: async (entry) => {
      refreshed.push(entry.id);
    },
  };
}

function readGoals(entry: WorkEntry): WorkGoals | undefined {
  const bytes = disk.get(goalsPath(entry));
  if (!bytes) return undefined;
  return parseWorkGoals(JSON.parse(new TextDecoder().decode(bytes)));
}

function writeGoals(entry: WorkEntry, goals: unknown): void {
  disk.set(goalsPath(entry), new TextEncoder().encode(`${JSON.stringify(goals, null, 2)}\n`));
  invalidateWorkGoals(entry.id);
}

function answerFor(message: string, buttons: unknown[]): string | undefined {
  const found = answers.find(([key]) => message.includes(key));
  if (!found) return undefined;
  return buttons.includes(found[1]) ? found[1] : undefined;
}

beforeAll(() => {
  Object.assign(window, {
    createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }),
  });
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-23T12:00:00+09:00"));
  disk.clear();
  informed.length = 0;
  warned.length = 0;
  modalDetails.length = 0;
  memory = new MemoryStub();
  works = [];
  refreshed = [];
  answers = [];
  pickLabel = undefined;
  pickAllMany = false;
  invalidateWorkGoals();
  env.clipboard.text = "";
  env.clipboard.readText = async () => env.clipboard.text;
  workspace.getConfiguration = (() => ({
    get: <T>(_key: string, defaultValue: T): T => defaultValue,
  })) as unknown as typeof workspace.getConfiguration;
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
    readDirectory: async () => {
      throw new FileSystemError("missing", "FileNotFound");
    },
  } as unknown as typeof workspace.fs;

  const message =
    (sink: string[]) =>
    async (text: string, ...rest: unknown[]) => {
      sink.push(text);
      const options = rest[0];
      if (typeof options === "object" && options !== null && "detail" in options) {
        modalDetails.push(String((options as { detail?: string }).detail));
      }
      return answerFor(text, rest);
    };
  Object.assign(window, {
    showInformationMessage: message(informed),
    showWarningMessage: message(warned),
    showErrorMessage: message(warned),
    showInputBox: async () => undefined,
    showQuickPick: async (items: { label: string; kind?: number }[], options?: { canPickMany?: boolean }) => {
      if (options?.canPickMany) return pickAllMany ? items : undefined;
      if (pickLabel === undefined) return undefined;
      return items.find((item) => item.kind === undefined && item.label.startsWith(pickLabel ?? ""));
    },
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("取り込み", () => {
  test("貼り付けた一覧を置き場へ入れ、読めなかったものの数を言う", async () => {
    env.clipboard.text = PORTAL_TEXT;

    await importContestsFromClipboard(deps(), "paste");

    const inbox = memory.get<{ name: string }[]>(CONTEST_INBOX_KEY, []);
    expect(inbox.map((entry) => entry.name)).toEqual(["第3回 みずうみ文学賞", "ラジオ風短編賞"]);
    expect(informed[0]).toContain("公募を2件読みました");
    expect(informed[0]).toContain("締切を読めなかったもの 1件");
  });

  test("公募の一覧でないクリップボードは取り込まず、貼り付け方を案内する", async () => {
    env.clipboard.text = "今日の買い物：卵、牛乳";

    await importContestsFromClipboard(deps(), "uri");

    expect(memory.values.has(CONTEST_INBOX_KEY)).toBe(false);
    expect(informed[0]).toContain("公募の一覧がありませんでした");
    expect(informed[0]).toContain("全部選んでコピー");
  });

  /*
    実機確認リスト（0.80.0）の「公募の一覧を貼り付けて取り込む」で、1件も読めなければ
    「全部選んでコピーして貼る」の案内が出るか。上の試験はヘルパーからの道（uri）なので、
    貼り付けの道（paste）でも同じ案内が出ることを見る。
  */
  test("貼り付けの道で公募の一覧が読めなければ、取り込まず「全部選んでコピー」を案内する", async () => {
    env.clipboard.text = "今日の買い物：卵、牛乳";

    await importContestsFromClipboard(deps(), "paste");

    expect(memory.values.has(CONTEST_INBOX_KEY)).toBe(false);
    const said = [...informed, ...warned].join("\n");
    expect(said).toContain("公募の一覧が見つかりませんでした");
    expect(said).toContain("全部選んでコピー");
    expect(said).toContain("貼り付けて取り込む");
  });

  test("ヘルパーが渡した一覧を1件も読めなければ、成功と言わずに理由と貼り付け方を言う", async () => {
    env.clipboard.text = envelope([
      { name: "作り物A", url: null, section: null, text: "作り物A\n説明だけ" },
      { name: "作り物B", url: null, section: null, text: "作り物B\n説明だけ" },
    ]);

    await importContestsFromClipboard(deps(), "uri");

    expect(memory.values.has(CONTEST_INBOX_KEY)).toBe(false);
    expect(warned[0]).toContain("1件も読めませんでした");
    expect(warned[0]).toContain("読めなかったもの 2件");
    expect(warned[0]).toContain("貼り付けて取り込む");
    expect(informed).toEqual([]);
  });

  test("読めた件数と読めなかった件数を1つの文で言う", () => {
    expect(importSummary(3, 2, [], 1)).toBe(
      "公募を3件読みました（公募として読めなかったもの 2件）。締切の過ぎた1件は除きました。"
    );
  });
});

describe("応募先に選ぶ", () => {
  test("確かめてから入れる（公式のリンク・いつの情報か・主催・原文を持つ）", async () => {
    const entry = work("w1", "星を継ぐ者たち");
    works = [entry];
    env.clipboard.text = envelope([MIZUUMI_ITEM]);
    await importContestsFromClipboard(deps(), "paste");
    pickLabel = "第3回 みずうみ文学賞";
    answers = [["応募先に入れますか", "応募先に入れる"]];

    const saved = await chooseContestForWork(entry, deps());

    expect(saved).toBe(true);
    // 確かめる画面に、原文と換算の断り・いつの情報かが出る
    const detail = modalDetails.join("\n");
    expect(detail).toContain("400字詰原稿用紙で50枚以上100枚以下");
    expect(detail).toContain("原稿用紙換算は目安です。応募要項で確かめてください。");
    expect(detail).toContain("賞典：賞状＋賞金10万円");
    expect(detail).toContain("9月23日時点の情報");
    expect(readGoals(entry)?.contest).toEqual({
      name: "第3回 みずうみ文学賞",
      url: "https://example.com/mizuumi",
      deadline: "2026-10-31",
      minChars: 20000,
      maxChars: 40000,
      dailyGoal: null,
      imported: {
        importedAt: "2026-09-23T10:00:00.000+09:00",
        sourcePage: "https://creative-story.net/bungakusyou/",
        organizer: "みずうみ文学振興会",
        deadlineText: "2026年10月31日（土）23:59",
        charText: "400字詰原稿用紙で50枚以上100枚以下",
      },
    });
    expect(refreshed).toEqual(["w1"]);
  });

  test("別の応募先が入っていれば、置き換えるか訊く（断れば変えない）", async () => {
    const entry = work("w1", "星を継ぐ者たち");
    works = [entry];
    writeGoals(entry, {
      perEpisodeChars: null,
      contest: { name: "前からの賞", deadline: "2026-12-01", dailyGoal: 1500 },
    });
    env.clipboard.text = envelope([MIZUUMI_ITEM]);
    await importContestsFromClipboard(deps(), "paste");
    pickLabel = "第3回 みずうみ文学賞";
    answers = [["応募先に入れますか", "応募先に入れる"]];

    expect(await chooseContestForWork(entry, deps())).toBe(false);
    expect(warned.some((text) => text.includes("置き換えますか"))).toBe(true);
    expect(readGoals(entry)?.contest?.name).toBe("前からの賞");
  });

  test("壊れた目標のファイルは上書きしない", async () => {
    const entry = work("w1", "星を継ぐ者たち");
    works = [entry];
    disk.set(goalsPath(entry), new TextEncoder().encode("{ 壊れた"));
    env.clipboard.text = envelope([MIZUUMI_ITEM]);
    await importContestsFromClipboard(deps(), "paste");
    pickLabel = "第3回 みずうみ文学賞";
    answers = [["応募先に入れますか", "応募先に入れる"]];

    expect(await chooseContestForWork(entry, deps())).toBe(false);
    expect(new TextDecoder().decode(disk.get(goalsPath(entry)))).toBe("{ 壊れた");
    expect(warned.some((text) => text.includes("goals.json"))).toBe(true);
  });
});

describe("取り込み直したとき（募集は書き換わる）", () => {
  const goal = {
    perEpisodeChars: null,
    contest: {
      name: "第3回 みずうみ文学賞",
      url: "https://example.com/mizuumi",
      deadline: "2026-10-31",
      minChars: 20000,
      maxChars: 40000,
      dailyGoal: 1200,
      imported: {
        importedAt: "2026-09-01T10:00:00.000+09:00",
        sourcePage: "https://creative-story.net/bungakusyou/",
        organizer: "みずうみ文学振興会",
        deadlineText: "2026年10月31日",
        charText: "400字詰原稿用紙で50枚以上100枚以下",
      },
    },
  };
  const extended = {
    ...MIZUUMI_ITEM,
    text: MIZUUMI_ITEM.text.replace("2026年10月31日（土）23:59", "2026年11月15日（日）23:59"),
  };

  test("違いを並べて知らせ、作者が選んだら直す（いつの情報かも新しくする）", async () => {
    const entry = work("w1", "星を継ぐ者たち");
    works = [entry];
    writeGoals(entry, goal);
    env.clipboard.text = envelope([extended]);
    answers = [["募集内容が、いま取り込んだ一覧と違います", "選んで直す"]];
    pickAllMany = true;

    await importContestsFromClipboard(deps(), "uri");

    expect(modalDetails[0]).toContain("締切：2026-10-31 → 2026-11-15");
    expect(modalDetails[0]).toContain("9月1日時点の情報");
    const after = readGoals(entry)?.contest;
    expect(after?.deadline).toBe("2026-11-15");
    // 作者が決めた日間目標は残す
    expect(after?.dailyGoal).toBe(1200);
    expect(after?.imported?.importedAt).toBe("2026-09-23T10:00:00.000+09:00");
    expect(refreshed).toContain("w1");
  });

  test("直さないと答えれば、応募先はそのまま（黙って書き換えない）", async () => {
    const entry = work("w1", "星を継ぐ者たち");
    works = [entry];
    writeGoals(entry, goal);
    env.clipboard.text = envelope([extended]);

    await importContestsFromClipboard(deps(), "uri");

    expect(warned.some((text) => text.includes("募集内容が、いま取り込んだ一覧と違います"))).toBe(true);
    expect(readGoals(entry)?.contest?.deadline).toBe("2026-10-31");
    expect(readGoals(entry)?.contest?.imported?.importedAt).toBe("2026-09-01T10:00:00.000+09:00");
  });
});
