import * as path from "path";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { CONTEST_INBOX_KEY, type ContestMemory } from "../../../src/features/contestImport";
import {
  chooseContestByForecast,
  forecastTitle,
  parseCount,
  type ContestForecastDeps,
} from "../../../src/features/contestForecast";
import { storeContests } from "../../../src/core/contestInbox";
import { parseContestCard } from "../../../src/core/contestListing";
import { invalidateWorkGoals } from "../../../src/core/workGoalsStore";
import { parseWorkGoals, type WorkGoals } from "../../../src/models/workGoals";
import type { WorkEntry } from "../../../src/models/types";
import type { DeviceWritingStats } from "../../../src/models/writingStats";
import { FileSystemError, Uri, window, workspace } from "../support/vscodeStub";

/**
 * 完成予定から公募を選ぶ（設計書6.3.6.3）。入口は作品目標設定。
 *
 * - 見出しに「完成予定 ○月○日（直近30日の平均 1日○字）」、各公募に「締切まで余裕○日」
 * - どちらの記録で測ったか（この作品／全作品）を画面に出す
 * - 予定の字数が無ければ訊く。速度が0なら割らずに、1日の字数を訊く
 * - 選べば、これまでの「応募先に入れる」流れ（確かめる画面）で作品の目標へ入れる
 *
 * 見本の公募はすべて作り物である。
 */

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
  return { id, title, folderPath: path.join("C:", "novels", id), registeredAt: "2026-09-01T00:00:00.000Z" };
}

const MAIN = work("w1", "潮騒の図書館");
const OTHER = work("w2", "星の庭");

const disk = new Map<string, Uint8Array>();
let memory: MemoryStub;
let stats: Map<string, DeviceWritingStats[]>;
let informed: string[];
let pickTitles: string[];
let pickPlaceholders: string[];
let pickedItems: { label: string; description?: string; kind?: number }[][];
let pickLabel: string | undefined;
let inputs: (string | undefined)[];
let inputPrompts: string[];
let confirmAnswer: string | undefined;

function goalsPath(entry: WorkEntry): string {
  return Uri.file(path.join(entry.folderPath, ".aiwriter", "goals.json")).fsPath;
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

function daysOf(entries: [string, number][]): DeviceWritingStats[] {
  return [
    {
      schemaVersion: "1",
      deviceId: "pc",
      days: entries.map(([date, net]) => ({ date, net, gross: net, saves: 1 })),
    },
  ];
}

function deps(): ContestForecastDeps {
  return {
    memory,
    deviceId: "pc",
    listWorks: () => [MAIN, OTHER],
    afterSave: async () => undefined,
    loadStats: async (entry) => stats.get(entry.id) ?? [],
  };
}

function seedInbox(): void {
  const cards = [
    { name: "早すぎる賞", text: "締切：2026年10月20日\n字数：制限なし" },
    { name: "第5回 うみかぜ文学賞", text: "締切：2026年11月30日\n字数：5万字以上12万字以内\n募集作品：海の物語" },
    { name: "上限の小さい賞", text: "締切：2026年12月1日\n字数：3万字以内" },
  ];
  const listings = cards.map((card) => {
    const listing = parseContestCard({ ...card, source: "pasted" });
    if (!listing) throw new Error(card.name);
    return listing;
  });
  memory.values.set(
    CONTEST_INBOX_KEY,
    JSON.parse(
      JSON.stringify(
        storeContests(listings, { importedAt: "2026-09-23T10:00:00.000+09:00", sourcePage: null })
      )
    )
  );
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
  memory = new MemoryStub();
  stats = new Map();
  informed = [];
  pickTitles = [];
  pickPlaceholders = [];
  pickedItems = [];
  pickLabel = undefined;
  inputs = [];
  inputPrompts = [];
  confirmAnswer = "応募先に入れる";
  invalidateWorkGoals();
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
    rename: async (from: { fsPath: string }, to: { fsPath: string }) => {
      const bytes = disk.get(from.fsPath);
      if (!bytes) throw new FileSystemError("missing", "FileNotFound");
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
  Object.assign(window, {
    showInformationMessage: async (text: string, ...rest: unknown[]) => {
      informed.push(text);
      return rest.includes(confirmAnswer) ? confirmAnswer : undefined;
    },
    showWarningMessage: async (text: string) => {
      informed.push(text);
      return undefined;
    },
    showErrorMessage: async (text: string) => {
      informed.push(text);
      return undefined;
    },
    showInputBox: async (options: { prompt?: string }) => {
      inputPrompts.push(options.prompt ?? "");
      return inputs.shift();
    },
    showQuickPick: async (
      items: { label: string; description?: string; kind?: number }[],
      options?: { title?: string; placeHolder?: string }
    ) => {
      pickTitles.push(options?.title ?? "");
      pickPlaceholders.push(options?.placeHolder ?? "");
      pickedItems.push(items);
      if (pickLabel === undefined) return undefined;
      return items.find((item) => item.kind === undefined && item.label.startsWith(pickLabel ?? ""));
    },
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("見出しの言い方", () => {
  test("「完成予定 ○月○日（直近30日の平均 1日○字）」", () => {
    expect(
      forecastTitle({ finishDate: "2026-10-23", perDay: 2000, basis: "work", today: "2026-09-23" })
    ).toBe("完成予定 10月23日（直近30日の平均 1日2,000字）");
    expect(
      forecastTitle({ finishDate: "2026-10-23", perDay: 1500, basis: "manual", today: "2026-09-23" })
    ).toBe("完成予定 10月23日（入れた速さ 1日1,500字）");
  });

  test("数の読み方（全角・桁区切り・「字」）", () => {
    expect(parseCount("１２，０００字")).toBe(12000);
    expect(parseCount("0")).toBeNull();
    expect(parseCount("たくさん")).toBeNull();
  });
});

describe("完成予定から選ぶ", () => {
  test("応募先の下限を予定にし、この作品の直近30日の平均で完成予定を出して並べる", async () => {
    seedInbox();
    writeGoals(MAIN, {
      version: 1,
      perEpisodeChars: null,
      contest: { name: "仮の応募先", url: null, deadline: "2027-03-31", minChars: 60000, maxChars: null, dailyGoal: null },
    });
    // この作品で5日書いた（合計30,000字 → 1日1,000字）。本文は読めないので、いまの字数は0字
    stats.set(
      MAIN.id,
      daysOf([
        ["2026-09-01", 6000],
        ["2026-09-05", 6000],
        ["2026-09-10", 6000],
        ["2026-09-15", 6000],
        ["2026-09-20", 6000],
      ])
    );

    await chooseContestByForecast(MAIN, deps());

    // 60,000字 ÷ 1,000字 = 60日 → 11月22日
    expect(pickTitles[0]).toContain("完成予定 11月22日（直近30日の平均 1日1,000字）");
    expect(pickPlaceholders[0]).toContain("この作品の直近30日の平均で測りました");
    const labels = pickedItems[0].filter((item) => item.kind === undefined).map((item) => item.label);
    expect(labels).toContain("第5回 うみかぜ文学賞");
    expect(labels).not.toContain("早すぎる賞");
    expect(labels).not.toContain("上限の小さい賞");
    const umikaze = pickedItems[0].find((item) => item.label === "第5回 うみかぜ文学賞");
    expect(umikaze?.description).toContain("締切まで余裕8日");
    // ベクトル検索の準備ができていなければ、使わずに並べて案内する
    expect(labels.some((label) => label.includes("作品に近い順にも並べられます"))).toBe(true);
  });

  test("この作品の記録が少なければ全作品の記録で測り、そう言う", async () => {
    seedInbox();
    writeGoals(MAIN, {
      version: 1,
      perEpisodeChars: null,
      contest: { name: "仮の応募先", url: null, deadline: "2027-03-31", minChars: 60000, maxChars: null, dailyGoal: null },
    });
    stats.set(MAIN.id, daysOf([["2026-09-20", 3000]]));
    stats.set(OTHER.id, daysOf([["2026-09-21", 57000]]));

    await chooseContestByForecast(MAIN, deps());

    // 全作品 60,000字 ÷ 30日 = 1日2,000字 → 30日 → 10月23日
    expect(pickTitles[0]).toContain("完成予定 10月23日（直近30日の平均 1日2,000字）");
    expect(pickPlaceholders[0]).toContain("全作品の直近30日の平均で測りました（この作品の記録が少ないため）");
  });

  test("予定の字数が無ければ訊き、記録が無ければ（速度0）割らずに1日の字数を訊く", async () => {
    seedInbox();
    inputs = ["６０，０００", "2000"];

    await chooseContestByForecast(MAIN, deps());

    expect(inputPrompts[0]).toContain("書き上げたときの作品全体の字数");
    expect(inputPrompts[1]).toContain("執筆の記録が無いため");
    expect(pickTitles[0]).toContain("完成予定 10月23日（入れた速さ 1日2,000字）");
  });

  test("選んだら、確かめる画面を通して作品の応募先に入れる", async () => {
    seedInbox();
    inputs = ["60000", "2000"];
    pickLabel = "第5回 うみかぜ文学賞";

    const saved = await chooseContestByForecast(MAIN, deps());

    expect(saved).toBe(true);
    expect(readGoals(MAIN)?.contest).toMatchObject({
      name: "第5回 うみかぜ文学賞",
      deadline: "2026-11-30",
      minChars: 50000,
      maxChars: 120000,
    });
  });

  test("公募を取り込んでいなければ、取り込み方を言って止める", async () => {
    await chooseContestByForecast(MAIN, deps());
    expect(informed.join("\n")).toContain("取り込んだ公募がありません");
    expect(pickTitles).toEqual([]);
  });
});
