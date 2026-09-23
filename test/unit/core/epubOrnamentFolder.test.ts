import * as path from "path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  ORNAMENT_DIR,
  collectOrnamentCatalogue,
  readOrnamentFolder,
} from "../../src/core/epubOrnamentFolder";
import { BUILTIN_ORNAMENTS } from "../../src/core/epubOrnaments";
import { FileSystemError, FileType, Uri, workspace } from "./support/vscodeStub";

/**
 * 外から足す飾りを読む口（設計書6.65.17）。
 *
 * **作品ごと**は `設定/書籍/飾り/*.svg`（`設定/` はGitで同期されるので、
 * 別の端末でも同じ本が組める）。**全作品共通**は設定で指したフォルダー。
 *
 * **読めなくても本は組める。** ブラウザ版では手元のフォルダーを読めない
 * ことがあるので、その場合は組み込みの飾りだけになる。
 */

const settingsDir = "C:\\novels\\work\\設定";
const sharedDir = "C:\\飾り置き場";

const disk = new Map<string, string>();
/** 実在するフォルダー。`readDirectory` はここに無ければ FileNotFound */
const folders = new Set<string>();

function diskPath(filePath: string): string {
  return Uri.file(filePath).fsPath;
}

function put(folder: string, name: string, text: string): void {
  folders.add(diskPath(folder));
  disk.set(diskPath(path.join(folder, name)), text);
}

const PLAIN =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24"><path d="M12 2 L16 12 L12 22 L8 12 Z" fill="currentColor"/></svg>';

const originalGetConfiguration = workspace.getConfiguration;

/** 共通フォルダーの設定。空文字なら「指していない」 */
function setSharedFolder(value: string): void {
  workspace.getConfiguration = (() => ({
    get: <T>(key: string, defaultValue: T): T =>
      key === "epub.ornamentFolder" ? (value as unknown as T) : defaultValue,
  })) as typeof workspace.getConfiguration;
}

describe("外から足す飾りを読む", () => {
  beforeEach(() => {
    disk.clear();
    folders.clear();
    setSharedFolder("");

    workspace.fs = {
      readDirectory: async (uri: { fsPath: string }) => {
        if (!folders.has(uri.fsPath)) {
          throw new FileSystemError("missing", "FileNotFound");
        }
        const prefix = `${uri.fsPath}${path.sep}`;
        const entries: Array<[string, FileType]> = [];
        for (const filePath of disk.keys()) {
          if (!filePath.startsWith(prefix)) continue;
          const name = filePath.slice(prefix.length);
          if (name.includes(path.sep)) continue;
          entries.push([name, FileType.File]);
        }
        return entries;
      },
      readFile: async (uri: { fsPath: string }) => {
        const text = disk.get(uri.fsPath);
        if (text === undefined) {
          throw new FileSystemError("missing", "FileNotFound");
        }
        return new TextEncoder().encode(text);
      },
    } as never;
  });

  afterEach(() => {
    workspace.getConfiguration = originalGetConfiguration;
  });

  test("フォルダーが無ければ、空で返す（叱らない）", async () => {
    const result = await readOrnamentFolder(
      path.join(settingsDir, "書籍", ORNAMENT_DIR),
      "work"
    );
    expect(result.ornaments).toEqual([]);
    expect(result.rejected).toEqual([]);
  });

  test("ファイル名がidと呼び名になる", async () => {
    const folder = path.join(settingsDir, "書籍", ORNAMENT_DIR);
    put(folder, "うちの花.svg", PLAIN);

    const result = await readOrnamentFolder(folder, "work");

    expect(result.ornaments).toHaveLength(1);
    expect(result.ornaments[0].id).toBe("うちの花");
    expect(result.ornaments[0].label).toBe("うちの花");
    expect(result.ornaments[0].source).toBe("work");
    // 検査を通した形で持つ（読み上げから外す印が付く）
    expect(result.ornaments[0].svg).toContain('aria-hidden="true"');
  });

  test(".svg 以外は見ない", async () => {
    const folder = path.join(settingsDir, "書籍", ORNAMENT_DIR);
    put(folder, "覚え書き.txt", "これは飾りではない");
    put(folder, "うちの花.svg", PLAIN);

    const result = await readOrnamentFolder(folder, "work");

    expect(result.ornaments.map((item) => item.id)).toEqual(["うちの花"]);
    expect(result.rejected).toEqual([]);
  });

  /**
   * **通らなかった飾りは図録に入れず、理由を残す。** 黙って落とすと、
   * 置いたのに選べない理由が作者に分からない。
   */
  test("検査に落ちた飾りは、理由を添えて外す", async () => {
    const folder = path.join(settingsDir, "書籍", ORNAMENT_DIR);
    put(
      folder,
      "あぶない.svg",
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'
    );
    put(folder, "うちの花.svg", PLAIN);

    const result = await readOrnamentFolder(folder, "work");

    expect(result.ornaments.map((item) => item.id)).toEqual(["うちの花"]);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].id).toBe("あぶない");
    expect(result.rejected[0].reason).toContain("script");
  });

  test("読めなかった1枚で、ほかの飾りを巻き添えにしない", async () => {
    const folder = path.join(settingsDir, "書籍", ORNAMENT_DIR);
    put(folder, "うちの花.svg", PLAIN);
    // 一覧には出るが中身が無い（外で消された等）
    folders.add(diskPath(folder));
    disk.set(diskPath(path.join(folder, "消えた.svg")), PLAIN);
    disk.delete(diskPath(path.join(folder, "消えた.svg")));

    const result = await readOrnamentFolder(folder, "work");

    expect(result.ornaments.map((item) => item.id)).toEqual(["うちの花"]);
  });
});

describe("図録をひとまとめにする", () => {
  beforeEach(() => {
    disk.clear();
    folders.clear();
    setSharedFolder("");

    workspace.fs = {
      readDirectory: async (uri: { fsPath: string }) => {
        if (!folders.has(uri.fsPath)) {
          throw new FileSystemError("missing", "FileNotFound");
        }
        const prefix = `${uri.fsPath}${path.sep}`;
        const entries: Array<[string, FileType]> = [];
        for (const filePath of disk.keys()) {
          if (!filePath.startsWith(prefix)) continue;
          const name = filePath.slice(prefix.length);
          if (name.includes(path.sep)) continue;
          entries.push([name, FileType.File]);
        }
        return entries;
      },
      readFile: async (uri: { fsPath: string }) => {
        const text = disk.get(uri.fsPath);
        if (text === undefined) {
          throw new FileSystemError("missing", "FileNotFound");
        }
        return new TextEncoder().encode(text);
      },
    } as never;
  });

  afterEach(() => {
    workspace.getConfiguration = originalGetConfiguration;
  });

  test("何も置いていなければ、組み込みだけ", async () => {
    const result = await collectOrnamentCatalogue(settingsDir);
    expect(result.catalogue.map((item) => item.id)).toEqual(
      BUILTIN_ORNAMENTS.map((item) => item.id)
    );
    expect(result.rejected).toEqual([]);
  });

  test("組み込み → 作品の飾り → 共通 の順に並ぶ", async () => {
    put(path.join(settingsDir, "書籍", ORNAMENT_DIR), "うちの花.svg", PLAIN);
    put(sharedDir, "共通の花.svg", PLAIN);
    setSharedFolder(sharedDir);

    const result = await collectOrnamentCatalogue(settingsDir);
    const ids = result.catalogue.map((item) => item.id);

    expect(ids.slice(0, BUILTIN_ORNAMENTS.length)).toEqual(
      BUILTIN_ORNAMENTS.map((item) => item.id)
    );
    expect(ids.slice(BUILTIN_ORNAMENTS.length)).toEqual([
      "うちの花",
      "共通の花",
    ]);
  });

  /** 先勝ち。共通フォルダーに `rule.svg` を置いても罫線は変わらない */
  test("組み込みと同じidは、置いても効かない", async () => {
    put(sharedDir, "rule.svg", PLAIN);
    setSharedFolder(sharedDir);

    const result = await collectOrnamentCatalogue(settingsDir);

    expect(result.catalogue.filter((item) => item.id === "rule")).toHaveLength(1);
    expect(result.catalogue.find((item) => item.id === "rule")?.source).toBe(
      "builtin"
    );
    expect(result.shadowed).toEqual(["rule"]);
  });
});
