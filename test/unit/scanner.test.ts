import { beforeEach, describe, expect, test, vi } from "vitest";
import { FileSystemError, FileType, Uri, workspace } from "./support/vscodeStub";
import { scanWork } from "../../src/core/scanner";
import type { WorkEntry } from "../../src/models/types";

const work: WorkEntry = {
  id: "work_test",
  title: "作品",
  folderPath: "C:\\novels\\work",
  registeredAt: "2026-08-06T00:00:00.000Z",
};

describe("本文フォルダの選択", () => {
  beforeEach(() => {
    workspace.getConfiguration = () => ({
      get: <T>(_key: string, defaultValue: T): T => defaultValue,
    });
  });

  test("本文フォルダがFileNotFoundのときだけ作品ルートへフォールバックする", async () => {
    const readDirectory = vi.fn(async () => []);
    workspace.fs = {
      readFile: vi.fn(async () => {
        throw new FileSystemError("設定なし", "FileNotFound");
      }),
      stat: vi.fn(async () => {
        throw new FileSystemError("本文なし", "FileNotFound");
      }),
      readDirectory,
    };

    const result = await scanWork(work);

    expect(result.manuscriptDir).toBe(work.folderPath);
    expect(readDirectory).toHaveBeenCalledWith(Uri.file(work.folderPath));
  });

  test("競合の退避ファイルは原稿として拾わない", async () => {
    // 「両方を残す」で作る `001.conflict-origin_main.txt` は、
    // 別環境の版の写しであって原稿ではない。同じ話数が付いた本文が
    // 2つある状態になるので、拾うと文字数が二重に数えられ、
    // AIにも同じ話を2回送る（クラウドAIならそのまま料金になる）
    const readDirectory = vi.fn(async () => [
      ["001.txt", FileType.File],
      ["001.conflict-origin_main.txt", FileType.File],
    ]);
    workspace.fs = {
      readFile: vi.fn(async (uri: { fsPath: string }) => {
        // 作品設定は無い状態にする。本文だけを読ませたい
        if (uri.fsPath.endsWith(".json")) {
          throw new FileSystemError("設定なし", "FileNotFound");
        }
        return new TextEncoder().encode("灯が歩いた。");
      }),
      stat: vi.fn(async () => {
        throw new FileSystemError("本文なし", "FileNotFound");
      }),
      readDirectory,
    };

    const result = await scanWork(work);

    expect(result.episodes.map((episode) => episode.fileName)).toEqual([
      "001.txt",
    ]);
  });

  test.each(["NoPermissions", "Unknown"])(
    "本文フォルダのstatが%sなら作品ルートへフォールバックせず伝播する",
    async (code) => {
      const error = new FileSystemError("本文を確認できません", code);
      const readDirectory = vi.fn(async () => []);
      workspace.fs = {
        readFile: vi.fn(async () => {
          throw new FileSystemError("設定なし", "FileNotFound");
        }),
        stat: vi.fn(async () => {
          throw error;
        }),
        readDirectory,
      };

      await expect(scanWork(work)).rejects.toBe(error);
      expect(readDirectory).not.toHaveBeenCalled();
    }
  );
});
