import * as path from "path";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { FileSystemError, FileType, Uri, workspace } from "../support/vscodeStub";
import { emptyCharacter, type Character } from "../../../src/models/character";
import type { RecordChange } from "../../../src/models/jsonValidation";
import type { WorkEntry } from "../../../src/models/types";
import { MOVE_DESTINATION_KEY_PREFIX, MOVE_REMOVE_ONLY } from "../../../src/core/pendingNarratorMoves";

/**
 * 語り手の取り違えの移す案を、提案パネルの「設定資料の更新」に出す
 * （作者の裁定 2026-10-10「提案パネルにも出す」。設計書6.5.12、0.102.3）。
 *
 * - 抽出の終わりに積む／同じ案を積み直さない／見送った案を積まない
 * - 反映は移し先 → 主人公の順に `saveOrUpdate`。どちらかが書けなくても値は消えない
 * - 名指しできない案は、移し先を選ばないと反映できない（「外すだけ」は選べる）
 * - 反映・見送りのたびに作品のログへ1行
 *
 * 承認待ちと見送りの記録は本物（メモリ上の作品フォルダー）、人物の台帳は代役。
 */

const state = vi.hoisted(() => ({
  characters: [] as Character[],
  saved: [] as string[],
  failOn: null as string | null,
}));

vi.mock("../../../src/core/characterStore", () => ({
  CharacterStoreError: class CharacterStoreError extends Error {},
  CharacterStore: class {
    async loadAll() {
      return { characters: structuredClone(state.characters), errors: [] };
    }
    async saveOrUpdate(character: Character) {
      if (state.failOn === character.id) throw new Error("書けませんでした");
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
    // 作品の語り手を「俺」に決めるには、地の文が500字以上・一人称が10回以上要る
    { label: "第10話", text: hero.repeat(20), chapter: 10 },
    { label: "第12話", text: prince, chapter: 12 },
  ];
});

vi.mock("../../../src/core/manuscriptSources", () => ({
  loadExcerptSources: async () => ({ sources: SOURCES, conflicted: [] }),
}));

// 人物の承認待ち・人物以外の承認待ちは空（ここでは移す案だけを見る）
vi.mock("../../../src/core/pendingUpdates", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/core/pendingUpdates")>()),
  PendingUpdateStore: class {
    async loadAll() {
      return { updates: [], errors: [] };
    }
    async discard() {}
  },
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

const work: WorkEntry = {
  id: "work_test",
  title: "ハイエルフ未亡人",
  folderPath: ["C:", "novels", "work"].join(path.sep),
  registeredAt: "2026-10-10T00:00:00.000Z",
};
const movesDir = Uri.file(path.join(work.folderPath, ".aiwriter", "pending-moves")).fsPath;

function change(field: string, value: string, chapters: number[]): RecordChange {
  return { field, value, chapters, timepointId: null, note: null, evidence: null, source: "extracted" };
}

function hero(): Character {
  return {
    ...emptyCharacter("char_007", "アジャーノ"),
    role: "冒険者",
    firstPerson: { default: "俺", variants: [] },
    changes: [change("role", "冒険者", [10]), change("role", "皇子", [12])],
    appearedChapters: [10],
  };
}

const PRINCE: Character = {
  ...emptyCharacter("char_016", "殿下"),
  firstPerson: { default: "余", variants: [] },
};

const disk = new Map<string, Uint8Array>();

beforeEach(() => {
  disk.clear();
  state.characters = [hero(), structuredClone(PRINCE)];
  state.saved = [];
  state.failOn = null;
  logged.lines = [];
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

function pendingFiles(): string[] {
  return [...disk.keys()].filter((filePath) => path.dirname(filePath) === movesDir);
}

/** 提案パネルの代わり。渡された行と、承認・見送りの口を受け取る */
function fakePanel() {
  const captured = {
    items: [] as Array<{ id: string; name: string; source: string; moveChoice?: { selected: string | null } }>,
    apply: undefined as undefined | ((id: string, keys?: string[]) => Promise<{ ok: boolean; reason?: string }>),
    dismiss: undefined as undefined | ((id: string) => Promise<{ ok: boolean; reason?: string }>),
  };
  return {
    captured,
    panel: {
      showRecordUpdates(
        _work: WorkEntry,
        items: typeof captured.items,
        apply: NonNullable<typeof captured.apply>,
        dismiss: NonNullable<typeof captured.dismiss>
      ) {
        captured.items = items;
        captured.apply = apply;
        captured.dismiss = dismiss;
      },
    },
  };
}

async function openPanel() {
  const { panel, captured } = fakePanel();
  await applyPendingCharacterUpdates(work, panel as never);
  return captured;
}

describe("抽出の終わりに積む", () => {
  test("主人公の資料に疑う値があれば、移す案を承認待ちに積む", async () => {
    expect(await stageNarratorMovesAfterExtraction(work)).toBe(1);
    expect(pendingFiles()).toHaveLength(1);
    // 資料はまだ動かさない（承認したときだけ）
    expect(state.saved).toEqual([]);
  });

  test("同じ案を積み直さない", async () => {
    await stageNarratorMovesAfterExtraction(work);
    expect(await stageNarratorMovesAfterExtraction(work)).toBe(0);
    expect(pendingFiles()).toHaveLength(1);
  });

  test("提案パネルで見送った案は、次の抽出で積まない", async () => {
    await stageNarratorMovesAfterExtraction(work);
    const captured = await openPanel();
    const [row] = captured.items;
    expect(row.name).toBe("アジャーノ");
    expect(row.source).toBe("移す案：役割「皇子」（第12話）");
    expect(await captured.dismiss!(row.id)).toEqual({ ok: true });
    expect(pendingFiles()).toHaveLength(0);
    expect(await stageNarratorMovesAfterExtraction(work)).toBe(0);
    expect(pendingFiles()).toHaveLength(0);
    // 資料には触らない
    expect(state.saved).toEqual([]);
    expect(logged.lines).toContain(
      "設定資料の更新を見送り：移す 人物「アジャーノ」役割「皇子」（第12話）（提案パネル）"
    );
  });
});

describe("提案パネルから反映する", () => {
  test("移し先 → 主人公の順に書き、ログへ1行", async () => {
    await stageNarratorMovesAfterExtraction(work);
    const captured = await openPanel();
    const [row] = captured.items;
    // 名指しできた案は、既定で移し先を選んである
    expect(row.moveChoice?.selected).toBe("char_016");
    expect(await captured.apply!(row.id, [])).toEqual({ ok: true, dropped: 0 });
    expect(state.saved).toEqual(["char_016", "char_007"]);
    const heroNow = state.characters.find((entry) => entry.id === "char_007")!;
    const princeNow = state.characters.find((entry) => entry.id === "char_016")!;
    expect(heroNow.changes.map((entry) => entry.value)).toEqual(["冒険者"]);
    expect(heroNow.rejectedValues?.map((entry) => entry.value)).toEqual(["皇子"]);
    expect(princeNow.changes.map((entry) => entry.value)).toEqual(["皇子"]);
    expect(pendingFiles()).toHaveLength(0);
    expect(logged.lines).toContain(
      "設定資料の更新を適用：移す 人物「アジャーノ」役割「皇子」（第12話）→「殿下」（提案パネル）"
    );
  });

  test("「外すだけ」を選べば、主人公だけを書く", async () => {
    await stageNarratorMovesAfterExtraction(work);
    const captured = await openPanel();
    const [row] = captured.items;
    await captured.apply!(row.id, [`${MOVE_DESTINATION_KEY_PREFIX}${MOVE_REMOVE_ONLY}`]);
    expect(state.saved).toEqual(["char_007"]);
    expect(logged.lines.some((line) => line.endsWith("→（外すだけ）（提案パネル）"))).toBe(true);
  });

  test("名指しできない案は、移し先を選ばないと反映しない（承認待ちは残る）", async () => {
    // 「余」の持ち主が台帳に居ない＝語り手を名指しできない
    state.characters = [hero(), emptyCharacter("char_016", "殿下")];
    await stageNarratorMovesAfterExtraction(work);
    const captured = await openPanel();
    const [row] = captured.items;
    expect(row.moveChoice?.selected).toBeNull();
    const outcome = await captured.apply!(row.id, []);
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toContain("移し先を選んでください");
    expect(state.saved).toEqual([]);
    expect(pendingFiles()).toHaveLength(1);
    // 選べば移る
    expect((await captured.apply!(row.id, [`${MOVE_DESTINATION_KEY_PREFIX}char_016`])).ok).toBe(true);
    expect(state.saved).toEqual(["char_016", "char_007"]);
  });

  test("移し先が書けなければ主人公も書かない（値は主人公に残る）", async () => {
    await stageNarratorMovesAfterExtraction(work);
    const captured = await openPanel();
    state.failOn = "char_016";
    const outcome = await captured.apply!(captured.items[0].id, []);
    expect(outcome.ok).toBe(false);
    expect(state.saved).toEqual([]);
    expect(state.characters.find((entry) => entry.id === "char_007")!.role).toBe("冒険者");
    expect(pendingFiles()).toHaveLength(1);
  });

  test("主人公だけ書けなければ、値は両方に残り、押し直せる", async () => {
    await stageNarratorMovesAfterExtraction(work);
    const captured = await openPanel();
    state.failOn = "char_007";
    const outcome = await captured.apply!(captured.items[0].id, []);
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toContain("値は両方に残っていて");
    expect(pendingFiles()).toHaveLength(1);
    state.failOn = null;
    expect((await captured.apply!(captured.items[0].id, [])).ok).toBe(true);
    // 移し先へ二重に足していない
    const princeNow = state.characters.find((entry) => entry.id === "char_016")!;
    expect(princeNow.changes.filter((entry) => entry.value === "皇子")).toHaveLength(1);
  });
});
