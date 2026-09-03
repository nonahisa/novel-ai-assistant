import * as path from "path";
import { beforeEach, describe, expect, test } from "vitest";
import { FileSystemError, FileType, Uri, window, workspace } from "./support/vscodeStub";
import type { EpisodeFile, WorkEntry } from "../../src/models/types";
import { emptyCounts } from "../../src/core/charCount";
import { insertEpisodeBefore } from "../../src/features/insertEpisode";
import { removeEpisodeAndRenumber } from "../../src/features/removeEpisode";

/**
 * 話の挿入と削除（設計書6.67.4）。
 *
 * **Git系の確認は範囲外。** `insertEpisodeBefore`／`removeEpisodeAndRenumber`
 * は名前だけの独立コミットを訊く前に `core/git.ts`（`node:child_process`）を
 * 実際に呼ぶ。ここで使う作品フォルダ（`C:\novels\work`）は実在しないので、
 * `git rev-parse` は失敗して「リポジトリではない」に落ち、コミットの確認
 * ダイアログは出ない——追加のモックを要らずに済ませられる。
 */

const work: WorkEntry = {
  id: "work_test",
  title: "氷の街",
  folderPath: path.join("C:", "novels", "work"),
  registeredAt: "2026-09-03T00:00:00.000Z",
};

function diskPath(...parts: string[]): string {
  return Uri.file(path.join(work.folderPath, ...parts)).fsPath;
}

function episode(
  fileName: string,
  overrides: Partial<EpisodeFile> = {}
): EpisodeFile {
  const numberMatch = /^(\d+)\.txt$/.exec(fileName);
  const chapter = numberMatch ? parseInt(numberMatch[1], 10) : null;
  return {
    filePath: diskPath("本文", fileName),
    fileName,
    ext: ".txt",
    chapterStart: chapter,
    chapterEnd: chapter,
    subtitle: null,
    kind: "本編",
    isInitialName: true,
    counts: emptyCounts(),
    hasMetadata: false,
    metaTitle: null,
    declaredCharCount: null,
    metaUpdatedAt: null,
    hasConflictMarkers: false,
    collectedCount: null,
    ...overrides,
  };
}

describe("話の挿入・削除", () => {
  const disk = new Map<string, Uint8Array>();

  beforeEach(() => {
    disk.clear();
    workspace.textDocuments = [];
    workspace.fs = {
      createDirectory: async () => undefined,
      readFile: async (uri: { fsPath: string }) => {
        const bytes = disk.get(uri.fsPath);
        if (!bytes) throw new FileSystemError("missing", "FileNotFound");
        return bytes;
      },
      readDirectory: async (uri: { fsPath: string }) => {
        return [...disk.keys()]
          .filter((filePath) => path.dirname(filePath) === uri.fsPath)
          .map(
            (filePath) =>
              [path.basename(filePath), FileType.File] as [string, FileType]
          );
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
      delete: async (uri: { fsPath: string }) => {
        disk.delete(uri.fsPath);
      },
      stat: async (uri: { fsPath: string }) => {
        if (!disk.has(uri.fsPath)) {
          throw new FileSystemError("missing", "FileNotFound");
        }
        return { type: 1, ctime: 0, mtime: 0, size: 0 };
      },
    } as unknown as typeof workspace.fs;

    for (const name of ["001.txt", "002.txt", "003.txt", "004.txt", "005.txt"]) {
      disk.set(diskPath("本文", name), new TextEncoder().encode(""));
    }

    // 既定は「確認ダイアログでは何も押さなかった」。各テストで上書きする
    window.showWarningMessage = async () => undefined;
    window.showErrorMessage = async () => undefined;
    window.showInformationMessage = async () => undefined;
    window.showInputBox = async (options?: { value?: string }) => options?.value;
  });

  test("挿入：確認の文言に、動かす件数が入る", async () => {
    let seenMessage = "";
    window.showWarningMessage = async (message: string) => {
      seenMessage = message;
      return "付け替える";
    };
    const episodes = [1, 2, 3, 4, 5].map((n) =>
      episode(`${String(n).padStart(3, "0")}.txt`)
    );

    await insertEpisodeBefore(work, episode("003.txt"), episodes);

    // 第3話の前に挿すと、3〜5話目（3件）が後ろへずれる
    expect(seenMessage).toContain("第3話以降");
    expect(seenMessage).toContain("3件");
  });

  test("挿入：付け替えたあと、指定した番号の位置に空のファイルができる", async () => {
    window.showWarningMessage = async () => "付け替える";
    window.showInputBox = async () => "003.txt";
    const episodes = [1, 2, 3, 4, 5].map((n) =>
      episode(`${String(n).padStart(3, "0")}.txt`)
    );

    const result = await insertEpisodeBefore(work, episode("003.txt"), episodes);

    expect(result.changed).toBe(true);
    expect(disk.has(diskPath("本文", "003.txt"))).toBe(true); // 新規の空ファイル
    expect(disk.has(diskPath("本文", "006.txt"))).toBe(true); // 元の005が繰り上がった
    expect(disk.has(diskPath("本文", "004.txt"))).toBe(true); // 元の003が繰り下がった
  });

  test("削除：確認の文言に、詰める件数が入る", async () => {
    let seenMessage = "";
    window.showWarningMessage = async (message: string) => {
      seenMessage = message;
      return "削除する";
    };
    const episodes = [1, 2, 3, 4, 5].map((n) =>
      episode(`${String(n).padStart(3, "0")}.txt`)
    );

    await removeEpisodeAndRenumber(work, episode("003.txt"), episodes);

    expect(seenMessage).toContain("第3話以降");
    expect(seenMessage).toContain("2件");
  });

  test("削除：本文はゴミ箱経由で消え、後ろが詰まる", async () => {
    window.showWarningMessage = async () => "削除する";
    const deleted: Array<{ path: string; useTrash?: boolean }> = [];
    const originalDelete = workspace.fs.delete;
    workspace.fs.delete = async (
      uri: { fsPath: string },
      options?: { useTrash?: boolean }
    ) => {
      deleted.push({ path: uri.fsPath, useTrash: options?.useTrash });
      return originalDelete(uri as never);
    };
    const episodes = [1, 2, 3, 4, 5].map((n) =>
      episode(`${String(n).padStart(3, "0")}.txt`)
    );

    const result = await removeEpisodeAndRenumber(
      work,
      episode("003.txt"),
      episodes
    );

    expect(result.changed).toBe(true);
    expect(deleted).toHaveLength(1);
    expect(deleted[0].path).toBe(diskPath("本文", "003.txt"));
    expect(deleted[0].useTrash).toBe(true);
    // 004→003, 005→004 と詰まる
    expect(disk.has(diskPath("本文", "003.txt"))).toBe(true);
    expect(disk.has(diskPath("本文", "004.txt"))).toBe(true);
    expect(disk.has(diskPath("本文", "005.txt"))).toBe(false);
  });

  test("挿入：競合マーカーが範囲に含まれると、確認すら出さずに断る", async () => {
    let asked = false;
    window.showWarningMessage = async () => {
      asked = true;
      return "付け替える";
    };
    let errorMessage = "";
    window.showErrorMessage = async (message: string) => {
      errorMessage = message;
      return undefined;
    };
    const episodes = [
      episode("001.txt"),
      episode("002.txt"),
      episode("003.txt"),
      episode("004.txt", { hasConflictMarkers: true }),
      episode("005.txt"),
    ];

    const result = await insertEpisodeBefore(work, episode("003.txt"), episodes);

    expect(result.changed).toBe(false);
    expect(asked).toBe(false);
    expect(errorMessage).toContain("競合");
    expect(errorMessage).toContain("004.txt");
    // 何も動いていない
    expect(disk.has(diskPath("本文", "005.txt"))).toBe(true);
    expect(disk.has(diskPath("本文", "006.txt"))).toBe(false);
  });

  test("削除：削除する話自身の競合マーカーでも断る", async () => {
    let asked = false;
    window.showWarningMessage = async () => {
      asked = true;
      return "削除する";
    };
    const episodes = [1, 2, 3].map((n) =>
      episode(`${String(n).padStart(3, "0")}.txt`)
    );
    const target = episode("002.txt", { hasConflictMarkers: true });

    const result = await removeEpisodeAndRenumber(work, target, [
      episodes[0],
      target,
      episodes[2],
    ]);

    expect(result.changed).toBe(false);
    expect(asked).toBe(false);
    expect(disk.has(diskPath("本文", "002.txt"))).toBe(true); // 消えていない
  });
});
