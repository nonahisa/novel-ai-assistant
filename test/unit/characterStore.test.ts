import { beforeEach, describe, expect, test } from "vitest";
import { CharacterStore } from "../../src/core/characterStore";
import { parseCharacter } from "../../src/models/character";
import { emptyCharacter } from "../../src/models/character";
import type { WorkEntry } from "../../src/models/types";
import { FileSystemError, FileType, workspace } from "./support/vscodeStub";

const work: WorkEntry = {
  id: "work_test",
  title: "作品",
  folderPath: "C:\\novels\\work",
  registeredAt: "2026-08-06T00:00:00.000Z",
};

describe("人物ファイル保存", () => {
  const operations: string[] = [];

  beforeEach(() => {
    operations.length = 0;
    workspace.fs = {
      createDirectory: async () => undefined,
      readFile: async () => {
        throw new FileSystemError("missing", "FileNotFound");
      },
      readDirectory: async () => [
        ["char_001_旧名.json", FileType.File],
      ] as Array<[string, FileType]>,
      writeFile: async (uri: { fsPath: string }) => {
        operations.push(`write:${uri.fsPath}`);
      },
      delete: async (uri: { fsPath: string }) => {
        operations.push(`delete:${uri.fsPath}`);
      },
    };
  });

  test("新しい人物ファイルの保存成功後に古い名前のファイルを削除する", async () => {
    const character = emptyCharacter("char_001", "新名");

    await new CharacterStore(work).save(character);

    expect(operations.map((operation) => operation.split(":", 1)[0])).toEqual([
      "write",
      "delete",
    ]);
  });

  test("人物ディレクトリが無い場合だけ空として扱う", async () => {
    workspace.fs.readDirectory = async () => {
      throw new FileSystemError("missing", "FileNotFound");
    };

    await expect(new CharacterStore(work).loadAll()).resolves.toEqual({
      characters: [],
      errors: [],
    });
  });

  test("人物ディレクトリの権限エラーを空データとして隠さない", async () => {
    workspace.fs.readDirectory = async () => {
      throw new FileSystemError("denied", "NoPermissions");
    };

    await expect(new CharacterStore(work).loadAll()).rejects.toThrow("denied");
    await expect(new CharacterStore(work).save(emptyCharacter("char_002", "灯")))
      .rejects.toThrow("denied");
  });

  test("不正な人物データを保存しない", async () => {
    const invalid = { ...emptyCharacter("char_003", "灯"), aliases: "あかり" };

    await expect(new CharacterStore(work).save(invalid as never)).rejects.toThrow(
      "aliases"
    );
    expect(operations).toEqual([]);
  });
});

describe("人物ファイル検証", () => {
  test("不正な配列と入れ子構造を拒否する", () => {
    const valid = emptyCharacter("char_001", "灯");
    const invalidValues: Array<[string, unknown]> = [
      ["aliases", "あかり"],
      ["physical", { age: 17, height: null }],
      ["firstPerson", { default: null, variants: "私" }],
      ["addressTerms", [{ targetName: "澪", forms: "澪さん", authorLocked: false }]],
      ["relations", [{ name: "澪", relation: 1 }]],
      ["appearedChapters", [1, "2"]],
      ["isMob", "true"],
      ["conflicts", [{ field: "age", values: "17", chapters: [1], note: null }]],
    ];

    for (const [field, value] of invalidValues) {
      expect(() => parseCharacter({ ...valid, [field]: value }), field).toThrow(field);
    }
  });

  test("欠損した任意項目は安全な既定値で補う", () => {
    const parsed = parseCharacter({ id: "char_001", name: "灯" });

    expect(parsed.aliases).toEqual([]);
    expect(parsed.physical).toBeNull();
    expect(parsed.firstPerson).toEqual({ default: null, variants: [] });
    expect(parsed.authorNotes).toBe("");
  });

  test("ファイル名へ使えない人物IDを拒否する", () => {
    expect(() => parseCharacter({ id: "../outside", name: "灯" })).toThrow("id");
  });

  test("同じIDの人物ファイルを二重に読み込まない", async () => {
    const encoded = new TextEncoder().encode(
      JSON.stringify(emptyCharacter("char_001", "灯"))
    );
    workspace.fs = {
      readDirectory: async () => [
        ["char_001_灯.json", FileType.File],
        ["char_001_旧名.json", FileType.File],
      ] as Array<[string, FileType]>,
      readFile: async (uri: { fsPath: string }) => {
        if (uri.fsPath.endsWith("config.json")) {
          throw new FileSystemError("missing", "FileNotFound");
        }
        return encoded;
      },
    };

    const loaded = await new CharacterStore(work).loadAll();

    expect(loaded.characters).toHaveLength(1);
    expect(loaded.errors).toEqual([
      expect.objectContaining({ file: "char_001_旧名.json", message: expect.stringContaining("重複") }),
    ]);
  });
});
