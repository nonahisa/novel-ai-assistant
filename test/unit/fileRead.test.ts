import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  fileReader,
  isNotFound,
  setFileReaderForTests,
  vscodeFileReaderForTests,
} from "../../src/core/fileRead";
import { FileSystemError, FileType, Uri, workspace } from "./support/vscodeStub";
import * as runtime from "../../src/core/runtime";

/**
 * 読むだけの口（`core/fileRead.ts`。設計書6.107）。
 *
 * **確かめるのは2つの経路が同じ形を返すこと。** 手元では Node の `fs`、
 * ブラウザ版では `vscode.workspace.fs` を通るので、片方しか見ないと
 * 「実機でだけ落ちる」を作る（この作品で繰り返し起きた失敗1）。
 */

/**
 * 試験の下ごしらえ（`support/setup.ts`）が代役を差し込んでいるので、
 * **製品の選び方を見るテストは自分で外す。** 外したままにすると
 * 後続のテストが本物のディスクを読み始めるので、必ず戻す。
 */
afterEach(() => {
  setFileReaderForTests(vscodeFileReaderForTests());
  vi.restoreAllMocks();
});

describe("Node の `fs` で読む側（手元の VS Code）", () => {
  test("読み込み・有無の確認・一覧が、一時フォルダーで動く", async () => {
    const root = await mkdtemp(join(tmpdir(), "novelai-fileread-"));
    try {
      await writeFile(join(root, "001.txt"), "灯が歩いた。", "utf8");
      await mkdir(join(root, "下書き"));

      setFileReaderForTests(undefined);
      const reader = await fileReader();

      const bytes = await reader.readFile(join(root, "001.txt"));
      expect(new TextDecoder().decode(bytes)).toBe("灯が歩いた。");

      const stat = await reader.stat(join(root, "001.txt"));
      expect(stat.type).toBe("file");
      // 日本語6文字はUTF-8で18バイト。**バイト数であることを固定する**
      expect(stat.size).toBe(18);
      expect(stat.mtime).toBeGreaterThan(0);

      expect((await reader.stat(root)).type).toBe("directory");

      const entries = await reader.readDirectory(root);
      expect([...entries].sort()).toEqual([
        ["001.txt", "file"],
        ["下書き", "directory"],
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("無いファイルは `isNotFound` が真になる", async () => {
    const root = await mkdtemp(join(tmpdir(), "novelai-fileread-"));
    try {
      setFileReaderForTests(undefined);
      const reader = await fileReader();
      // **投げること自体も確かめる。** 黙って空を返す実装にすると、
      // 「まだ無い」と「空だった」が区別できなくなる
      const error = await reader
        .readFile(join(root, "ありません.txt"))
        .then(() => undefined)
        .catch((caught: unknown) => caught);
      expect(error).toBeDefined();
      expect(isNotFound(error)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("URI の場所は、手元でも `vscode.workspace.fs` へ回る", async () => {
    // 手元の VS Code で `vscode-vfs://github/...` を開いている場合
    // （設計書5.8）。Node の `fs` はこれを読めない
    const readFile = vi.fn(async () => new TextEncoder().encode("遠くの本文"));
    workspace.fs = { readFile };

    setFileReaderForTests(undefined);
    const reader = await fileReader();
    const bytes = await reader.readFile("vscode-vfs://github/nonahisa/x/001.txt");

    expect(new TextDecoder().decode(bytes)).toBe("遠くの本文");
    expect(readFile).toHaveBeenCalledWith(
      Uri.parse("vscode-vfs://github/nonahisa/x/001.txt")
    );
  });
});

describe("`vscode.workspace.fs` で読む側（ブラウザ版）", () => {
  test("`canRunProcesses()` が偽なら代役が呼ばれ、形はそろっている", async () => {
    vi.spyOn(runtime, "canRunProcesses").mockReturnValue(false);

    const readFile = vi.fn(async () => new TextEncoder().encode("本文"));
    const stat = vi.fn(async () => ({
      type: FileType.Directory,
      size: 0,
      mtime: 1234,
    }));
    const readDirectory = vi.fn(async () => [
      ["001.txt", FileType.File],
      ["下書き", FileType.Directory],
    ]);
    workspace.fs = { readFile, stat, readDirectory };

    setFileReaderForTests(undefined);
    const reader = await fileReader();

    expect(new TextDecoder().decode(await reader.readFile("C:/w/001.txt"))).toBe(
      "本文"
    );
    expect(readFile).toHaveBeenCalledWith(Uri.file("C:/w/001.txt"));

    // 数の並びではなく、読める名前へ写っていること
    expect(await reader.stat("C:/w")).toEqual({
      type: "directory",
      size: 0,
      mtime: 1234,
    });
    expect(await reader.readDirectory("C:/w")).toEqual([
      ["001.txt", "file"],
      ["下書き", "directory"],
    ]);
  });

  test("`FileNotFound` も `isNotFound` が真になる", () => {
    expect(isNotFound(new FileSystemError("ありません", "FileNotFound"))).toBe(
      true
    );
    // **他の失敗を「無い」に丸めない。** 権限や一時障害を「無い」と読むと、
    // 無いものを作りにいって空のフォルダーを生む（2026-09-19 に起きた形）
    expect(isNotFound(new FileSystemError("権限がありません", "NoPermissions"))).toBe(
      false
    );
    expect(isNotFound(new Error("何か"))).toBe(false);
    expect(isNotFound(undefined)).toBe(false);
  });
});
