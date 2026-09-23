import * as nodePath from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  buildSeriesMatchPairs,
  offerSeriesCharacterMatches,
} from "../../src/features/seriesCharacterCandidates";
import { clearSeriesCache } from "../../src/core/seriesSettings";
import { emptyCharacter, type Character } from "../../src/models/character";
import type { SeriesCharacterCandidate } from "../../src/core/seriesLink";
import type { WorkEntry } from "../../src/models/types";
import {
  FileSystemError,
  FileType,
  Uri,
  window,
  workspace,
} from "./support/vscodeStub";

/**
 * 設定資料の抽出で出た新しい人物に、シリーズの同名を候補として並べる。
 *
 * **確かめたいのは「自動で合体しない」こと**（設計書6.95.3）。
 * 既定は「別人として扱う」で、作者が選ばなければ1バイトも変わらない。
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

function putJson(filePath: string, value: unknown): void {
  disk.set(
    key(filePath),
    new TextEncoder().encode(JSON.stringify(value, null, 2))
  );
  directories.add(key(nodePath.dirname(filePath)));
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

function candidate(
  over: Partial<SeriesCharacterCandidate> = {}
): SeriesCharacterCandidate {
  return {
    name: "イント",
    reading: "いんと",
    aliases: ["坊ちゃん"],
    summary: "化学を活用しながら戦う主人公",
    sourceTitle: "教科書チート",
    sourceFolderName: "教科書チート",
    ...over,
  };
}

beforeEach(() => {
  disk.clear();
  directories.clear();
  clearSeriesCache();
  window.showQuickPick = async () => undefined;
  window.showInformationMessage = async () => undefined;

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

  directories.add(key(NEIGHBOR));
  putConfig(NEIGHBOR, "教科書チート");
  putCharacter(
    NEIGHBOR,
    character("char_001", "イント", {
      reading: "いんと",
      aliases: ["坊ちゃん"],
      summary: "化学を活用しながら戦う主人公",
    })
  );
  putConfig(SELF, "別視点", {
    name: "教科書チートの世界",
    related: ["教科書チート"],
  });
});

describe("候補の組み立て（設計書6.95.3）", () => {
  it("同じ名前の人物を候補として並べる", () => {
    const pairs = buildSeriesMatchPairs(
      [character("char_a", "イント"), character("char_b", "語り手")],
      [candidate()]
    );
    expect(pairs).toHaveLength(1);
    expect(pairs[0].character.id).toBe("char_a");
  });

  it("モブは候補にしない", () => {
    const pairs = buildSeriesMatchPairs(
      [character("char_a", "イント", { isMob: true })],
      [candidate()]
    );
    expect(pairs).toEqual([]);
  });

  it("候補を組み立てても、人物のレコードは変わらない", () => {
    const mine = character("char_a", "イント");
    buildSeriesMatchPairs([mine], [candidate()]);
    expect(mine.reading).toBeNull();
    expect(mine.summary).toBeNull();
    expect(mine.aliases).toEqual([]);
  });
});

describe("自動で合体しない（設計書6.95.3）", () => {
  it("候補は既定で1つも選ばれていない", async () => {
    let shown: Array<{ picked?: boolean; label: string }> = [];
    window.showQuickPick = async (items: unknown) => {
      shown = items as Array<{ picked?: boolean; label: string }>;
      return undefined;
    };

    const result = await offerSeriesCharacterMatches(work, [
      character("char_a", "イント"),
    ]);

    expect(result.offered).toBe(1);
    expect(shown.map((item) => item.picked)).toEqual([false]);
  });

  it("選ばなければ、人物のファイルを書き換えない", async () => {
    putCharacter(SELF, character("char_a", "イント"));
    const before = new Map(disk);

    const result = await offerSeriesCharacterMatches(work, [
      character("char_a", "イント"),
    ]);

    expect(result.copied).toBe(0);
    expect([...disk.keys()].sort()).toEqual([...before.keys()].sort());
    for (const [path, bytes] of before) {
      expect(disk.get(path)).toEqual(bytes);
    }
  });

  it("つないでいなければ、候補そのものを出さない", async () => {
    putConfig(SELF, "別視点");
    let asked = false;
    window.showQuickPick = async () => {
      asked = true;
      return undefined;
    };

    const result = await offerSeriesCharacterMatches(work, [
      character("char_a", "イント"),
    ]);

    expect(asked).toBe(false);
    expect(result).toEqual({ offered: 0, copied: 0 });
  });
});
