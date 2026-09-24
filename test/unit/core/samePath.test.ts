import { readdirSync, readFileSync } from "fs";
import { resolve, sep } from "path";
import { afterEach, describe, expect, test, vi } from "vitest";

/**
 * 「同じ場所か」の比べ方を1つにする（`pathText.ts` の `isSamePath`・
 * `pathKeyForComparison`、2026-09-24）。
 *
 * ブラウザ版では、同じ場所が2通りに書かれる。
 *
 * - 登録簿や `join` で組んだ場所——**生の日本語**（`vscode-test-web://mount/仮作品`）
 * - `fromUri(document.uri)`——非 `file:` では `uri.toString()` になり**符号化される**
 *
 * `normalizeForComparison` どうしを `===` で比べていた所では、開いている文書を
 * 探しても見つからず、ブラウザ版で日本語の名前の作品や話が「別の場所」になっていた。
 *
 * Windows かどうかは `runtime.ts` の1か所が決めるので差し替えて確かめる。
 */
const host = vi.hoisted(() => ({ windows: false }));

vi.mock("../../../src/core/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/core/runtime")>();
  return { ...actual, isWindowsHost: () => host.windows };
});

import {
  folderKeyForComparison,
  isSameFolder,
  isSamePath,
  normalizeForComparison,
  pathKeyForComparison,
} from "../../../src/core/pathText";
import { findWorkByFolder } from "../../../src/core/workRegistry";

afterEach(() => {
  host.windows = false;
});

const RAW = "vscode-test-web://mount/仮作品/本文/第1話.txt";
const ENCODED = `vscode-test-web://mount/${encodeURIComponent("仮作品")}/${encodeURIComponent("本文")}/${encodeURIComponent("第1話.txt")}`;

describe("isSamePath（ファイルが同じ場所か）", () => {
  test("前提：符号化の形と生の形は、文字列としては違う", () => {
    // これまでの比べ方（normalizeForComparison どうし）では別物になっていた
    expect(normalizeForComparison(RAW)).not.toBe(normalizeForComparison(ENCODED));
  });

  test("符号化の形と生の形を、同じ場所と見る", () => {
    expect(isSamePath(RAW, ENCODED)).toBe(true);
    expect(isSamePath(ENCODED, RAW)).toBe(true);
    expect(pathKeyForComparison(RAW)).toBe(pathKeyForComparison(ENCODED));
  });

  test("vscode-vfs の作品でも同じ", () => {
    const raw = "vscode-vfs://github/o/r/灯台/本文/01.md";
    const encoded = `vscode-vfs://github/o/r/${encodeURIComponent("灯台")}/${encodeURIComponent("本文")}/01.md`;
    expect(isSamePath(raw, encoded)).toBe(true);
  });

  test("% を含む生のファイル名（100%.txt）を、符号化の形と同じと見る", () => {
    const raw = "vscode-test-web://mount/仮作品/100%.txt";
    const encoded = `vscode-test-web://mount/${encodeURIComponent("仮作品")}/${encodeURIComponent("100%.txt")}`;
    expect(encoded).toContain("100%25.txt");
    expect(isSamePath(raw, encoded)).toBe(true);
  });

  test("% を含む名前を、% の無い名前と取り違えない", () => {
    expect(
      isSamePath("vscode-test-web://mount/作品/100%.txt", "vscode-test-web://mount/作品/100.txt")
    ).toBe(false);
    expect(
      isSamePath("vscode-test-web://mount/作品/50%OFF.txt", "vscode-test-web://mount/作品/50OFF.txt")
    ).toBe(false);
  });

  test("名前が違えば別物（符号化していても）", () => {
    const other = `vscode-test-web://mount/${encodeURIComponent("仮作品")}/${encodeURIComponent("本文")}/${encodeURIComponent("第2話.txt")}`;
    expect(isSamePath(RAW, other)).toBe(false);
  });

  test("仕組みか場所が違えば別物", () => {
    expect(
      isSamePath("vscode-vfs://github/o/r/作品/a.txt", "vscode-test-web://github/o/r/作品/a.txt")
    ).toBe(false);
  });

  test("空はどちらでも false", () => {
    expect(isSamePath("", "")).toBe(false);
    expect(isSamePath("", RAW)).toBe(false);
  });

  test("Windows でなければ大小を区別する（今までどおり）", () => {
    host.windows = false;
    expect(isSamePath("/小説/Novels/a.txt", "/小説/novels/a.txt")).toBe(false);
  });

  test("Windows なら大小を同一視する（今までどおり）", () => {
    host.windows = true;
    expect(isSamePath("/小説/Novels/a.txt", "/小説/novels/A.txt")).toBe(true);
  });

  test.runIf(process.platform === "win32")("Windows の道：区切りとドライブ文字の違いは同じ（今までどおり）", () => {
    host.windows = true;
    expect(
      isSamePath("c:\\Users\\nonah\\小説\\第1話.txt", "C:/Users/nonah/小説/第1話.txt")
    ).toBe(true);
  });

  test("手元の道の % は名前の一部なので解かない", () => {
    // `%E4%BB%AE` という名前のファイルと「仮」という名前のファイルは別物
    expect(isSamePath("/小説/%E4%BB%AE.txt", "/小説/仮.txt")).toBe(false);
    expect(pathKeyForComparison("/小説/100%.txt")).toBe(
      normalizeForComparison("/小説/100%.txt")
    );
  });
});

describe("登録簿の重複の見方（folderKeyForComparison）も符号を解く", () => {
  const rawFolder = "vscode-test-web://mount/仮作品";
  const encodedFolder = `vscode-test-web://mount/${encodeURIComponent("仮作品")}/`;

  test("フォルダー選び（符号化）と書庫から（生）の登録を同じ場所と見る", () => {
    expect(folderKeyForComparison(rawFolder)).toBe(folderKeyForComparison(encodedFolder));
    expect(isSameFolder(rawFolder, encodedFolder)).toBe(true);
  });

  test("登録簿の引き当ても、符号化の形で引ける", () => {
    const works = [{ id: "w1", folderPath: rawFolder }];
    expect(findWorkByFolder(works, encodedFolder)?.id).toBe("w1");
  });

  test("normalizeForComparison は変えない（退避の控えの鍵に使われている）", () => {
    // `atomicWrite.ts` の `recoveryKey` がこの形の hash を名前にしている。
    // 変えると、すでに退避してある控えが引けなくなる
    expect(normalizeForComparison(encodedFolder)).toContain("%E4%BB%AE");
  });
});

describe("網：開いた文書の場所を、符号を解かずに比べない", () => {
  /**
   * `normalizeForComparison(fromUri(...))` は、ブラウザ版では符号化された形の
   * 鍵になり、生の日本語の場所と `===` で一致しない。そう書いている所が5つあった。
   * **比べるなら `isSamePath`・`pathKeyForComparison` を通す。**
   * コメントの行は見ない（経緯を書けるように）。
   */
  const SRC_DIR = resolve(__dirname, "..", "..", "..", "src");
  const PATTERN = /normalizeForComparison\(\s*(?:paths?\.)?fromUri\(/;

  function sources(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = resolve(dir, entry.name);
      if (entry.isDirectory()) sources(full, out);
      else if (entry.name.endsWith(".ts")) out.push(full);
    }
    return out;
  }

  function isComment(line: string): boolean {
    const trimmed = line.trim();
    return trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*");
  }

  test("前提：走査が src の中身を拾えている", () => {
    expect(sources(SRC_DIR).length).toBeGreaterThan(100);
  });

  test("normalizeForComparison(fromUri(...)) と書いている所が無い", () => {
    const hits: string[] = [];
    for (const file of sources(SRC_DIR)) {
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, index) => {
          if (isComment(line)) return;
          if (PATTERN.test(line)) {
            const rel = file.slice(file.indexOf(`src${sep}`)).split(sep).join("/");
            hits.push(`${rel}:${index + 1}  ${line.trim()}`);
          }
        });
    }
    expect(hits).toEqual([]);
  });
});
