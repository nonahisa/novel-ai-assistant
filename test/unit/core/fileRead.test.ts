import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  fileReader,
  isNotFound,
  readerKind,
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

  test("一括読み（`readTextTree`）が、選んだ本文だけを名前順に返す", async () => {
    /*
      **`await` の回数を減らすための口**（設計書6.107）。走査は576ファイルを
      1つずつ読んでいたので、混んだ拡張機能ホストでは戻るたびに待たされた。

      ここで見張るのは**歩き方の規則**——`.` で始まる名前を飛ばす／
      呼び手の `accept` で絞る／名前順／入れ子の中も拾う。
    */
    const root = await mkdtemp(join(tmpdir(), "novelai-tree-"));
    try {
      await writeFile(join(root, "002.txt"), "夜が明けた。", "utf8");
      await writeFile(join(root, "001.txt"), "灯が歩いた。", "utf8");
      // 呼び手が要らないと言う拡張子
      await writeFile(join(root, "メモ.log"), "ログ", "utf8");
      // `.` で始まる名前は読み口の側で落ちる
      await writeFile(join(root, ".下書き.txt"), "隠し", "utf8");
      await mkdir(join(root, ".git"));
      await writeFile(join(root, ".git", "config.txt"), "git", "utf8");
      await mkdir(join(root, "第1章"));
      await writeFile(join(root, "第1章", "003.md"), "川を渡った。", "utf8");
      // 呼び手が「中へ入らない」と言うフォルダー
      await mkdir(join(root, "設定"));
      await writeFile(join(root, "設定", "人物.txt"), "灯", "utf8");

      setFileReaderForTests(undefined);
      const reader = await fileReader();

      const files = await reader.readTextTree(root, (name, kind) =>
        kind === "directory" ? name !== "設定" : /\.(txt|md)$/.test(name)
      );

      expect(files.map((file) => file.path)).toEqual([
        join(root, "001.txt"),
        join(root, "002.txt"),
        join(root, "第1章", "003.md"),
      ]);
      expect(new TextDecoder().decode(files[0].bytes)).toBe("灯が歩いた。");
      expect(new TextDecoder().decode(files[2].bytes)).toBe("川を渡った。");
      // 読めたものに印は付かない
      expect(files.every((file) => file.unreadable !== true)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("一括読みは、深さの上限より下へ潜らない", async () => {
    // 想定外の深い階層で無限に走査しないため（走査が元から持っていた上限）
    const root = await mkdtemp(join(tmpdir(), "novelai-tree-"));
    try {
      await mkdir(join(root, "a"));
      await mkdir(join(root, "a", "b"));
      await writeFile(join(root, "a", "001.txt"), "浅い", "utf8");
      await writeFile(join(root, "a", "b", "002.txt"), "深い", "utf8");

      setFileReaderForTests(undefined);
      const reader = await fileReader();

      const files = await reader.readTextTree(root, () => true, 1);

      expect(files.map((file) => file.path)).toEqual([
        join(root, "a", "001.txt"),
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

  test("一括読みも、Node 側と同じ形・同じ順で返す", async () => {
    /*
      **ブラウザ版だけ別の並びになると、実機でだけ違う一覧が出る**
      （この作品で繰り返し起きた失敗1）。`node:fs` が無いので中は
      今までどおり非同期だが、**返す形と順番はそろえる**。
    */
    vi.spyOn(runtime, "canRunProcesses").mockReturnValue(false);

    const readDirectory = vi.fn(async (uri: { fsPath: string }) => {
      if (uri.fsPath.endsWith("第1章")) {
        return [["003.md", FileType.File]];
      }
      if (uri.fsPath.endsWith("設定")) {
        return [["人物.txt", FileType.File]];
      }
      return [
        ["設定", FileType.Directory],
        ["002.txt", FileType.File],
        ["第1章", FileType.Directory],
        [".下書き.txt", FileType.File],
        ["001.txt", FileType.File],
        ["メモ.log", FileType.File],
      ];
    });
    const readFile = vi.fn(async (uri: { fsPath: string }) => {
      // **読めない本文は捨てない。** 1つずつ読んでいたころは「0字の話」として
      // 一覧に残っていたので、一括読みでも印を付けて残す
      if (uri.fsPath.endsWith("002.txt")) {
        throw new FileSystemError("読めません", "NoPermissions");
      }
      return new TextEncoder().encode("灯が歩いた。");
    });
    workspace.fs = { readFile, readDirectory };

    setFileReaderForTests(undefined);
    const reader = await fileReader();

    const files = await reader.readTextTree("C:/w", (name, kind) =>
      kind === "directory" ? name !== "設定" : /\.(txt|md)$/.test(name)
    );

    expect(files.map((file) => file.path.replace(/\\/g, "/"))).toEqual([
      "C:/w/001.txt",
      "C:/w/002.txt",
      "C:/w/第1章/003.md",
    ]);
    expect(files[1].unreadable).toBe(true);
    expect(files[1].bytes).toHaveLength(0);
    // 「中へ入らない」と言われたフォルダーは覗きにいかない
    expect(
      readDirectory.mock.calls.map(([uri]) => uri.fsPath).join("|")
    ).not.toContain("設定");
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

/**
 * **どちらの読み口を選んだか**（設計書6.107。0.74.11）。
 *
 * 0.74.9 の計測で「読み 58,191ms」が出たとき、まず確かめるべきは
 * **そもそも Node 側を通っているのか**だった。`isUriString("C:/…")` は
 * 偽なので通っているはず、で止まっていた——「はず」を数字にしないと、
 * ここから先はぜんぶ当てずっぽうになる。
 */
describe("選んだ読み口を名乗る", () => {
  test("手元（`canRunProcesses()` が真）なら `node`", async () => {
    vi.spyOn(runtime, "canRunProcesses").mockReturnValue(true);
    setFileReaderForTests(undefined);

    expect(await readerKind()).toBe("node");
  });

  test("ブラウザ版なら `vscode`", async () => {
    vi.spyOn(runtime, "canRunProcesses").mockReturnValue(false);
    setFileReaderForTests(undefined);

    expect(await readerKind()).toBe("vscode");
  });

  test("まだ選んでいなくても、選ばせてから答える", async () => {
    // **呼び手に順番を気にさせない。** 起動の1行を書く時点で読み口が
    // 決まっていなければ、`fileReader()` を先に呼んだかどうかで
    // 答えが変わってしまう
    vi.spyOn(runtime, "canRunProcesses").mockReturnValue(true);
    setFileReaderForTests(undefined);

    const kind = await readerKind();

    expect(kind).toBe("node");
    expect(await fileReader()).toBeDefined();
  });
});
