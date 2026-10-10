import * as path from "path";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { FileSystemError, FileType, Uri, window, workspace } from "../support/vscodeStub";
import { emptyCharacter, type Character } from "../../../src/models/character";
import type { WorkEntry } from "../../../src/models/types";

/**
 * 移す案を反映したあと、同じ人物の承認待ちの更新案が、移した値を巻き戻さない
 * （0.102.4。設計書6.5.12）。
 *
 * 更新案（`.aiwriter/pending-characters/`）はレコード丸ごとの写しである。
 * `settlePendingRejectedValues`／`settlePendingRelations` が覆うのは変化の記録・
 * 面・関係だけで、**呼称・一人称の言い分け・登場話は写しのまま戻る**。
 * ここでは「登場話」で確かめる（直す前は、更新案を承認すると第12話が主人公へ戻った）。
 *
 * - パネルを開き直してから更新案を承認する道
 * - 開き直さず、同じパネルで続けて押す道（メモリ上の写しが残っている）
 *
 * 承認待ち（人物の更新案・移す案）は本物（メモリ上の作品フォルダー）、人物の台帳は代役。
 */

const state = vi.hoisted(() => ({
  characters: [] as Character[],
  saved: [] as string[],
}));

vi.mock("../../../src/core/characterStore", () => ({
  CharacterStoreError: class CharacterStoreError extends Error {},
  CharacterStore: class {
    async loadAll() {
      return { characters: structuredClone(state.characters), errors: [] };
    }
    async saveOrUpdate(character: Character) {
      state.saved.push(character.id);
      state.characters = state.characters.map((entry) =>
        entry.id === character.id ? structuredClone(character) : entry
      );
    }
  },
}));

const SOURCES = vi.hoisted(() => {
  const hero = "　俺は串焼きを頬張った。旨い。\n　俺はもう一本頼むことにした。\n";
  const prince =
    "　広い部屋にポツンと置かれた机で、余は先生の話をただ聞いていた。\n" +
    "「これは経済の基本です。殿下、聞いていますか」\n" +
    "　余もいつか、この退屈な皇宮から出ることができるのだろうか。\n";
  return [
    { label: "第10話", text: hero.repeat(20), chapter: 10 },
    { label: "第12話", text: prince, chapter: 12 },
  ];
});

vi.mock("../../../src/core/manuscriptSources", () => ({
  loadExcerptSources: async () => ({ sources: SOURCES, conflicted: [] }),
}));

vi.mock("../../../src/core/pendingSettingsUpdates", () => ({
  PendingSettingsUpdateStore: class {
    async loadAll() {
      return { updates: [], errors: [] };
    }
    async discard() {}
  },
}));
vi.mock("../../../src/core/customFieldStore", () => ({
  CustomFieldStore: class {
    async loadFields() {
      return [];
    }
    async loadOrEmpty() {
      return {};
    }
  },
}));

const logged = vi.hoisted(() => ({ lines: [] as string[] }));
vi.mock("../../../src/core/logger", () => ({
  logFailure: vi.fn(),
  logLine: vi.fn((message: string) => logged.lines.push(message)),
  useLogFile: vi.fn(),
}));

const { stageNarratorMovesAfterExtraction } = await import(
  "../../../src/features/narratorMovePending"
);
const { applyPendingCharacterUpdates } = await import(
  "../../../src/features/applyPendingUpdates"
);
const { PendingUpdateStore } = await import("../../../src/core/pendingUpdates");

const work: WorkEntry = {
  id: "work_test",
  title: "ハイエルフ未亡人",
  folderPath: ["C:", "novels", "work"].join(path.sep),
  registeredAt: "2026-10-10T00:00:00.000Z",
};
const movesDir = Uri.file(path.join(work.folderPath, ".aiwriter", "pending-moves")).fsPath;
const updatesDir = Uri.file(path.join(work.folderPath, ".aiwriter", "pending-characters")).fsPath;

/** 主人公。第12話（殿下の語り）が登場話に紛れ込んでいる */
function hero(): Character {
  return {
    ...emptyCharacter("char_007", "アジャーノ"),
    role: "冒険者",
    firstPerson: { default: "俺", variants: [] },
    appearedChapters: [10, 12],
  };
}

const PRINCE: Character = {
  ...emptyCharacter("char_016", "殿下"),
  firstPerson: { default: "余", variants: [] },
};

const disk = new Map<string, Uint8Array>();
const informed: string[] = [];

beforeEach(() => {
  disk.clear();
  state.characters = [hero(), structuredClone(PRINCE)];
  state.saved = [];
  logged.lines = [];
  informed.length = 0;
  window.showInformationMessage = (async (message: string) => {
    informed.push(message);
    return undefined;
  }) as typeof window.showInformationMessage;
  window.showWarningMessage = (async () => undefined) as typeof window.showWarningMessage;
  workspace.textDocuments = [];
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

function filesIn(directory: string): string[] {
  return [...disk.keys()].filter((filePath) => path.dirname(filePath) === directory);
}

type Outcome = { ok: boolean; reason?: string; dropped?: number };

function fakePanel() {
  const captured = {
    items: [] as Array<{ id: string; name: string; source: string }>,
    apply: undefined as undefined | ((id: string, keys?: string[]) => Promise<Outcome>),
  };
  return {
    captured,
    panel: {
      showRecordUpdates(
        _work: WorkEntry,
        items: typeof captured.items,
        apply: NonNullable<typeof captured.apply>
      ) {
        captured.items = items;
        captured.apply = apply;
      },
    },
  };
}

async function openPanel() {
  const { panel, captured } = fakePanel();
  await applyPendingCharacterUpdates(work, panel as never);
  return captured;
}

/** 同じ抽出で積まれた主人公の更新案（写しの中では第12話がまだ登場話にある） */
async function stageHeroUpdate(): Promise<void> {
  await new PendingUpdateStore(work).stage([{ ...hero(), summary: "旅の冒険者" }]);
}

function heroNow(): Character {
  return state.characters.find((entry) => entry.id === "char_007")!;
}

describe("移す案を反映したら、同じ人物の更新案を片づける", () => {
  test("開き直してから更新案を承認しても、移した登場話は戻らない", async () => {
    await stageHeroUpdate();
    expect(await stageNarratorMovesAfterExtraction(work)).toBe(1);

    const first = await openPanel();
    const move = first.items.find((item) => item.id.includes("pending-moves"))!;
    expect(move.source).toContain("登場話");
    expect((await first.apply!(move.id, [])).ok).toBe(true);
    expect(heroNow().appearedChapters).toEqual([10]);

    // 開き直す。残っている行を全部押しても、第12話は主人公へ戻らない
    const second = await openPanel();
    for (const item of second.items) await second.apply?.(item.id, []);
    expect(heroNow().appearedChapters).toEqual([10]);
    expect(
      state.characters.find((entry) => entry.id === "char_016")!.appearedChapters
    ).toEqual([12]);
    // 古い写しは片づいている
    expect(filesIn(updatesDir)).toEqual([]);
  });

  test("開き直さず続けて押しても、写しから書かない（片づけたと伝える）", async () => {
    await stageHeroUpdate();
    await stageNarratorMovesAfterExtraction(work);

    const captured = await openPanel();
    const update = captured.items.find((item) => item.id.includes("pending-characters"))!;
    const move = captured.items.find((item) => item.id.includes("pending-moves"))!;
    expect((await captured.apply!(move.id, [])).ok).toBe(true);

    const savedBefore = state.saved.length;
    const outcome = await captured.apply!(update.id, []);
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toContain("片づけました");
    expect(state.saved.length).toBe(savedBefore);
    expect(heroNow().appearedChapters).toEqual([10]);
  });

  test("片づけたことを、作品のログと反映の知らせに1行ずつ出す", async () => {
    await stageHeroUpdate();
    await stageNarratorMovesAfterExtraction(work);
    const captured = await openPanel();
    const move = captured.items.find((item) => item.id.includes("pending-moves"))!;
    await captured.apply!(move.id, []);

    expect(logged.lines).toContain(
      "設定資料の更新を片づけ：人物「アジャーノ」の承認待ちの更新案（移す案の反映で古くなったため。もう一度抽出すると作り直されます）（提案パネル）"
    );
    expect(informed).toContain(
      "「アジャーノ」の承認待ちの更新案を片づけました（移す前の写しなので、承認すると移した値が戻るため）。もう一度「設定資料を抽出」すると作り直されます。"
    );
  });

  test("移し先の人物の更新案も片づける（足した値が写しで消えないように）", async () => {
    await new PendingUpdateStore(work).stage([{ ...structuredClone(PRINCE), summary: "皇子" }]);
    await stageNarratorMovesAfterExtraction(work);
    const captured = await openPanel();
    const move = captured.items.find((item) => item.id.includes("pending-moves"))!;
    await captured.apply!(move.id, []);
    expect(filesIn(updatesDir)).toEqual([]);

    const second = await openPanel();
    for (const item of second.items) await second.apply?.(item.id, []);
    expect(
      state.characters.find((entry) => entry.id === "char_016")!.appearedChapters
    ).toEqual([12]);
  });

  test("確認ダイアログの［すべて反映］でも、選んでいない移す案は失敗と分けて言う", async () => {
    // 「余」の持ち主が台帳に居ない＝名指しできず、移し先は作者が選ぶ
    state.characters = [hero(), emptyCharacter("char_016", "殿下")];
    await stageHeroUpdate();
    await stageNarratorMovesAfterExtraction(work);
    window.showInformationMessage = (async (message: string, options?: { modal?: boolean }) => {
      informed.push(message);
      return options?.modal ? "すべて反映" : undefined;
    }) as typeof window.showInformationMessage;
    let warned = "";
    window.showWarningMessage = (async (message: string) => {
      warned = message;
      return undefined;
    }) as typeof window.showWarningMessage;

    await applyPendingCharacterUpdates(work);

    expect(warned).toBe("");
    expect(informed.at(-1)).toBe(
      "1 件の設定を更新しました。移し先を選んでいない移す案 1件は残しました（提案パネルで移し先を選べます）。" +
        "「設定資料集出力」を実行すると一覧にも反映されます。"
    );
    // 移す案は承認待ちに残る
    expect(filesIn(movesDir)).toHaveLength(1);
  });

  test("ほかの人物の更新案は残す", async () => {
    state.characters.push(emptyCharacter("char_020", "宿屋の娘"));
    await new PendingUpdateStore(work).stage([
      { ...emptyCharacter("char_020", "宿屋の娘"), summary: "看板娘" },
    ]);
    await stageNarratorMovesAfterExtraction(work);
    const captured = await openPanel();
    const move = captured.items.find((item) => item.id.includes("pending-moves"))!;
    await captured.apply!(move.id, []);
    expect(filesIn(updatesDir)).toHaveLength(1);
    expect(informed.some((message) => message.includes("片づけました"))).toBe(false);
  });
});
