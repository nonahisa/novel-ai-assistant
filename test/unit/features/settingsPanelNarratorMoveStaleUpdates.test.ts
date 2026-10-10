import * as path from "path";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { FileSystemError, FileType, Uri, workspace } from "../support/vscodeStub";
import { emptyCharacter, type Character } from "../../../src/models/character";
import type { NarratorMoveItem } from "../../../src/core/narratorMoves";
import type { WorkNarratorContext } from "../../../src/core/sceneNarrators";

/**
 * 設定資料パネルの「AIで再読込」から移したあとも、主人公と移し先の
 * 承認待ちの更新案を片づける（0.102.4。設計書6.5.12）。
 *
 * 提案パネルの移す案と同じ理由——更新案はレコード丸ごとの写しで、承認すると
 * 呼称・一人称の言い分け・登場話が移す前の値へ戻る。ログと知らせの1行も
 * 提案パネルの道と同じ文を使う。
 *
 * 承認待ち（人物の更新案）は本物（メモリ上の作品フォルダー）、台帳の保存は代役。
 */

vi.mock("../../../src/features/generateSettingsDocs", () => ({
  generateSettingsDocs: () => Promise.resolve(),
}));

const logged = vi.hoisted(() => ({ lines: [] as string[] }));
vi.mock("../../../src/core/logger", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/core/logger")>()),
  logLine: vi.fn((message: string) => logged.lines.push(message)),
  useLogFile: vi.fn(),
}));

const { NARRATOR_MOVE_PREFIX, SettingsPanel } = await import(
  "../../../src/features/settingsPanel"
);
const { findNarratorMoves } = await import("../../../src/core/narratorMoves");
const { PendingUpdateStore } = await import("../../../src/core/pendingUpdates");

const PRINCE_SCENE =
  "　広い部屋にポツンと置かれた机で、余は先生の話をただ聞いていた。\n" +
  "「これは経済の基本です。殿下、聞いていますか」\n" +
  "　余もいつか、この退屈な皇宮から出ることができるのだろうか。\n";
const HERO_SCENE = "　俺は串焼きを頬張った。旨い。\n　俺はもう一本頼むことにした。\n";
const SOURCES = [
  { label: "第10話", text: HERO_SCENE, chapter: 10 },
  { label: "第12話", text: PRINCE_SCENE, chapter: 12 },
];

function hero(): Character {
  return {
    ...emptyCharacter("char_007", "アジャーノ"),
    firstPerson: { default: "俺", variants: [] },
    appearedChapters: [10, 12],
  };
}
const PRINCE = emptyCharacter("char_016", "殿下");
const MAID = emptyCharacter("char_020", "宿屋の娘");

const work = {
  id: "w-1",
  title: "ハイエルフ未亡人",
  folderPath: ["C:", "novels", "work"].join(path.sep),
  registeredAt: "2026-10-10T00:00:00.000Z",
};
const updatesDir = Uri.file(path.join(work.folderPath, ".aiwriter", "pending-characters")).fsPath;

interface PanelInnards {
  work: typeof work;
  characters: Character[];
  abilities: unknown[];
  organizations: unknown[];
  locations: unknown[];
  worldItems: unknown[];
  customFields: unknown[];
  narratorMoves: { recordId: string; items: NarratorMoveItem[] } | undefined;
  characterStore: { saveOrUpdate(record: Character): Promise<void> };
  persist(kind: string, record: Character): Promise<void>;
  reloadAfterSave(kind: string, id: string, notice: string): Promise<void>;
  post(message: unknown): void;
  handleApplyProposal(message: {
    type: "applyProposal";
    kind: "character";
    id: string;
    values: Record<string, string>;
  }): Promise<void>;
}

function contextOf(people: Character[]): WorkNarratorContext {
  return {
    narrator: { firstPerson: "俺", name: "アジャーノ" },
    narratorNames: ["アジャーノ"],
    people,
  };
}

function panel() {
  const people = [hero(), structuredClone(PRINCE), structuredClone(MAID)];
  const items = findNarratorMoves(people[0], contextOf(people), SOURCES);
  const notices: string[] = [];
  const inner = Object.create(SettingsPanel.prototype) as unknown as PanelInnards;
  inner.work = work;
  inner.characters = people;
  inner.abilities = [];
  inner.organizations = [];
  inner.locations = [];
  inner.worldItems = [];
  inner.customFields = [];
  inner.narratorMoves = { recordId: "char_007", items };
  inner.characterStore = { saveOrUpdate: async () => undefined };
  inner.persist = async () => undefined;
  inner.reloadAfterSave = async (_kind, _id, notice) => {
    notices.push(notice);
  };
  inner.post = () => undefined;
  return { inner, items, notices };
}

/** 登場話（第12話）の移す案の鍵 */
function appearedKey(items: NarratorMoveItem[]): string {
  const index = items.findIndex((item) => item.kind === "appearedChapters");
  if (index < 0) throw new Error("登場話の案が無い");
  return `${NARRATOR_MOVE_PREFIX}${index}`;
}

const disk = new Map<string, Uint8Array>();

beforeEach(() => {
  disk.clear();
  logged.lines = [];
  workspace.fs = {
    createDirectory: async () => {},
    readFile: async (uri: { fsPath: string }) => {
      const bytes = disk.get(uri.fsPath);
      if (!bytes) throw new FileSystemError("missing", "FileNotFound");
      return bytes;
    },
    readDirectory: async (uri: { fsPath: string }) => {
      const entries = [...disk.keys()].filter((filePath) => path.dirname(filePath) === uri.fsPath);
      if (entries.length === 0) throw new FileSystemError("missing", "FileNotFound");
      return entries.map((filePath) => [path.basename(filePath), FileType.File] as [string, FileType]);
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
      return { type: FileType.File };
    },
  };
});

function pendingNames(): string[] {
  return [...disk.keys()]
    .filter((filePath) => path.dirname(filePath) === updatesDir)
    .map((filePath) => path.basename(filePath));
}

async function stageUpdates(): Promise<void> {
  await new PendingUpdateStore(work).stage([
    { ...hero(), summary: "旅の冒険者" },
    { ...structuredClone(PRINCE), summary: "皇子" },
    { ...structuredClone(MAID), summary: "看板娘" },
  ]);
}

describe("「AIで再読込」から移したら、同じ人物の更新案を片づける", () => {
  test("主人公と移し先の更新案を片づけ、ほかの人物の更新案は残す", async () => {
    await stageUpdates();
    expect(pendingNames()).toHaveLength(3);
    const { inner, items } = panel();
    await inner.handleApplyProposal({
      type: "applyProposal",
      kind: "character",
      id: "char_007",
      values: { [appearedKey(items)]: "char_016" },
    });
    expect(pendingNames()).toEqual(["char_020.json"]);
  });

  test("片づけたことを、作品のログと知らせに同じ文で出す", async () => {
    await stageUpdates();
    const { inner, items, notices } = panel();
    await inner.handleApplyProposal({
      type: "applyProposal",
      kind: "character",
      id: "char_007",
      values: { [appearedKey(items)]: "char_016" },
    });
    expect(logged.lines).toContain(
      "設定資料の更新を片づけ：人物「アジャーノ」「殿下」の承認待ちの更新案" +
        "（移す案の反映で古くなったため。もう一度抽出すると作り直されます）（設定資料パネル）"
    );
    expect(notices[0]).toContain(
      "「アジャーノ」「殿下」の承認待ちの更新案を片づけました（移す前の写しなので、承認すると移した値が戻るため）。" +
        "もう一度「設定資料を抽出」すると作り直されます。"
    );
  });

  test("移す案を選ばなければ、更新案は片づけない", async () => {
    await stageUpdates();
    const { inner, notices } = panel();
    await inner.handleApplyProposal({
      type: "applyProposal",
      kind: "character",
      id: "char_007",
      values: { summary: "冒険者" },
    });
    expect(pendingNames()).toHaveLength(3);
    expect(notices[0]).not.toContain("片づけました");
    expect(logged.lines.some((line) => line.includes("片づけ"))).toBe(false);
  });
});
