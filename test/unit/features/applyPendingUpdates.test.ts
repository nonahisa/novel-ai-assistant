import { beforeEach, describe, expect, test, vi } from "vitest";
import { window } from "../support/vscodeStub";
import { emptyCharacter, type Character } from "../../../src/models/character";
import type { WorkEntry } from "../../../src/models/types";

/**
 * 承認待ちの更新案を、作者が確認して反映する道（`applyPendingUpdates`）。
 *
 * ここは**抽出が積んだ提案の出口**でもあるので、プロットからの新規案
 * （設計書6.4.9）を足すときに壊してはいけない振る舞いを先に固定する。
 *
 * - 台帳に居ないID・差分0件の更新案は片付ける（古い提案を残さない）
 * - 反映は必ず `saveOrUpdate`（退避つきの道）を通る。`save` を直に呼ばない
 * - 「見送る」はレコードに触れず、承認待ちだけを片付ける
 */

const state = vi.hoisted(() => ({
  pending: [] as unknown[],
  pendingErrors: [] as unknown[],
  characters: [] as unknown[],
  loadErrors: [] as unknown[],
  // **本当の呼ばれ方で型を付ける**（`CharacterStore` / `PendingUpdateStore`
  // と同じ形）。引数なしの関数として書くと mock.calls の中身が空の組になり、
  // 「どの人物を渡して保存したか」を見るテストが型で引けない
  saveOrUpdate: vi.fn<(character: Character) => Promise<void>>(
    async () => undefined
  ),
  save: vi.fn<(character: Character) => Promise<void>>(async () => undefined),
  discard: vi.fn<(filePath: string) => Promise<void>>(async () => undefined),
}));

vi.mock("../../../src/core/characterStore", () => ({
  CharacterStoreError: class CharacterStoreError extends Error {},
  CharacterStore: class {
    async loadAll() {
      return { characters: state.characters, errors: state.loadErrors };
    }
    saveOrUpdate = state.saveOrUpdate;
    save = state.save;
  },
}));

vi.mock("../../../src/core/pendingUpdates", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/core/pendingUpdates")>()),
  PendingUpdateStore: class {
    async loadAll() {
      return { updates: state.pending, errors: state.pendingErrors };
    }
    discard = state.discard;
    // 書く前に承認待ちのファイルがまだあるかを見る（0.102.4）。積んだ案はある
    async exists(filePath: string) {
      return state.pending.some(
        (update) => (update as { filePath?: string }).filePath === filePath
      );
    }
  },
}));

// 人物以外の承認待ち（2026-09-23〜）。ここでは人物の振る舞いだけを見るので、
// 空の置き場として代役を立てる（本物の読み書きは pendingSettingsUpdates.test.ts）
vi.mock("../../../src/core/pendingSettingsUpdates", () => ({
  PendingSettingsUpdateStore: class {
    async loadAll() {
      return { updates: [], errors: [] };
    }
    async discard() {}
  },
}));

// 語り手の取り違えの移す案（0.102.3）。ここでは空の置き場（本物は narratorMovePending.test.ts）
vi.mock("../../../src/core/pendingNarratorMoveStore", () => ({
  PendingNarratorMoveStore: class {
    async loadAll() {
      return { moves: [], errors: [] };
    }
    async discard() {}
  },
  NarratorMoveDismissedHistory: class {
    async load() {
      return new Set<string>();
    }
    async add() {}
  },
}));

vi.mock("../../../src/core/customFieldStore", () => ({
  CustomFieldStore: class {
    async loadFields() {
      return [];
    }
  },
}));

vi.mock("../../../src/views/openDocument", () => ({
  openGeneratedMarkdown: vi.fn(async () => undefined),
}));

// 記録の書き先を向ける口も代役に要る（0.45.0 で features 全体へ広げた）。
// **書いた行と、行の直前に向けた書き先を順に積む**（0.101.13。反映しても
// 作品のログに1行も残らなかった）
const logged = vi.hoisted(() => ({ events: [] as string[] }));
vi.mock("../../../src/core/logger", () => ({
  logFailure: vi.fn(),
  logLine: vi.fn((message: string) => logged.events.push(`line:${message}`)),
  useLogFile: vi.fn((folder: string) => logged.events.push(`use:${folder}`)),
}));

const { applyPendingCharacterUpdates } = await import(
  "../../../src/features/applyPendingUpdates"
);

const work: WorkEntry = {
  id: "work_test",
  title: "氷の街",
  folderPath: "C:\\novels\\work",
  registeredAt: "2026-09-04T00:00:00.000Z",
};

/** 提案パネルの代わり。渡された行と、承認・見送りの口を受け取る */
function fakePanel() {
  const captured = {
    items: [] as Array<{ id: string; name: string; source: string }>,
    apply: undefined as
      | ((id: string) => Promise<{ ok: boolean; reason?: string }>)
      | undefined,
    dismiss: undefined as
      | ((id: string) => Promise<{ ok: boolean; reason?: string }>)
      | undefined,
  };
  const panel = {
    showRecordUpdates(
      _work: WorkEntry,
      items: Array<{ id: string; name: string; source: string }>,
      apply: (id: string) => Promise<{ ok: boolean; reason?: string }>,
      dismiss: (id: string) => Promise<{ ok: boolean; reason?: string }>
    ) {
      captured.items = items;
      captured.apply = apply;
      captured.dismiss = dismiss;
    },
  };
  return { panel, captured };
}

function character(id: string, name: string, summary: string): Character {
  return { ...emptyCharacter(id, name), summary };
}

describe("承認待ちの反映（既存の振る舞い）", () => {
  let announced: string[] = [];

  beforeEach(() => {
    announced = [];
    state.pending = [];
    state.pendingErrors = [];
    state.characters = [];
    state.loadErrors = [];
    state.saveOrUpdate.mockClear();
    state.save.mockClear();
    state.discard.mockClear();

    window.showInformationMessage = (async (message: string) => {
      announced.push(message);
      return undefined;
    }) as typeof window.showInformationMessage;
    window.showWarningMessage = (async (message: string) => {
      announced.push(message);
      return undefined;
    }) as typeof window.showWarningMessage;
    window.showErrorMessage = (async (message: string) => {
      announced.push(message);
      return undefined;
    }) as typeof window.showErrorMessage;
  });

  test("既存の更新案は、差分つきでパネルへ出る", async () => {
    state.characters = [character("char_001", "灯", "主人公")];
    state.pending = [
      {
        character: character("char_001", "灯", "主人公。幽霊が見える。"),
        filePath: "pending/char_001.json",
      },
    ];

    const { panel, captured } = fakePanel();
    await applyPendingCharacterUpdates(work, panel as never);

    expect(captured.items).toHaveLength(1);
    expect(captured.items[0].name).toBe("灯");
    expect(captured.items[0].source).toContain("紹介を変更");
    expect(state.discard).not.toHaveBeenCalled();
  });

  test("承認すると saveOrUpdate（退避つきの道）で保存し、承認待ちを片付ける", async () => {
    state.characters = [character("char_001", "灯", "主人公")];
    state.pending = [
      {
        character: character("char_001", "灯", "主人公。幽霊が見える。"),
        filePath: "pending/char_001.json",
      },
    ];

    const { panel, captured } = fakePanel();
    await applyPendingCharacterUpdates(work, panel as never);
    const result = await captured.apply!("pending/char_001.json");

    expect(result.ok).toBe(true);
    expect(state.saveOrUpdate).toHaveBeenCalledTimes(1);
    // **`save` を直に呼ばない**（既存ファイルは上書きできない）
    expect(state.save).not.toHaveBeenCalled();
    const saved = state.saveOrUpdate.mock.calls[0][0];
    expect(saved.id).toBe("char_001");
    expect(saved.summary).toBe("主人公。幽霊が見える。");
    expect(state.discard).toHaveBeenCalledWith("pending/char_001.json");
  });

  test("見送ると、レコードに触れずに承認待ちだけ片付ける", async () => {
    state.characters = [character("char_001", "灯", "主人公")];
    state.pending = [
      {
        character: character("char_001", "灯", "別の紹介"),
        filePath: "pending/char_001.json",
      },
    ];

    const { panel, captured } = fakePanel();
    await applyPendingCharacterUpdates(work, panel as never);
    const result = await captured.dismiss!("pending/char_001.json");

    expect(result.ok).toBe(true);
    expect(state.saveOrUpdate).not.toHaveBeenCalled();
    expect(state.discard).toHaveBeenCalledWith("pending/char_001.json");
  });

  test("台帳に居ない人物の更新案は、反映せずに片付ける", async () => {
    state.characters = [character("char_001", "灯", "主人公")];
    state.pending = [
      {
        character: character("char_009", "消えた人", "紹介"),
        filePath: "pending/char_009.json",
      },
    ];

    const { panel, captured } = fakePanel();
    await applyPendingCharacterUpdates(work, panel as never);

    expect(state.discard).toHaveBeenCalledWith("pending/char_009.json");
    expect(captured.items).toEqual([]);
    expect(announced.join("")).toContain("反映が必要な更新はありませんでした");
  });

  test("差分の無い更新案も片付ける", async () => {
    state.characters = [character("char_001", "灯", "主人公")];
    state.pending = [
      {
        character: character("char_001", "灯", "主人公"),
        filePath: "pending/char_001.json",
      },
    ];

    const { panel } = fakePanel();
    await applyPendingCharacterUpdates(work, panel as never);

    expect(state.discard).toHaveBeenCalledWith("pending/char_001.json");
    expect(state.saveOrUpdate).not.toHaveBeenCalled();
  });

  test("読めない人物設定があれば、何も反映しない", async () => {
    state.loadErrors = [{ file: "char_001_灯.json", message: "壊れています" }];
    state.pending = [
      {
        character: character("char_001", "灯", "紹介"),
        filePath: "pending/char_001.json",
      },
    ];

    const { panel } = fakePanel();
    await applyPendingCharacterUpdates(work, panel as never);

    expect(state.saveOrUpdate).not.toHaveBeenCalled();
    expect(state.discard).not.toHaveBeenCalled();
  });
});

describe("プロットからの新規の人物案（設計書6.4.9）", () => {
  beforeEach(() => {
    state.pending = [];
    state.pendingErrors = [];
    state.characters = [];
    state.loadErrors = [];
    state.saveOrUpdate.mockClear();
    state.save.mockClear();
    state.discard.mockClear();
    window.showInformationMessage = (async () =>
      undefined) as typeof window.showInformationMessage;
  });

  /** 仮のIDで積まれた新規案 */
  function creation(name: string, summary: string): Record<string, unknown> {
    return {
      character: { ...emptyCharacter("char_000", name), summary },
      filePath: `pending/new_${name}.json`,
      kind: "creation",
      source: "plot",
    };
  }

  test("台帳に居なくても片付けられず、新規としてパネルへ出る", async () => {
    state.characters = [character("char_001", "灯", "主人公")];
    state.pending = [creation("澪", "灯の親友")];

    const { panel, captured } = fakePanel();
    await applyPendingCharacterUpdates(work, panel as never);

    expect(state.discard).not.toHaveBeenCalled();
    expect(captured.items).toHaveLength(1);
    expect(captured.items[0].name).toBe("澪");
    expect(captured.items[0].source).toBe("プロットから：新規の人物");
  });

  test("承認すると、採番して saveOrUpdate で作る", async () => {
    state.characters = [character("char_001", "灯", "主人公")];
    state.pending = [creation("澪", "灯の親友")];

    const { panel, captured } = fakePanel();
    await applyPendingCharacterUpdates(work, panel as never);
    const result = await captured.apply!("pending/new_澪.json");

    expect(result.ok).toBe(true);
    expect(state.saveOrUpdate).toHaveBeenCalledTimes(1);
    expect(state.save).not.toHaveBeenCalled();
    const created = state.saveOrUpdate.mock.calls[0][0];
    // 仮のIDのままでは、次に作った人物と衝突する
    expect(created.id).toBe("char_002");
    expect(created.name).toBe("澪");
    expect(created.summary).toBe("灯の親友");
    expect(created.autoGenerated).toBe(true);
    expect(created.appearedChapters).toEqual([]);
    expect(state.discard).toHaveBeenCalledWith("pending/new_澪.json");
  });

  test("続けて承認しても、同じIDを二度使わない", async () => {
    state.characters = [character("char_001", "灯", "主人公")];
    state.pending = [creation("澪", "親友"), creation("太志", "担任")];

    const { panel, captured } = fakePanel();
    await applyPendingCharacterUpdates(work, panel as never);
    await captured.apply!("pending/new_澪.json");
    await captured.apply!("pending/new_太志.json");

    const ids = state.saveOrUpdate.mock.calls.map(
      (call) => call[0].id
    );
    expect(ids).toEqual(["char_002", "char_003"]);
  });

  test("見送れる（レコードは作らない）", async () => {
    state.pending = [creation("澪", "親友")];

    const { panel, captured } = fakePanel();
    await applyPendingCharacterUpdates(work, panel as never);
    const result = await captured.dismiss!("pending/new_澪.json");

    expect(result.ok).toBe(true);
    expect(state.saveOrUpdate).not.toHaveBeenCalled();
    expect(state.discard).toHaveBeenCalledWith("pending/new_澪.json");
  });

  test("その名前の人物が既に居れば、二重に作らず片付ける", async () => {
    state.characters = [character("char_001", "澪", "灯の親友")];
    state.pending = [creation("澪", "灯の親友")];

    const { panel, captured } = fakePanel();
    await applyPendingCharacterUpdates(work, panel as never);

    expect(captured.items).toEqual([]);
    expect(state.discard).toHaveBeenCalledWith("pending/new_澪.json");
  });
});

/**
 * **プロット・相談から来た「既存人物の更新案」**（設計書6.4.9・6.72）。
 *
 * 積むところ（plot.md の保存・「相談を資料へ反映」）は
 * `plotCharacterSyncSave.test.ts`・`chatSettingsSync.test.ts` が見ている。
 * ここでは積んだあと——「更新分を反映」で**出どころの印つきで並び**、
 * **承認するまで資料が変わらず、承認すると紹介が変わる**ことを見る
 * （実機確認リスト F-72・F-77 の代わり）。
 */
describe("プロット・相談から来た既存人物の更新案", () => {
  beforeEach(() => {
    state.pending = [];
    state.pendingErrors = [];
    state.characters = [];
    state.loadErrors = [];
    state.saveOrUpdate.mockClear();
    state.save.mockClear();
    state.discard.mockClear();
    window.showInformationMessage = (async () =>
      undefined) as typeof window.showInformationMessage;
  });

  /** 既存の「灯」の紹介を書き換える案 */
  function update(source: "plot" | "chat"): Record<string, unknown> {
    return {
      character: character("char_001", "灯", "幽霊の見える高校生"),
      filePath: `pending/char_001_${source}.json`,
      source,
    };
  }

  test.each([
    ["plot", "プロットから：紹介を変更"],
    ["chat", "相談から：紹介を変更"],
  ] as const)("%s から来た案は「%s」の印で並ぶ", async (source, label) => {
    state.characters = [character("char_001", "灯", "主人公")];
    state.pending = [update(source)];

    const { panel, captured } = fakePanel();
    await applyPendingCharacterUpdates(work, panel as never);

    expect(captured.items).toHaveLength(1);
    expect(captured.items[0].source).toBe(label);
  });

  test.each(["plot", "chat"] as const)(
    "%s から来た案は、承認するまで資料を変えず、承認すると紹介が変わる",
    async (source) => {
      state.characters = [character("char_001", "灯", "主人公")];
      state.pending = [update(source)];

      const { panel, captured } = fakePanel();
      await applyPendingCharacterUpdates(work, panel as never);

      // 並べただけでは何も保存しない
      expect(state.saveOrUpdate).not.toHaveBeenCalled();
      expect(state.save).not.toHaveBeenCalled();

      const result = await captured.apply!(`pending/char_001_${source}.json`);

      expect(result.ok).toBe(true);
      expect(state.saveOrUpdate).toHaveBeenCalledTimes(1);
      expect(state.save).not.toHaveBeenCalled();
      const saved = state.saveOrUpdate.mock.calls[0][0];
      expect(saved.id).toBe("char_001");
      expect(saved.summary).toBe("幽霊の見える高校生");
      expect(state.discard).toHaveBeenCalledWith(`pending/char_001_${source}.json`);
    }
  );
});

/**
 * **反映・見送りを作品のログへ1件1行で残す**（0.101.13）。
 *
 * 2026-10-10、作者の作品で抽出の直後に人物6件が提案パネルから書き換わった
 * のに、`.aiwriter/logs/actions.log` に1行も無かった。失敗だけは
 * `logFailure` で残っていたが、成功と見送りは黙っていた。
 */
describe("反映・見送りの記録", () => {
  beforeEach(() => {
    state.pending = [];
    state.pendingErrors = [];
    state.characters = [];
    state.loadErrors = [];
    state.saveOrUpdate.mockClear();
    state.save.mockClear();
    state.discard.mockClear();
    logged.events = [];
  });

  /** 行だけを取り出す */
  function lines(): string[] {
    return logged.events
      .filter((event) => event.startsWith("line:"))
      .map((event) => event.slice("line:".length));
  }

  /** 1件の行の直前に、作品のログへ書き先を向けたか */
  function pointedToWorkBefore(line: string): boolean {
    const index = logged.events.indexOf(`line:${line}`);
    return index > 0 && logged.events[index - 1] === `use:${work.folderPath}`;
  }

  function aliasUpdate(): void {
    state.characters = [{ ...character("char_001", "灯", "主人公"), personality: "無口" }];
    state.pending = [
      {
        character: {
          ...character("char_001", "灯", "主人公"),
          aliases: ["灯ちゃん", "あかりん"],
          personality: "無口。幽霊が見える",
        },
        filePath: "pending/char_001.json",
      },
    ];
  }

  test("提案パネルで反映すると、作品のログへ1行残る", async () => {
    aliasUpdate();
    const { panel, captured } = fakePanel();
    await applyPendingCharacterUpdates(work, panel as never);
    logged.events = [];

    await captured.apply!("pending/char_001.json");

    const expected = "設定資料の更新を適用：人物「灯」 別名＋2・性格（追記）（提案パネル）";
    expect(lines()).toEqual([expected]);
    expect(pointedToWorkBefore(expected)).toBe(true);
  });

  test("✕ で落とした葉は数えず、落とした数を添える", async () => {
    aliasUpdate();
    const { panel, captured } = fakePanel();
    await applyPendingCharacterUpdates(work, panel as never);
    logged.events = [];

    await (captured.apply as unknown as (id: string, keys: string[]) => Promise<unknown>)(
      "pending/char_001.json",
      ["alias:あかりん"]
    );

    expect(lines()).toEqual([
      "設定資料の更新を適用：人物「灯」 別名＋1・性格（追記）（✕で1件を落とした）（提案パネル）",
    ]);
  });

  test("提案パネルで見送ると、作品のログへ1行残る", async () => {
    aliasUpdate();
    const { panel, captured } = fakePanel();
    await applyPendingCharacterUpdates(work, panel as never);
    logged.events = [];

    await captured.dismiss!("pending/char_001.json");

    const expected = "設定資料の更新を見送り：人物「灯」 別名＋2・性格（追記）（提案パネル）";
    expect(lines()).toEqual([expected]);
    expect(pointedToWorkBefore(expected)).toBe(true);
  });

  test("反映に失敗したら、適用の行は書かない（失敗は logFailure が残す）", async () => {
    aliasUpdate();
    state.saveOrUpdate.mockRejectedValueOnce(new Error("書けませんでした"));
    const { panel, captured } = fakePanel();
    await applyPendingCharacterUpdates(work, panel as never);
    logged.events = [];

    const result = await captured.apply!("pending/char_001.json");

    expect(result.ok).toBe(false);
    expect(lines()).toEqual([]);
  });

  test("確認ダイアログの「すべて反映」も、1件ずつと件数の行を残す", async () => {
    state.characters = [
      character("char_001", "灯", "主人公"),
      character("char_002", "澪", "親友"),
    ];
    state.pending = [
      { character: character("char_001", "灯", "主人公。幽霊が見える"), filePath: "pending/char_001.json" },
      { character: character("char_002", "澪", "灯の親友"), filePath: "pending/char_002.json" },
    ];
    window.showInformationMessage = (async (_message: string, ...rest: unknown[]) =>
      rest.includes("すべて反映") ? "すべて反映" : undefined) as typeof window.showInformationMessage;

    await applyPendingCharacterUpdates(work);

    expect(state.saveOrUpdate).toHaveBeenCalledTimes(2);
    expect(lines()).toEqual([
      "設定資料の更新を適用：人物「灯」 紹介（追記）（確認ダイアログ）",
      "設定資料の更新を適用：人物「澪」 紹介（変更）（確認ダイアログ）",
      "設定資料の更新をまとめて適用：2/2件（確認ダイアログ）",
    ]);
    // 1件目の行より前に、作品のログへ向けてある
    expect(logged.events[0]).toBe(`use:${work.folderPath}`);
  });
});
