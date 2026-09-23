import * as nodePath from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  clearSeriesCache,
  listSeriesNeighbors,
  loadSeriesCharacterCandidates,
  loadSeriesTerms,
} from "../../../src/core/seriesSettings";
import { emptyCharacter, type Character } from "../../../src/models/character";
import type { WorkEntry } from "../../../src/models/types";
import { FileSystemError, FileType, Uri, workspace } from "../support/vscodeStub";

/**
 * つないだ作品から、借りてよいものだけを読む（設計書6.95.3）。
 *
 * **作り物のディスクで測る。** 実例（`教科書チート` と別視点）は作者の
 * 原稿なので、テストからは1バイトも触らない。
 */

const LIBRARY = "C:\\小説";
const SELF = nodePath.join(LIBRARY, "別視点");
const NEIGHBOR = nodePath.join(LIBRARY, "教科書チート");

const work: WorkEntry = {
  id: "work_self",
  title: "別視点",
  folderPath: SELF,
  registeredAt: "2026-09-19T00:00:00.000Z",
};

const disk = new Map<string, Uint8Array>();
const directories = new Set<string>();

function key(filePath: string): string {
  return Uri.file(filePath).fsPath;
}

function putText(filePath: string, text: string): void {
  disk.set(key(filePath), new TextEncoder().encode(text));
  directories.add(key(nodePath.dirname(filePath)));
}

function putJson(filePath: string, value: unknown): void {
  putText(filePath, JSON.stringify(value, null, 2));
}

function putConfig(
  folderPath: string,
  workTitle: string,
  series?: { name: string; related: string[] }
): void {
  putJson(nodePath.join(folderPath, ".aiwriter", "config.json"), {
    schemaVersion: "0.1",
    workTitle,
    manuscriptDir: "本文",
    settingsDir: "設定",
    createdAt: "2026-09-19T00:00:00.000Z",
    ...(series ? { series } : {}),
  });
}

function character(
  id: string,
  name: string,
  over: Partial<Character> = {}
): Character {
  return {
    ...emptyCharacter(id, name),
    updatedAt: "2026-09-19T00:00:00.000Z",
    ...over,
  };
}

function putCharacter(folderPath: string, value: Character): void {
  putJson(
    nodePath.join(folderPath, "設定", "characters", `${value.id}.json`),
    value
  );
}

beforeEach(() => {
  disk.clear();
  directories.clear();
  clearSeriesCache();

  workspace.fs = {
    createDirectory: async (uri: { fsPath: string }) => {
      directories.add(uri.fsPath);
    },
    readFile: async (uri: { fsPath: string }) => {
      const bytes = disk.get(uri.fsPath);
      if (!bytes) throw new FileSystemError("missing", "FileNotFound");
      return bytes;
    },
    readDirectory: async (uri: { fsPath: string }) => {
      if (!directories.has(uri.fsPath)) {
        throw new FileSystemError("missing", "FileNotFound");
      }
      return [...disk.keys()]
        .filter((filePath) => nodePath.dirname(filePath) === uri.fsPath)
        .map(
          (filePath) =>
            [nodePath.basename(filePath), FileType.File] as [string, FileType]
        );
    },
    stat: async (uri: { fsPath: string }) => {
      if (directories.has(uri.fsPath)) return { type: FileType.Directory };
      if (disk.has(uri.fsPath)) return { type: FileType.File };
      throw new FileSystemError("missing", "FileNotFound");
    },
    writeFile: async (uri: { fsPath: string }, bytes: Uint8Array) => {
      disk.set(uri.fsPath, bytes);
    },
  } as unknown as typeof workspace.fs;
});

/** 教科書チート側に、公開してよい人物を1人置く */
function setUpNeighbor(): void {
  directories.add(key(NEIGHBOR));
  putConfig(NEIGHBOR, "教科書チート");
  putCharacter(
    NEIGHBOR,
    character("char_001", "イント", {
      reading: "いんと",
      aliases: ["坊ちゃん"],
      summary: "化学を活用しながら戦う主人公",
      personality: "理屈っぽい",
      appearance: "黒髪の少年",
      authorNotes: "作者のメモ",
    })
  );
}

describe("つないだ作品から語を借りる（設計書6.95.3）", () => {
  it("名前と読み仮名だけを読み、紹介や性格は読まない", async () => {
    setUpNeighbor();
    putConfig(SELF, "別視点", {
      name: "教科書チートの世界",
      related: ["教科書チート"],
    });

    const terms = await loadSeriesTerms(work);
    expect(terms.map((term) => term.text)).toEqual(["イント", "坊ちゃん"]);
    expect(terms[0].reading).toBe("いんと");
    expect(terms[0].sourceTitle).toBe("教科書チート");
    // **ネタバレが漏れないことの確かめ。** 借りた語に、相手の中身を
    // 入れる欄そのものが無い
    const fields = new Set(terms.flatMap((term) => Object.keys(term)));
    expect([...fields].sort()).toEqual([
      "canonicalName",
      "kind",
      "reading",
      "sourceTitle",
      "text",
    ]);
    expect(JSON.stringify(terms)).not.toContain("化学を活用");
    expect(JSON.stringify(terms)).not.toContain("理屈っぽい");
  });

  it("別名には読み仮名を付けない（資料に無い読みを作らない）", async () => {
    setUpNeighbor();
    putConfig(SELF, "別視点", {
      name: "シリーズ",
      related: ["教科書チート"],
    });

    const terms = await loadSeriesTerms(work);
    expect(terms.find((term) => term.text === "坊ちゃん")?.reading).toBeNull();
  });

  it("まだ登場していない人物は借りない（spoilerLevel を越えない）", async () => {
    directories.add(key(NEIGHBOR));
    putConfig(NEIGHBOR, "教科書チート");
    putCharacter(
      NEIGHBOR,
      character("char_010", "まだ出ない人", { status: "未登場" })
    );
    putCharacter(
      NEIGHBOR,
      character("char_011", "内緒の人", { spoilerLevel: "author_only" })
    );
    putCharacter(NEIGHBOR, character("char_012", "出ている人"));
    putConfig(SELF, "別視点", {
      name: "シリーズ",
      related: ["教科書チート"],
    });

    const terms = await loadSeriesTerms(work);
    expect(terms.map((term) => term.text)).toEqual(["出ている人"]);
  });

  it("相手のフォルダーが無ければ、黙って何も返さない", async () => {
    putConfig(SELF, "別視点", {
      name: "シリーズ",
      related: ["ありもしない作品"],
    });

    await expect(loadSeriesTerms(work)).resolves.toEqual([]);
    await expect(listSeriesNeighbors(work)).resolves.toEqual([]);
  });

  it("つないでいない作品では、何も読みに行かない", async () => {
    setUpNeighbor();
    putConfig(SELF, "別視点");

    await expect(loadSeriesTerms(work)).resolves.toEqual([]);
  });

  it("壊れたJSONは、その1件を飛ばして残りを読む", async () => {
    setUpNeighbor();
    putText(
      nodePath.join(NEIGHBOR, "設定", "characters", "char_999.json"),
      "{ これはJSONではない"
    );
    putConfig(SELF, "別視点", {
      name: "シリーズ",
      related: ["教科書チート"],
    });

    const terms = await loadSeriesTerms(work);
    expect(terms.map((term) => term.text)).toEqual(["イント", "坊ちゃん"]);
  });

  it("自分の設定が読めなくても、止まらずに空で返す", async () => {
    setUpNeighbor();
    // 自分の config.json を置かない

    await expect(loadSeriesTerms(work)).resolves.toEqual([]);
  });
});

describe("人物の候補（設計書6.95.3）", () => {
  it("候補には紹介と別名まで読む（写す中身を見せるため）", async () => {
    setUpNeighbor();
    putConfig(SELF, "別視点", {
      name: "シリーズ",
      related: ["教科書チート"],
    });

    const candidates = await loadSeriesCharacterCandidates(work);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].name).toBe("イント");
    expect(candidates[0].summary).toBe("化学を活用しながら戦う主人公");
    expect(candidates[0].aliases).toEqual(["坊ちゃん"]);
    expect(candidates[0].sourceTitle).toBe("教科書チート");
  });

  it("候補にも同じ関門がかかる（未登場の人物は出さない）", async () => {
    directories.add(key(NEIGHBOR));
    putConfig(NEIGHBOR, "教科書チート");
    putCharacter(
      NEIGHBOR,
      character("char_010", "まだ出ない人", { status: "未登場" })
    );
    putConfig(SELF, "別視点", {
      name: "シリーズ",
      related: ["教科書チート"],
    });

    await expect(loadSeriesCharacterCandidates(work)).resolves.toEqual([]);
  });
});
