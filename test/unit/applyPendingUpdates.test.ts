import { beforeEach, describe, expect, test, vi } from "vitest";
import { window } from "./support/vscodeStub";
import { emptyCharacter, type Character } from "../../src/models/character";
import type { WorkEntry } from "../../src/models/types";

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
  saveOrUpdate: vi.fn(async () => undefined),
  save: vi.fn(async () => undefined),
  discard: vi.fn(async () => undefined),
}));

vi.mock("../../src/core/characterStore", () => ({
  CharacterStoreError: class CharacterStoreError extends Error {},
  CharacterStore: class {
    async loadAll() {
      return { characters: state.characters, errors: state.loadErrors };
    }
    saveOrUpdate = state.saveOrUpdate;
    save = state.save;
  },
}));

vi.mock("../../src/core/pendingUpdates", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/core/pendingUpdates")>()),
  PendingUpdateStore: class {
    async loadAll() {
      return { updates: state.pending, errors: state.pendingErrors };
    }
    discard = state.discard;
  },
}));

vi.mock("../../src/core/customFieldStore", () => ({
  CustomFieldStore: class {
    async loadFields() {
      return [];
    }
  },
}));

vi.mock("../../src/views/openDocument", () => ({
  openGeneratedMarkdown: vi.fn(async () => undefined),
}));

vi.mock("../../src/core/logger", () => ({ logFailure: vi.fn() }));

const { applyPendingCharacterUpdates } = await import(
  "../../src/features/applyPendingUpdates"
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
    const saved = state.saveOrUpdate.mock.calls[0][0] as unknown as Character;
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
    const created = state.saveOrUpdate.mock.calls[0][0] as unknown as Character;
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
      (call) => (call[0] as unknown as Character).id
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
