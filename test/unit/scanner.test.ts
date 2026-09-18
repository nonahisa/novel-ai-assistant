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

  test("設定フォルダの中は歩かない（メモは原稿ではない）", async () => {
    /*
      作品ごとのメモは `設定/メモ/題名.md` に置く（設計書6.71）。

      **メモが原稿として拾われると、話数・文字数・あらすじ・投稿・校正の
      すべてに紛れ込む。** 走査が `設定` を飛ばすことに乗っているので、
      その前提が崩れていないことをここで押さえる。
    */
    const readDirectory = vi.fn(async (uri: { fsPath: string }) => {
      if (uri.fsPath.endsWith("設定")) {
        return [["メモ", FileType.Directory]];
      }
      if (uri.fsPath.endsWith("メモ")) {
        return [["書き出しの案.md", FileType.File]];
      }
      return [
        ["001.txt", FileType.File],
        ["設定", FileType.Directory],
      ];
    });
    workspace.fs = {
      readFile: vi.fn(async (uri: { fsPath: string }) => {
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
    // そもそも中を覗きにいかない
    expect(
      readDirectory.mock.calls.map(([uri]) => uri.fsPath).join("|")
    ).not.toContain("設定");
  });

  test("カクヨムの about.txt は話に数えない（作者の実データ、2026-09-19）", async () => {
    /*
      カクヨムのバックアップをそのまま登録すると、`about.txt`
      （**作品情報**。題・キャッチコピー・紹介文・タグ）が1話として
      並び、その字数が作品の総字数に足されていた。

      **総字数が減るが、執筆量にはマイナスが残らない**——ファイル数も
      同時に減るので、`recordMeasurement` の「ファイルが増減した回は
      数えない」に乗る（`kakuyomuBackup.test.ts` で押さえている）。
    */
    const about = [
      "【タイトル】",
      "灯をたどる",
      "",
      "【キャッチコピー】",
      "その灯は、まだ消えていない。",
      "",
      "【紹介文（1行）】",
      "　夜の川べりを歩く話です。",
      "",
    ].join("\n");
    const readDirectory = vi.fn(async () => [
      ["about.txt", FileType.File],
      ["episode_0001.txt", FileType.File],
    ]);
    workspace.fs = {
      readFile: vi.fn(async (uri: { fsPath: string }) => {
        if (uri.fsPath.endsWith(".json")) {
          throw new FileSystemError("設定なし", "FileNotFound");
        }
        if (uri.fsPath.endsWith("about.txt")) {
          return new TextEncoder().encode(about);
        }
        return new TextEncoder().encode(
          "【タイトル】\n第1話　灯\n\n【本文（1行）】\n灯が歩いた。\n"
        );
      }),
      stat: vi.fn(async () => {
        throw new FileSystemError("本文なし", "FileNotFound");
      }),
      readDirectory,
    };

    const result = await scanWork(work);

    expect(result.episodes.map((episode) => episode.fileName)).toEqual([
      "episode_0001.txt",
    ]);
    expect(result.stats.fileCount).toBe(1);
    // 紹介文もキャッチコピーも作品の字数に入らない
    expect(result.stats.totals.net).toBe("灯が歩いた。".length);
    // **落としたことは返す**（画面に出すかは使う側の判断）
    expect(result.workInfoFiles).toHaveLength(1);
    expect(result.workInfoFiles[0].endsWith("about.txt")).toBe(true);
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
