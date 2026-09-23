import { afterEach, describe, expect, test, vi } from "vitest";

/**
 * フォルダーが同じ場所かの比べ方（`pathText.ts` の `isSameFolder`・
 * `folderKeyForComparison`・`tidyFolderPath`。2026-09-24）。
 *
 * 作品の登録簿が同じ場所を表記の違いで二重に登録していた（作者の報告）。
 * 比べ方を1か所に置き、登録簿の場所を比べる所はすべてここを通す。
 *
 * Windows かどうかは `runtime.ts` の1か所が決めるので、差し替えて
 * 両方の場合を確かめる（大小を同一視するのは Windows のときだけ）。
 */
const host = vi.hoisted(() => ({ windows: false }));

vi.mock("../../../src/core/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/core/runtime")>();
  return { ...actual, isWindowsHost: () => host.windows };
});

import {
  folderKeyForComparison,
  isSameFolder,
  tidyFolderPath,
} from "../../../src/core/pathText";

afterEach(() => {
  host.windows = false;
});

describe("tidyFolderPath（登録簿へ入れる形）", () => {
  // Windows の `path.normalize` は `/` を `\` へ変えるので、posix の道の
  // 形そのものを確かめるのは Windows 以外でだけ（Windows の道は下で見る）
  test.runIf(process.platform !== "win32")("前後の空白と末尾の区切りを落とす", () => {
    expect(tidyFolderPath("  /小説/作品/  ")).toBe("/小説/作品");
    expect(tidyFolderPath("/小説/作品//")).toBe("/小説/作品");
    expect(tidyFolderPath("/")).toBe("/");
  });

  test("URI の根は区切りを残す", () => {
    expect(tidyFolderPath("vscode-vfs://github/")).toBe("vscode-vfs://github/");
  });

  test("URI は末尾の斜線だけを落とし、仕組みと場所の `//` は残す", () => {
    expect(tidyFolderPath(" vscode-vfs://github/owner/repo/作品/ ")).toBe(
      "vscode-vfs://github/owner/repo/作品"
    );
  });

  test("空・空白だけは空文字", () => {
    expect(tidyFolderPath("")).toBe("");
    expect(tidyFolderPath("   ")).toBe("");
  });

  test.runIf(process.platform === "win32")("Windows の道：末尾の `\\` を落とし、ドライブの根は残す", () => {
    expect(tidyFolderPath(" C:\\Users\\nonah\\novels\\ ")).toBe("C:\\Users\\nonah\\novels");
    expect(tidyFolderPath("C:/Users/nonah/novels/")).toBe("C:\\Users\\nonah\\novels");
    expect(tidyFolderPath("C:\\")).toBe("C:\\");
    expect(tidyFolderPath("\\\\server\\share\\作品\\")).toBe("\\\\server\\share\\作品");
  });

  test.runIf(process.platform === "win32")("Windows でも大小は変えない", () => {
    // 大小まで畳むと、作者が見るフォルダー名と作品一覧の表記が食い違う
    host.windows = true;
    expect(tidyFolderPath("C:\\Novels\\作品A\\")).toBe("C:\\Novels\\作品A");
  });
});

describe("isSameFolder", () => {
  test("末尾の区切りと前後の空白の違いは同じ場所", () => {
    expect(isSameFolder("/小説/作品", " /小説/作品/ ")).toBe(true);
    expect(
      isSameFolder("vscode-vfs://github/o/r/作品", "vscode-vfs://github/o/r/作品/")
    ).toBe(true);
  });

  test("Windows でなければ大小を区別する", () => {
    host.windows = false;
    expect(isSameFolder("/小説/Novels", "/小説/novels")).toBe(false);
  });

  test("Windows なら大小を同一視する", () => {
    host.windows = true;
    expect(isSameFolder("/小説/Novels", "/小説/novels/")).toBe(true);
  });

  test.runIf(process.platform === "win32")("ドライブ文字の大小（フォルダー選びとアドレス欄）", () => {
    host.windows = true;
    expect(
      isSameFolder("c:\\Users\\nonah\\Documents\\novels", "C:\\Users\\nonah\\Documents\\novels\\")
    ).toBe(true);
  });

  test("名前の続きが違えば別物", () => {
    expect(isSameFolder("/小説/作品", "/小説/作品2")).toBe(false);
  });

  test("空はどちらでも false", () => {
    expect(isSameFolder("", "")).toBe(false);
    expect(isSameFolder("  ", "/小説")).toBe(false);
    expect(folderKeyForComparison(" ")).toBe("");
  });
});
