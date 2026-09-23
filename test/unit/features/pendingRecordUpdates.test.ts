import * as path from "path";
import { beforeEach, describe, expect, test } from "vitest";
import {
  recordUpdateViewItems,
  reviewPendingCharacterUpdates,
} from "../../src/features/applyPendingUpdates";
import { emptyCharacter, type Character } from "../../src/models/character";
import type { WorkEntry } from "../../src/models/types";
import { FileSystemError, FileType, Uri, workspace } from "./support/vscodeStub";

/**
 * 提案パネルを開いただけでは、溜まっている承認待ちが出なかった
 * （実機、2026-09-11）。ツリーの印は「未反映の更新 37件」と言うのに、
 * パネルは「誤字脱字 0件／まだ検知結果がありません」と出ていた。
 *
 * 原因は、承認待ちを読んで表示用に組み立てる処理が
 * 「更新分を反映」の中にしか無かったこと。切り出して、開いたときにも
 * 同じものを通すようにした。**ここでは切り出した側だけを確かめる。**
 */

const work: WorkEntry = {
  id: "work_test",
  title: "作品",
  folderPath: ["C:", "novels", "work"].join(path.sep),
  registeredAt: "2026-08-06T00:00:00.000Z",
};

const characterDir = Uri.file(
  path.join(work.folderPath, "設定", "characters")
).fsPath;
const pendingDir = Uri.file(
  path.join(work.folderPath, ".aiwriter", "pending-characters")
).fsPath;

const disk = new Map<string, Uint8Array>();

function put(dir: string, name: string, body: unknown): void {
  disk.set(
    Uri.file(path.join(dir, name)).fsPath,
    new TextEncoder().encode(`${JSON.stringify(body, null, 2)}\n`)
  );
}

/** 連番の人物。`char_001` から数えて `count` 人 */
function seedCharacters(count: number): Character[] {
  const characters: Character[] = [];
  for (let index = 1; index <= count; index++) {
    const id = `char_${String(index).padStart(3, "0")}`;
    const character: Character = {
      ...emptyCharacter(id, `人物${index}`),
      summary: "もとの紹介",
      updatedAt: "2026-08-06T00:00:00.000Z",
    };
    characters.push(character);
    put(characterDir, `${id}_人物${index}.json`, character);
  }
  return characters;
}

beforeEach(() => {
  disk.clear();
  workspace.textDocuments = [];
  workspace.fs = {
    createDirectory: async () => {},
    readFile: async (uri: { fsPath: string }) => {
      const bytes = disk.get(uri.fsPath);
      if (!bytes) throw new FileSystemError("missing", "FileNotFound");
      return bytes;
    },
    readDirectory: async (uri: { fsPath: string }) => {
      const entries = [...disk.keys()].filter(
        (filePath) => path.dirname(filePath) === uri.fsPath
      );
      if (entries.length === 0 && uri.fsPath !== characterDir) {
        throw new FileSystemError("missing", "FileNotFound");
      }
      return entries.map(
        (filePath) =>
          [path.basename(filePath), FileType.File] as [string, FileType]
      );
    },
    writeFile: async (uri: { fsPath: string }, bytes: Uint8Array) => {
      disk.set(uri.fsPath, bytes);
    },
    rename: async () => {},
    delete: async (uri: { fsPath: string }) => {
      disk.delete(uri.fsPath);
    },
  };
});

describe("溜まっている承認待ちの組み立て", () => {
  test("16件の更新案から16件の項目を組む", async () => {
    const characters = seedCharacters(16);
    for (const character of characters) {
      put(pendingDir, `${character.id}.json`, {
        ...character,
        summary: `${character.name}の新しい紹介`,
      });
    }

    const review = await reviewPendingCharacterUpdates(work);

    expect(review.totalPending).toBe(16);
    expect(review.items).toHaveLength(16);
    expect(review.stale).toEqual([]);
    expect(review.pendingErrors).toEqual([]);
    expect(review.characterErrors).toEqual([]);

    const view = recordUpdateViewItems(review);
    expect(view).toHaveLength(16);
    // 画面は人物ごとにまとまる。id は保留ファイルのパス（反映するときの鍵）
    expect(view.map((entry) => entry.name)).toEqual(
      characters.map((character) => character.name)
    );
    expect(view.every((entry) => entry.status === "pending")).toBe(true);
    expect(view.every((entry) => entry.changes.length > 0)).toBe(true);
    expect(new Set(view.map((entry) => entry.id)).size).toBe(16);
  });

  test("読むだけで、承認待ちのファイルは片付けない", async () => {
    seedCharacters(2);
    // 対象の居ない更新案（まとめた・削除した人物のもの）
    put(pendingDir, "char_900.json", {
      ...emptyCharacter("char_900", "居ない人"),
      summary: "新しい紹介",
    });
    const before = [...disk.keys()].length;

    const review = await reviewPendingCharacterUpdates(work);

    expect(review.items).toEqual([]);
    expect(review.stale).toHaveLength(1);
    // **開いただけでファイルを消さない。** 片付けるかは呼び出し側が決める
    expect([...disk.keys()]).toHaveLength(before);
  });

  test("承認待ちが無ければ、人物設定も読まない（開いたときの空振りを軽くする）", async () => {
    seedCharacters(3);
    const review = await reviewPendingCharacterUpdates(work);

    expect(review.totalPending).toBe(0);
    expect(review.items).toEqual([]);
    // 差分の相手を読んでいないので、顔ぶれも空のまま
    expect(review.known).toEqual([]);
  });

  test("人物設定が読めないときは組み立てない（差分の相手が欠ける）", async () => {
    seedCharacters(1);
    put(characterDir, "char_991_外から足した人.json", {
      id: "char_991_外から足した人",
      name: "外から足した人",
    });
    put(pendingDir, "char_001.json", {
      ...emptyCharacter("char_001", "人物1"),
      summary: "新しい紹介",
    });

    const review = await reviewPendingCharacterUpdates(work);

    expect(review.characterErrors).toHaveLength(1);
    expect(review.items).toEqual([]);
  });

  test("差分の無い更新案は、確認に出さず片付け候補にする", async () => {
    const characters = seedCharacters(2);
    // 中身が同じ＝反映しても何も変わらない
    put(pendingDir, "char_001.json", characters[0]);
    put(pendingDir, "char_002.json", {
      ...characters[1],
      summary: "変わった紹介",
    });

    const review = await reviewPendingCharacterUpdates(work);

    expect(review.items).toHaveLength(1);
    expect(review.stale).toHaveLength(1);
    expect(recordUpdateViewItems(review)).toHaveLength(1);
  });
});
