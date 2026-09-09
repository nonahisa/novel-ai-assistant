import * as nodePath from "path";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { FileSystemError, Uri, window, workspace } from "./support/vscodeStub";
import { emptyCharacter, type Character } from "../../src/models/character";
import type { WorkEntry } from "../../src/models/types";

/**
 * plot.md を保存したときの、設定資料への差分反映（設計書6.4.9）。
 *
 * **同じ提案を二度積まない。** 前回反映した欄の内容ハッシュを `.aiwriter`
 * に覚え、変わったときだけ承認待ちへ積む。保存のたびに同じ行が増える
 * 提案パネルは、読まれなくなる。
 *
 * 台帳（`設定/characters/*.json`）へは書かない。積むのは承認待ちだけで、
 * 反映は既存の「更新分を反映」が行う。
 */

const state = vi.hoisted(() => ({
  plotText: "",
  characters: [] as unknown[],
  loadErrors: [] as unknown[],
  stage: vi.fn(async () => undefined),
}));

vi.mock("../../src/core/plotFile", () => ({
  readPlotText: vi.fn(async () => state.plotText),
}));

vi.mock("../../src/core/characterStore", () => ({
  CharacterStore: class {
    async loadAll() {
      return { characters: state.characters, errors: state.loadErrors };
    }
  },
}));

vi.mock("../../src/core/pendingUpdates", () => ({
  PendingUpdateStore: class {
    stage = state.stage;
  },
}));

vi.mock("../../src/core/logger", () => ({ logFailure: vi.fn() }));

const { syncPlotCharacters } = await import(
  "../../src/features/plotCharacterSync"
);

const work: WorkEntry = {
  id: "work_test",
  title: "氷の街",
  folderPath: nodePath.join("C:", "novels", "work"),
  registeredAt: "2026-09-04T00:00:00.000Z",
};

const statePath = Uri.file(
  nodePath.join(work.folderPath, ".aiwriter", "plot-sync.json")
).fsPath;

function character(id: string, name: string, summary: string): Character {
  return { ...emptyCharacter(id, name), summary };
}

function plot(body: string): string {
  return ["# 氷の街", "", "## 主要登場人物", body, ""].join("\n");
}

describe("plot.md の保存で人物の更新案を積む", () => {
  const disk = new Map<string, Uint8Array>();
  let announced: string[] = [];

  beforeEach(() => {
    disk.clear();
    announced = [];
    state.stage.mockClear();
    state.loadErrors = [];
    state.characters = [character("char_001", "灯", "主人公")];
    state.plotText = plot("- 灯：主人公。幽霊が見える。");

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
    } as unknown as typeof workspace.fs;

    window.showInformationMessage = (async (message: string) => {
      announced.push(message);
      return undefined;
    }) as typeof window.showInformationMessage;
    window.showWarningMessage = (async (message: string) => {
      announced.push(message);
      return undefined;
    }) as typeof window.showWarningMessage;
  });

  test("紹介文が変わっていれば、承認待ちへ「プロット」の印つきで積む", async () => {
    const result = await syncPlotCharacters(work);

    expect(result.staged).toBe(1);
    expect(state.stage).toHaveBeenCalledTimes(1);
    const [staged, options] = state.stage.mock.calls[0] as unknown as [
      Character[],
      { source?: string },
    ];
    expect(staged).toHaveLength(1);
    expect(staged[0].id).toBe("char_001");
    expect(staged[0].summary).toBe("主人公。幽霊が見える。");
    expect(options).toEqual({ source: "plot" });
    expect(announced.join("")).toContain("プロットから人物1件");
    // 覚え書きは `.aiwriter` へ残す（作者が読む「設定」を散らかさない）
    expect(disk.has(statePath)).toBe(true);
  });

  test("二度目の保存では、同じ提案を積み直さない", async () => {
    await syncPlotCharacters(work);
    state.stage.mockClear();
    announced = [];

    const result = await syncPlotCharacters(work);

    expect(result.unchanged).toBe(true);
    expect(state.stage).not.toHaveBeenCalled();
    // 新しい情報が無ければ何も言わない
    expect(announced).toEqual([]);
  });

  test("並べ替えただけでは積み直さない", async () => {
    state.characters = [
      character("char_001", "灯", "主人公"),
      character("char_002", "澪", "親友"),
    ];
    state.plotText = plot(["- 灯：主人公。", "- 澪：灯の親友。"].join("\n"));
    await syncPlotCharacters(work);
    state.stage.mockClear();

    state.plotText = plot(["- 澪：灯の親友。", "- 灯：主人公。"].join("\n"));
    const result = await syncPlotCharacters(work);

    expect(result.unchanged).toBe(true);
    expect(state.stage).not.toHaveBeenCalled();
  });

  test("手で押したときは、変わっていなくても積み直して結果を知らせる", async () => {
    await syncPlotCharacters(work);
    state.stage.mockClear();
    announced = [];

    const result = await syncPlotCharacters(work, { force: true });

    expect(result.unchanged).toBe(false);
    expect(state.stage).toHaveBeenCalledTimes(1);
    expect(announced.join("")).toContain("プロットから人物1件");
  });

  test("手で押して積むものが無ければ、そう知らせる", async () => {
    state.plotText = plot("- 灯：主人公");
    const result = await syncPlotCharacters(work, { force: true });

    expect(result.staged).toBe(0);
    expect(state.stage).not.toHaveBeenCalled();
    expect(announced.join("")).toContain("反映するものはありません");
  });

  test("作者が確定させた人物は変えず、その旨を添える", async () => {
    state.characters = [
      { ...character("char_001", "灯", "主人公"), autoGenerated: false },
    ];

    const result = await syncPlotCharacters(work, { force: true });

    expect(result.staged).toBe(0);
    expect(result.skipped).toEqual([
      { name: "灯", reason: "authorConfirmed" },
    ]);
    expect(state.stage).not.toHaveBeenCalled();
    expect(announced.join("")).toContain("作者が確定させた人物");
  });

  test("読めない行があれば、件数を添える", async () => {
    state.plotText = plot(
      ["- 灯：主人公。幽霊が見える。", "この節はあとで書き直す。"].join("\n")
    );

    const result = await syncPlotCharacters(work);

    expect(result.unparsed).toBe(1);
    expect(announced.join("")).toContain("1行は読めませんでした");
  });

  test("資料にまだ無い名前は、新規の人物案として積む", async () => {
    state.plotText = plot("- 澪：灯の親友");

    const result = await syncPlotCharacters(work);

    expect(result.staged).toBe(0);
    expect(result.creations).toEqual(["澪"]);
    expect(state.stage).toHaveBeenCalledTimes(1);
    const [staged, options] = state.stage.mock.calls[0] as unknown as [
      Character[],
      { source?: string; kind?: string },
    ];
    expect(staged).toHaveLength(1);
    expect(staged[0].name).toBe("澪");
    expect(staged[0].summary).toBe("灯の親友");
    // 抽出の新規と同じ流儀。**本文にはまだ出ていない**ので未登場
    expect(staged[0].autoGenerated).toBe(true);
    expect(staged[0].appearedChapters).toEqual([]);
    expect(staged[0].status).toBe("未登場");
    expect(options).toEqual({ source: "plot", kind: "creation" });
    expect(announced.join("")).toContain("新規案");
  });

  test("新規と更新が混ざったら、内訳を出して両方を積む", async () => {
    state.plotText = plot(
      ["- 灯：主人公。幽霊が見える。", "- 澪：灯の親友"].join("\n")
    );

    const result = await syncPlotCharacters(work);

    expect(result.staged).toBe(1);
    expect(result.creations).toEqual(["澪"]);
    expect(state.stage).toHaveBeenCalledTimes(2);
    expect(announced.join("")).toContain("新規1件・更新1件");
  });

  test("人物設定が読めないときは、積まずに止める", async () => {
    state.loadErrors = [{ file: "char_001_灯.json", message: "壊れています" }];

    const result = await syncPlotCharacters(work);

    expect(result.staged).toBe(0);
    expect(state.stage).not.toHaveBeenCalled();
    // 覚え書きも残さない（次の保存でやり直せるようにする）
    expect(disk.has(statePath)).toBe(false);
  });

  test("主要登場人物の節が無ければ、何もしない", async () => {
    state.plotText = ["# 氷の街", "", "## あらすじ", "- 灯が歩く。"].join("\n");

    const result = await syncPlotCharacters(work);

    expect(result.staged).toBe(0);
    expect(state.stage).not.toHaveBeenCalled();
    expect(announced).toEqual([]);
  });
});
