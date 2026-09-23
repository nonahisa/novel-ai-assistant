import * as path from "path";
import { readFileSync } from "node:fs";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import type { WorkProfile } from "../../../src/core/contestMatchText";

/**
 * AIが応募先を提案する（設計書6.3.6.5、P-41）。隠し機能。
 *
 * - **押す前に、送る量を示す**（無料のAIでも。本文は送らない）
 * - **AIの答えはコードで確かめる**：候補に無い公募・指示の言葉の返りは画面に出さない
 * - 選べば、これまでの「応募先に入れる」流れで入れる
 * - 作品の概要が無ければ、AIを呼ばずに止める
 *
 * 見本の公募・作品はすべて作り物である。
 */

let profile: WorkProfile;
vi.mock("../../../src/features/contestWorkProfile", () => ({
  readWorkProfile: async () => profile,
}));

const { suggestContestsByAI } = await import("../../../src/features/contestSuggest");
const { CONTEST_INBOX_KEY } = await import("../../../src/features/contestImport");
const { storeContests } = await import("../../../src/core/contestInbox");
const { parseContestCard } = await import("../../../src/core/contestListing");
const { invalidateWorkGoals } = await import("../../../src/core/workGoalsStore");
const { parseWorkGoals } = await import("../../../src/models/workGoals");
const { FileSystemError, Uri, window, workspace } = await import("../support/vscodeStub");
import type { WorkEntry } from "../../../src/models/types";
import type { AIRegistry } from "../../../src/ai/registry";

class MemoryStub {
  readonly values = new Map<string, unknown>();
  get<T>(key: string, defaultValue: T): T {
    return (this.values.has(key) ? this.values.get(key) : defaultValue) as T;
  }
  async update(key: string, value: unknown): Promise<void> {
    this.values.set(key, JSON.parse(JSON.stringify(value)));
  }
}

const MAIN: WorkEntry = {
  id: "w1",
  title: "潮騒の図書館",
  folderPath: path.join("C:", "novels", "w1"),
  registeredAt: "2026-09-01T00:00:00.000Z",
};

const disk = new Map<string, Uint8Array>();
let memory: MemoryStub;
let informed: string[];
let modalDetails: string[];
let confirmAnswers: string[];
let pickItems: { label: string; detail?: string; kind?: number }[][];
let pickLabel: string | undefined;
let aiAnswer: string;
let generate: ReturnType<typeof vi.fn>;

function registry(): AIRegistry {
  const provider = {
    id: "ollama",
    displayName: "Ollama",
    isPaid: false,
    generate,
  };
  return { resolve: () => ({ provider, model: "gemma4:e4b" }) } as unknown as AIRegistry;
}

function deps() {
  return {
    memory,
    deviceId: "pc",
    listWorks: () => [MAIN],
    afterSave: async () => undefined,
    loadStats: async () => [
      {
        schemaVersion: "1",
        deviceId: "pc",
        days: ["2026-09-01", "2026-09-05", "2026-09-10", "2026-09-15", "2026-09-20"].map((date) => ({
          date,
          net: 12000,
          gross: 12000,
          saves: 1,
        })),
      },
    ],
    aiRegistry: registry(),
  };
}

function seedInbox(): void {
  const cards = [
    { name: "第5回 うみかぜ文学賞", text: "締切：2026年11月30日\n字数：制限なし\n募集作品：海の物語" },
    { name: "第2回 ほしぞら大賞", text: "締切：2026年12月20日\n字数：制限なし\n募集作品：SF" },
  ];
  const listings = cards.map((card) => {
    const listing = parseContestCard({ ...card, source: "pasted" });
    if (!listing) throw new Error(card.name);
    return listing;
  });
  memory.values.set(
    CONTEST_INBOX_KEY,
    JSON.parse(
      JSON.stringify(storeContests(listings, { importedAt: "2026-09-23T10:00:00.000+09:00", sourcePage: null }))
    )
  );
}

function goalsPath(): string {
  return Uri.file(path.join(MAIN.folderPath, ".aiwriter", "goals.json")).fsPath;
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
  informed = [];
  modalDetails = [];
  confirmAnswers = ["提案してもらう", "応募先に入れる"];
  pickItems = [];
  pickLabel = undefined;
  profile = {
    title: "潮騒の図書館",
    kind: "小説",
    format: "長編",
    genre: "ヒューマンドラマ",
    logline: "海辺の図書館で働く司書が、失われた本を探す。",
    outline: "",
    blurb: "",
  };
  aiAnswer = JSON.stringify({
    suggestions: [
      { id: "C1", reason: "海辺が舞台で、海の物語を募る賞と重なるため。" },
      { id: "C7", reason: "候補に無い公募。" },
      { id: "C2", reason: "理由" },
    ],
  });
  generate = vi.fn(async () => ({ text: aiAnswer }));
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
      const options = rest[0];
      if (typeof options === "object" && options !== null && "detail" in options) {
        modalDetails.push(String((options as { detail?: string }).detail));
      }
      return confirmAnswers.find((answer) => rest.includes(answer));
    },
    showWarningMessage: async (text: string) => {
      informed.push(text);
      return undefined;
    },
    showErrorMessage: async (text: string) => {
      informed.push(text);
      return undefined;
    },
    // 予定の字数を訊かれたら 60,000字
    showInputBox: async () => "60000",
    showQuickPick: async (items: { label: string; detail?: string; kind?: number }[]) => {
      pickItems.push(items);
      if (pickLabel === undefined) return undefined;
      return items.find((item) => item.kind === undefined && item.label.includes(pickLabel ?? ""));
    },
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("隠し機能の入口", () => {
  const root = path.resolve(__dirname, "..", "..", "..");
  test("詳細メニュー・簡単ステップには載せず、コマンドパレットと相談からだけ呼ぶ", () => {
    expect(readFileSync(path.join(root, "src/views/actionList.ts"), "utf8")).not.toContain("novelai.suggestContests");
    expect(readFileSync(path.join(root, "src/views/stepMenu.ts"), "utf8")).not.toContain("novelai.suggestContests");
    const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as {
      contributes: { commands: { command: string }[] };
    };
    expect(manifest.contributes.commands.map((entry) => entry.command)).toContain("novelai.suggestContests");
    expect(readFileSync(path.join(root, "src/extension.ts"), "utf8")).toContain(
      'suggestContests: "novelai.suggestContests"'
    );
  });
});

describe("応募先の提案", () => {
  test("押す前に送る量を示し（本文は送らない）、断ったらAIを呼ばない", async () => {
    seedInbox();
    confirmAnswers = [];
    await suggestContestsByAI(MAIN, deps());
    expect(modalDetails.join("\n")).toContain("公募2件の募集内容");
    expect(modalDetails.join("\n")).toContain("本文は送りません");
    expect(generate).not.toHaveBeenCalled();
  });

  test("候補に無い公募・理由が指示の言葉の返りのものは画面に出さない", async () => {
    seedInbox();
    await suggestContestsByAI(MAIN, deps());
    expect(generate).toHaveBeenCalledTimes(1);
    const shown = pickItems[0].filter((item) => item.kind === undefined && !item.label.includes("取りやめ"));
    expect(shown.map((item) => item.label)).toEqual(["1. 第5回 うみかぜ文学賞"]);
    expect(shown[0].detail).toBe("海辺が舞台で、海の物語を募る賞と重なるため。");
  });

  test("選べば、確かめる画面を通して応募先に入れる", async () => {
    seedInbox();
    pickLabel = "うみかぜ";
    await suggestContestsByAI(MAIN, deps());
    const bytes = disk.get(goalsPath());
    expect(bytes).toBeDefined();
    const goals = parseWorkGoals(JSON.parse(new TextDecoder().decode(bytes!)));
    expect(goals.contest?.name).toBe("第5回 うみかぜ文学賞");
    expect(goals.contest?.deadline).toBe("2026-11-30");
  });

  test("作品の概要が無ければ、AIを呼ばずに書き方を言って止める", async () => {
    seedInbox();
    profile = { ...profile, genre: "", logline: "" };
    await suggestContestsByAI(MAIN, deps());
    expect(generate).not.toHaveBeenCalled();
    expect(informed.join("\n")).toContain("作品の概要がまだ無い");
  });

  test("読める提案が1つも無ければ、そう言って止める（候補を作らない）", async () => {
    seedInbox();
    aiAnswer = JSON.stringify({ suggestions: [{ id: "C9", reason: "無い候補" }] });
    await suggestContestsByAI(MAIN, deps());
    expect(pickItems).toEqual([]);
    expect(informed.join("\n")).toContain("AIの提案を読み取れませんでした");
  });
});
