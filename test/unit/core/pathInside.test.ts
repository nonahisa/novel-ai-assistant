import { afterEach, describe, expect, test, vi } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { resolve, sep } from "node:path";

/**
 * 「場所 B が場所 A の中にあるか」（`isPathInside`）の振る舞い（2026-09-23）。
 *
 * **同じ判定の写しが7か所あった。** 正規化は `normalizeForComparison` へ
 * 寄せ終えていたが、判定そのものは別々のままで、そのうち2か所
 * （`termHighlight.ts`・`settingsStore.ts`）は `relative.startsWith("..")`
 * で外かどうかを決めていた。**これだと `..下書き` のように「..」で始まる
 * 名前のフォルダーが、中にあるのに外と判定される。** 判定を1か所へ集め、
 * `goesOutside`（区切りまで見て「..」を判定する）を通す。
 *
 * Windows かどうかは `runtime.ts` の1か所が決めるので、ここではそれを
 * 差し替えて両方の場合を確かめる（Windows のときだけ大文字小文字を同一視）。
 */
const host = vi.hoisted(() => ({ windows: false }));

vi.mock("../../../src/core/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/core/runtime")>();
  return { ...actual, isWindowsHost: () => host.windows };
});

import { isPathInside } from "../../../src/core/pathText";
import * as paths from "../../../src/core/pathText";

afterEach(() => {
  host.windows = false;
});

describe("中にあるか", () => {
  test("中にあるものは true", () => {
    expect(isPathInside("/小説/作品", "/小説/作品/本文/1.md")).toBe(true);
    expect(isPathInside("/小説/作品", "/小説/作品/設定")).toBe(true);
  });

  test("同じ場所は false（中身ではなく、そのもの）", () => {
    expect(isPathInside("/小説/作品", "/小説/作品")).toBe(false);
    expect(isPathInside("/小説/作品", "/小説/作品/")).toBe(false);
  });

  test("外は false", () => {
    expect(isPathInside("/小説/作品", "/小説")).toBe(false);
    expect(isPathInside("/小説/作品", "/小説/別の作品/1.md")).toBe(false);
    expect(isPathInside("/小説/作品/本文", "/小説/作品/本文/../設定/a.json")).toBe(false);
  });

  test("前方一致だけでは中にしない（名前の続きが違う別フォルダー）", () => {
    expect(isPathInside("/小説/いじめられっ子", "/小説/いじめられっ子2/1.md")).toBe(false);
  });

  test("「..」で始まる名前のフォルダーは、中にある", () => {
    expect(isPathInside("/小説/作品", "/小説/作品/..下書き/1.md")).toBe(true);
    expect(isPathInside("/小説/作品", "/小説/作品/..下書き")).toBe(true);
  });

  test("空文字は false（どちらが空でも）", () => {
    expect(isPathInside("", "/小説/作品/1.md")).toBe(false);
    expect(isPathInside("/小説/作品", "")).toBe(false);
    expect(isPathInside("", "")).toBe(false);
  });
});

describe("大文字小文字は、Windows のときだけ同一視する", () => {
  test("Windows なら綴りの大小が違っても中", () => {
    host.windows = true;
    expect(isPathInside("C:/小説/Work", "c:/小説/work/本文/1.md")).toBe(true);
    expect(isPathInside("C:/小説/Work", "C:/小説/WORK")).toBe(false);
  });

  test("Windows でなければ、大小の違う道は別の場所（ブラウザ版の URI）", () => {
    // **URI で確かめる。** 手元の道だと、Windows の上では Node の
    // `path.relative` 自身が大小を同一視するので、「Windows でない」を
    // 差し替えても試せない（その組み合わせは実際には起きない）
    host.windows = false;
    const repo = "vscode-vfs://github/owner/repo";
    expect(isPathInside(`${repo}/Work`, `${repo}/work/本文/1.md`)).toBe(false);
    expect(isPathInside(`${repo}/Work`, `${repo}/Work/本文/1.md`)).toBe(true);
  });

  test.runIf(process.platform !== "win32")(
    "Windows でない手元の道も、大小の違いは別の場所",
    () => {
      host.windows = false;
      expect(isPathInside("/小説/Work", "/小説/work/本文/1.md")).toBe(false);
      expect(isPathInside("/小説/Work", "/小説/Work/本文/1.md")).toBe(true);
    }
  );

  test.runIf(process.platform === "win32")(
    "Windows の区切り（\\）の形でも比べられる",
    () => {
      host.windows = true;
      expect(isPathInside("C:\\小説\\作品", "c:\\小説\\作品\\本文\\2.md")).toBe(true);
      expect(isPathInside("C:\\小説\\作品", "C:\\小説\\作品\\..下書き\\1.md")).toBe(true);
      expect(isPathInside("C:\\小説\\作品", "C:\\小説\\別\\1.md")).toBe(false);
      expect(isPathInside("C:\\小説\\作品", "D:\\小説\\作品\\1.md")).toBe(false);
    }
  );
});

describe("URI の形（ブラウザ版の作品）", () => {
  const repo = "vscode-vfs://github/owner/repo";

  test("中・同じ・外", () => {
    expect(isPathInside(`${repo}/作品`, `${repo}/作品/本文/1.md`)).toBe(true);
    expect(isPathInside(`${repo}/作品`, `${repo}/作品`)).toBe(false);
    expect(isPathInside(`${repo}/作品`, `${repo}/別/1.md`)).toBe(false);
    expect(isPathInside(`${repo}/作品`, `${repo}/作品/..下書き/1.md`)).toBe(true);
  });

  test("仕組みか場所が違えば、中ではない", () => {
    expect(isPathInside(`${repo}/作品`, "vscode-vfs://github/other/repo/作品/1.md")).toBe(false);
    expect(isPathInside(`${repo}/作品`, "/owner/repo/作品/1.md")).toBe(false);
  });
});

/**
 * **同じ場所でも、日本語が百分率符号化されているかどうかで表記が割れる**
 * （2026-09-24。ブラウザ版の実機で、本文を開いても下の欄に種類の目安と
 * 今日の執筆量が出なかった）。
 *
 * - 登録簿の場所は、書庫の中を読んだ名前を `join` でつないだもの——**生の日本語**
 *   （`vscode-test-web://mount/仮作品`）
 * - 開いた本文の場所は `paths.fromUri(document.uri)`——非 `file:` では
 *   `uri.toString()` になり、**日本語が符号化される**
 *   （`vscode-test-web://mount/%E4%BB%AE%E4%BD%9C%E5%93%81/episode_0001.txt`）
 *
 * 文字列のまま比べると「外」になり、作品が引き当てられなかった。
 */
describe("URI の日本語が符号化されていても、同じ場所として比べる", () => {
  const raw = "vscode-test-web://mount/仮作品";
  const encoded = "vscode-test-web://mount/%E4%BB%AE%E4%BD%9C%E5%93%81";

  test("生の作品フォルダーと、符号化された本文", () => {
    expect(isPathInside(raw, `${encoded}/episode_0001.txt`)).toBe(true);
  });

  test("符号化された作品フォルダーと、生の本文（逆向き）", () => {
    expect(isPathInside(encoded, `${raw}/episode_0001.txt`)).toBe(true);
  });

  test("符号を解いても別のフォルダーなら、外のまま", () => {
    // 「仮作品2」＝ 仮作品 のあとに 2
    const other = "vscode-test-web://mount/%E4%BB%AE%E4%BD%9C%E5%93%812/1.txt";
    expect(isPathInside(raw, other)).toBe(false);
  });

  test("解けない % を含む名前でも落ちず、そのまま比べる", () => {
    const folder = "vscode-vfs://github/owner/repo/50%OFF";
    expect(isPathInside(folder, `${folder}/1.md`)).toBe(true);
    expect(isPathInside(folder, "vscode-vfs://github/owner/repo/50%25OFF/1.md")).toBe(true);
  });

  test("手元の道の % は符号として読まない（名前の一部）", () => {
    // 手元のフォルダー名に「%E4」と書いてあっても、それは名前そのもの
    expect(isPathInside("/小説/%E4%BB%AE", "/小説/仮/1.md")).toBe(false);
  });
});

describe("以前の写し（startsWith 型）が誤っていたこと", () => {
  /**
   * `termHighlight.ts`・`settingsStore.ts` にあった判定をそのまま写したもの。
   * **ここにだけ残す**——共通の判定と並べて、何が変わったかを示すため。
   */
  function oldStartsWithCopy(parentPath: string, candidatePath: string): boolean {
    const parent = paths.normalizeForComparison(parentPath);
    const candidate = paths.normalizeForComparison(candidatePath);
    const relative = paths.relative(parent, candidate);
    return (
      relative.length > 0 &&
      !relative.startsWith("..") &&
      !paths.isAbsolute(relative)
    );
  }

  test("「..下書き」を外と誤判定していた。共通の判定は中と答える", () => {
    const parent = "/小説/作品";
    const child = "/小説/作品/..下書き/1.md";
    expect(oldStartsWithCopy(parent, child)).toBe(false);
    expect(isPathInside(parent, child)).toBe(true);
  });
});

describe("網：自前の「中にあるか」を作らない", () => {
  /**
   * **写しが7か所あり、2か所が誤っていた**のは、それぞれが自前で判定を
   * 書いたから。共通の `isPathInside`（`core/pathText.ts`）の定義だけを許し、
   * ほかで同じ名前の判定を定義していたら落とす。
   *
   * コメントの行は見ない（「以前は `function isInside` があった」のような
   * 記録を書けなくなるため。`exampleNames.test.ts` と同じ考え方）。
   *
   * 見張るのは名前だけで、判定の中身までは見ない。**別の名前で写されると
   * すり抜ける**——そこは検査では防げないので、`pathText.ts` の注記と
   * この網の両方で「ここにある」と知らせる。
   */
  const SRC_DIR = resolve(__dirname, "..", "..", "..", "src");
  const ALLOWED = "src/core/pathText.ts";
  const DEFINITION =
    /\bfunction\s+(isPathInside|isInside)\s*\(|\b(?:const|let)\s+(isPathInside|isInside)\s*=/;

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
    return (
      trimmed.startsWith("//") ||
      trimmed.startsWith("*") ||
      trimmed.startsWith("/*")
    );
  }

  test("前提：走査が src の中身を拾えている（0件で全部通るのを防ぐ）", () => {
    const files = sources(SRC_DIR).map((file) =>
      relativeFromRoot(file)
    );
    expect(files).toContain(ALLOWED);
    expect(files.length).toBeGreaterThan(100);
  });

  test("共通の定義は pathText.ts に1つだけある", () => {
    const text = readFileSync(resolve(SRC_DIR, "core", "pathText.ts"), "utf8");
    expect(text).toMatch(/export function isPathInside\(/);
  });

  test("ほかのファイルで、同じ判定を定義していない", () => {
    const hits: string[] = [];
    for (const file of sources(SRC_DIR)) {
      const rel = relativeFromRoot(file);
      if (rel === ALLOWED) continue;
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, index) => {
          if (isComment(line)) return;
          if (DEFINITION.test(line)) hits.push(`${rel}:${index + 1}  ${line.trim()}`);
        });
    }
    expect(hits).toEqual([]);
  });

  function relativeFromRoot(file: string): string {
    return file.slice(file.indexOf(`src${sep}`)).split(sep).join("/");
  }
});
