import { describe, expect, test } from "vitest";
import {
  basename,
  dirname,
  extname,
  isUriString,
  join,
  normalize,
  relative,
  resolve,
  separatorFor,
} from "../../src/core/pathText";

/**
 * **場所（authority）の無い URI**（設計書5.8）。
 *
 * ブラウザ版で、拡張機能の保管庫は `vscode-userdata:/User/…` である。
 * GitHub 上の作品（`vscode-vfs://github/…`）と違って**斜線が1本**で、
 * authority が空になる。
 *
 * 判定が斜線2本を必須にしていたので、この道は「OSのパス」として扱われ、
 * `join` が `\` で繋いで別の場所を指していた。**生成文書（使い方・
 * はじめの案内など）が必ず無題文書へ落ちていた**のはこれが原因である
 * （0.47.4 の積み残し④。0.51.3 で直した）。
 */

const USER_DATA = "vscode-userdata:/User/globalStorage/nonahisa.novel-ai-assistant";
const VFS = "vscode-vfs://github/nonahisa/mynovel";

describe("場所の無い URI（vscode-userdata:）", () => {
  test("**URI だと分かる**", () => {
    expect(isUriString(USER_DATA)).toBe(true);
    expect(isUriString("vscode-userdata:/User/settings.json")).toBe(true);
  });

  test("**Windows のドライブ文字とは取り違えない**", () => {
    // 仕組みの名前が1文字のものは弾く。ここを緩めると `C:/…` が URI になる
    expect(isUriString("C:/Users/nonah/novel")).toBe(false);
    expect(isUriString("C:\Users\nonah\novel")).toBe(false);
    expect(isUriString("D:/works")).toBe(false);
  });

  test("繋ぐと、斜線1本のまま伸びる", () => {
    expect(join(USER_DATA, "生成", "使い方.md")).toBe(
      `${USER_DATA}/生成/使い方.md`
    );
    // 斜線2本のほうは、これまでどおり
    expect(join(VFS, "本文", "001.txt")).toBe(`${VFS}/本文/001.txt`);
  });

  test("名前・親・拡張子が読める", () => {
    const file = `${USER_DATA}/生成/使い方.md`;
    expect(basename(file)).toBe("使い方.md");
    expect(basename(file, ".md")).toBe("使い方");
    expect(dirname(file)).toBe(`${USER_DATA}/生成`);
    expect(extname(file)).toBe(".md");
  });

  test("区切りは `/`（OS の `\` にしない）", () => {
    expect(separatorFor(USER_DATA)).toBe("/");
  });

  test("整えても、仕組みの名前が消えない", () => {
    expect(normalize(`vscode-userdata:/User/a/../b`)).toBe(
      "vscode-userdata:/User/b"
    );
  });

  test("同じ仕組みどうしなら、相対で表せる", () => {
    expect(relative(`${USER_DATA}/生成`, `${USER_DATA}/生成/使い方.md`)).toBe(
      "使い方.md"
    );
    // 仕組みが違えばたどり着けないので、行き先をそのまま返す
    expect(relative(VFS, `${USER_DATA}/x`)).toBe(`${USER_DATA}/x`);
  });

  test("後ろから組み立てても、保管庫から始められる", () => {
    expect(resolve("C:/どこか", USER_DATA, "生成")).toBe(`${USER_DATA}/生成`);
  });
});
