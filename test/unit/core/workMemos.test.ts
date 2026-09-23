import * as path from "path";
import { beforeEach, describe, expect, test } from "vitest";
import {
  createWorkMemo,
  deleteWorkMemo,
  listWorkMemos,
  memoDirectoryOf,
  transferMemoToWork,
  WorkMemoError,
} from "../../src/core/workMemos";
import type { WorkEntry } from "../../src/models/types";
import { FileSystemError, FileType, Uri, workspace } from "./support/vscodeStub";

/**
 * 作品ごとのメモと、創作メモ集からの移管（設計書6.71）。
 *
 * ここで守るのは3つ。
 *
 * 1. **メモは1メモ1ファイル（.md）**。だから移管が「ファイルの移動」で済む
 * 2. **既存のメモを上書きしない**（同じ題名は断る／移管では連番の別名にする）
 * 3. **作品の外は指せない**——移管は作品フォルダの中だけで完結する
 */

const memoWork: WorkEntry = {
  id: "work_memo",
  title: "創作メモ集",
  folderPath: path.join("C:", "novels", "memos"),
  registeredAt: "2026-09-04T00:00:00.000Z",
};

const novelWork: WorkEntry = {
  id: "work_novel",
  title: "氷の街",
  folderPath: path.join("C:", "novels", "ice"),
  registeredAt: "2026-09-04T00:00:00.000Z",
};

/**
 * 作り物のディスクの鍵。
 *
 * **`Uri.file` を通した形にする。** 本物のVS Codeと同じく、ドライブ文字の
 * 大文字小文字が揃った形でファイルシステムへ届くためである
 * （持ち回る文字列のほうは、書いたときの形のまま）。
 */
function diskPath(filePath: string): string {
  return Uri.file(filePath).fsPath;
}

/** メモの置き場の中の1件（持ち回る形の場所） */
function memoPath(work: WorkEntry, fileName: string): string {
  return path.join(work.folderPath, "設定", "メモ", fileName);
}

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

describe("作品ごとのメモ", () => {
  const disk = new Map<string, Uint8Array>();
  const directories = new Set<string>();
  const trashed: string[] = [];

  beforeEach(() => {
    disk.clear();
    directories.clear();
    trashed.length = 0;
    workspace.textDocuments = [];
    workspace.fs = {
      createDirectory: async (uri: { fsPath: string }) => {
        directories.add(uri.fsPath);
      },
      readDirectory: async (uri: { fsPath: string }) => {
        const prefix = `${uri.fsPath}${path.sep}`;
        if (!directories.has(uri.fsPath)) {
          throw new FileSystemError("missing", "FileNotFound");
        }
        return [...disk.keys()]
          .filter((filePath) => filePath.startsWith(prefix))
          .map((filePath) => [filePath.slice(prefix.length), FileType.File]);
      },
      readFile: async (uri: { fsPath: string }) => {
        const bytes = disk.get(uri.fsPath);
        if (!bytes) throw new FileSystemError("missing", "FileNotFound");
        return bytes;
      },
      writeFile: async (uri: { fsPath: string }, bytes: Uint8Array) => {
        disk.set(uri.fsPath, bytes);
      },
      rename: async (
        from: { fsPath: string },
        to: { fsPath: string },
        options?: { overwrite?: boolean }
      ) => {
        const bytes = disk.get(from.fsPath);
        if (!bytes) throw new FileSystemError("missing", "FileNotFound");
        if (!options?.overwrite && disk.has(to.fsPath)) {
          throw new FileSystemError("exists", "FileExists");
        }
        disk.set(to.fsPath, bytes);
        disk.delete(from.fsPath);
      },
      delete: async (
        uri: { fsPath: string },
        options?: { useTrash?: boolean }
      ) => {
        if (options?.useTrash) trashed.push(uri.fsPath);
        disk.delete(uri.fsPath);
      },
      stat: async (uri: { fsPath: string }) => {
        if (!disk.has(uri.fsPath)) {
          throw new FileSystemError("missing", "FileNotFound");
        }
        return { type: 1, ctime: 0, mtime: 0, size: 0 };
      },
    } as unknown as typeof workspace.fs;
  });

  /** メモの置き場に、そのファイルを置いた状態にする */
  function putMemo(work: WorkEntry, fileName: string, body = ""): string {
    directories.add(diskPath(path.join(work.folderPath, "設定", "メモ")));
    const filePath = memoPath(work, fileName);
    disk.set(diskPath(filePath), utf8(body));
    return filePath;
  }

  /** そこにあるか／中身は何か（持ち回る形の場所で訊く） */
  function stored(filePath: string): boolean {
    return disk.has(diskPath(filePath));
  }

  function read(filePath: string): string | undefined {
    const bytes = disk.get(diskPath(filePath));
    return bytes && new TextDecoder().decode(bytes);
  }

  describe("一覧", () => {
    test("置き場が無ければ、メモは無い（枝を出さないため）", async () => {
      expect(await listWorkMemos(novelWork)).toEqual([]);
    });

    test(".md だけを拾い、題名はファイル名から作る", async () => {
      putMemo(novelWork, "書き出しの案.md");
      putMemo(novelWork, "覚え書き.txt");
      putMemo(novelWork, "写真.png");

      const memos = await listWorkMemos(novelWork);
      expect(memos.map((memo) => memo.title)).toEqual(["書き出しの案"]);
      expect(memos[0].fileName).toBe("書き出しの案.md");
      expect(memos[0].filePath).toBe(memoPath(novelWork, "書き出しの案.md"));
    });

    test("題名の順に並ぶ", async () => {
      putMemo(novelWork, "ろ.md");
      putMemo(novelWork, "い.md");
      putMemo(novelWork, "は.md");

      expect((await listWorkMemos(novelWork)).map((memo) => memo.title)).toEqual(
        ["い", "は", "ろ"]
      );
    });

    test("置き場は 設定/メモ/（作品設定の設定フォルダに従う）", async () => {
      expect(await memoDirectoryOf(novelWork)).toBe(
        path.join(novelWork.folderPath, "設定", "メモ")
      );
    });
  });

  describe("追加", () => {
    test("空の .md を作る（中身は作者が書く）", async () => {
      const memo = await createWorkMemo(novelWork, "書き出しの案");

      expect(memo.fileName).toBe("書き出しの案.md");
      expect(read(memoPath(novelWork, "書き出しの案.md"))).toBe("");
      expect((await listWorkMemos(novelWork)).map((m) => m.title)).toEqual([
        "書き出しの案",
      ]);
    });

    test("ファイル名に使えない記号は全角へ落とす", async () => {
      const memo = await createWorkMemo(novelWork, "主人公:謎/伏線");
      expect(memo.fileName).toBe("主人公：謎／伏線.md");
    });

    test("同じ題名のメモは断る（上書きしない）", async () => {
      const existing = putMemo(novelWork, "書き出しの案.md", "作者が書いた中身");

      await expect(
        createWorkMemo(novelWork, "書き出しの案")
      ).rejects.toMatchObject({ kind: "duplicate" });
      expect(read(existing)).toBe("作者が書いた中身");
    });

    test("題名が空なら断る", async () => {
      await expect(createWorkMemo(novelWork, "   ")).rejects.toBeInstanceOf(
        WorkMemoError
      );
    });
  });

  describe("削除", () => {
    test("ごみ箱へ入れる（元に戻せる）", async () => {
      const filePath = putMemo(novelWork, "消すメモ.md");
      const [memo] = await listWorkMemos(novelWork);

      await deleteWorkMemo(novelWork, memo);

      expect(trashed).toEqual([diskPath(filePath)]);
      expect(stored(filePath)).toBe(false);
    });

    test("作品の中でも、メモの置き場の外なら消さない（原稿を守る）", async () => {
      const manuscript = path.join(novelWork.folderPath, "本文", "001.txt");
      disk.set(diskPath(manuscript), utf8("本文"));

      await expect(
        deleteWorkMemo(novelWork, {
          title: "001",
          fileName: "001.txt",
          filePath: manuscript,
        })
      ).rejects.toMatchObject({ kind: "outside_work" });
      expect(stored(manuscript)).toBe(true);
    });

    test("作品の外のファイルは消さない", async () => {
      const outside = path.join("C:", "novels", "よそ.md");
      disk.set(diskPath(outside), utf8("よそのファイル"));

      await expect(
        deleteWorkMemo(novelWork, {
          title: "よそ",
          fileName: "よそ.md",
          filePath: outside,
        })
      ).rejects.toMatchObject({ kind: "outside_work" });
      expect(stored(outside)).toBe(true);
    });
  });

  describe("移管", () => {
    /** 創作メモ集の「話」ファイル（本文フォルダに置かれている） */
    function putEpisode(fileName: string, body = "メモの中身"): string {
      const filePath = path.join(memoWork.folderPath, "本文", fileName);
      disk.set(diskPath(filePath), utf8(body));
      return filePath;
    }

    test("移す先の 設定/メモ/ へ移動する（元は残らない）", async () => {
      const source = putEpisode("旅の途中.md");

      const result = await transferMemoToWork(memoWork, source, novelWork);

      expect(stored(source)).toBe(false);
      expect(result.renamed).toBe(false);
      expect(result.memo.filePath).toBe(memoPath(novelWork, "旅の途中.md"));
      expect(read(result.memo.filePath)).toBe("メモの中身");
      // 元の作品からの相対パス。台帳の孤児を報せるのに使う
      expect(result.fromPath).toBe("本文/旅の途中.md");
    });

    test("移す先に同じ題名があれば、連番の別名にする（上書きしない）", async () => {
      const kept = putMemo(novelWork, "旅の途中.md", "先にあったメモ");
      const source = putEpisode("旅の途中.md", "移してきたメモ");

      const result = await transferMemoToWork(memoWork, source, novelWork);

      expect(result.renamed).toBe(true);
      expect(result.memo.fileName).toBe("旅の途中-2.md");
      expect(read(kept)).toBe("先にあったメモ");
      expect(read(result.memo.filePath)).toBe("移してきたメモ");
    });

    test("移す元が作品の外なら断る", async () => {
      const outside = path.join("C:", "novels", "よそ.md");
      disk.set(diskPath(outside), utf8("よそのファイル"));

      await expect(
        transferMemoToWork(memoWork, outside, novelWork)
      ).rejects.toMatchObject({ kind: "outside_work" });
      expect(stored(outside)).toBe(true);
    });

    test("同じ作品へは移さない", async () => {
      const source = putEpisode("旅の途中.md");

      await expect(
        transferMemoToWork(memoWork, source, memoWork)
      ).rejects.toMatchObject({ kind: "same_work" });
      expect(stored(source)).toBe(true);
    });

    test("拡張子が .md でないメモも、移した先では .md にする", async () => {
      // 一覧は .md しか拾わない。そのまま移すと、移した先で見えなくなる
      const source = putEpisode("覚え書き.txt", "中身はそのまま");

      const result = await transferMemoToWork(memoWork, source, novelWork);

      expect(result.memo.fileName).toBe("覚え書き.md");
      expect(read(result.memo.filePath)).toBe("中身はそのまま");
    });
  });
});
