import { describe, it, expect } from "vitest";
import * as nodePath from "path";
import * as paths from "../../src/core/paths";

/**
 * 手元のファイルと、ブラウザ上の作品を、同じ書き方で扱う（設計書5.8）。
 *
 * **2つのことを確かめる。**
 *
 * 1. 手元のファイルでは、`path` とまったく同じに振る舞うこと
 *    （64ファイルが import を差し替えるので、**1つでも違えば原稿の場所がずれる**）
 * 2. ブラウザ上の作品（`vscode-vfs://...`）でも、正しく組み立て直せること
 */

const 作品 = "vscode-vfs://github/nonahisa/mynovel";

describe("手元のファイルでは、path とまったく同じ", () => {
  const 例 = [
    ["C:\\Users\\nonah\\Documents\\いじめられっ子", "本文", "001.txt"],
    ["/home/author/novel", "設定", "characters", "a.json"],
    ["relative", "..", "other"],
    ["C:\\a\\b", "..\\c"],
  ];

  for (const parts of 例) {
    it(`join(${parts.join(", ")})`, () => {
      expect(paths.join(...parts)).toBe(nodePath.join(...parts));
    });
  }

  const 単体 = [
    "C:\\Users\\nonah\\Documents\\いじめられっ子\\本文\\001.txt",
    "/home/author/novel/本文/001.txt",
    "001.txt",
    "C:\\a\\b\\",
  ];

  for (const location of 単体) {
    it(`basename / dirname / extname（${location}）`, () => {
      expect(paths.basename(location)).toBe(nodePath.basename(location));
      expect(paths.dirname(location)).toBe(nodePath.dirname(location));
      expect(paths.extname(location)).toBe(nodePath.extname(location));
      expect(paths.normalize(location)).toBe(nodePath.normalize(location));
      expect(paths.isAbsolute(location)).toBe(nodePath.isAbsolute(location));
    });
  }

  it("relative と resolve も同じ", () => {
    const from = nodePath.resolve("a", "b");
    const to = nodePath.resolve("a", "c", "d.txt");
    expect(paths.relative(from, to)).toBe(nodePath.relative(from, to));
    expect(paths.resolve("a", "b", "c")).toBe(nodePath.resolve("a", "b", "c"));
  });

  it("拡張子を落とす形も同じ", () => {
    expect(paths.basename("001_タイトル.txt", ".txt")).toBe(
      nodePath.basename("001_タイトル.txt", ".txt")
    );
  });
});

describe("Windowsのドライブ文字を、URIと間違えない", () => {
  it("C: はURIではない", () => {
    // **ここを取り違えると、手元の作品がすべて開けなくなる**
    expect(paths.isUriString("C:\\Users\\nonah")).toBe(false);
    expect(paths.isUriString("C:/Users/nonah")).toBe(false);
    // 二重スラッシュでも、1文字の仕組み名は無い
    expect(paths.isUriString("C://Users/nonah")).toBe(false);
  });

  it("仕組み名が2文字以上ならURI", () => {
    expect(paths.isUriString("vscode-vfs://github/o/r")).toBe(true);
    expect(paths.isUriString("file:///c:/a")).toBe(true);
    expect(paths.isUriString("https://example.com/a")).toBe(true);
  });

  it("相対パスはURIではない", () => {
    expect(paths.isUriString("本文/001.txt")).toBe(false);
    expect(paths.isUriString("./a")).toBe(false);
    expect(paths.isUriString("")).toBe(false);
  });
});

describe("ブラウザ上の作品", () => {
  it("下へ繋げる", () => {
    expect(paths.join(作品, "本文", "001.txt")).toBe(
      "vscode-vfs://github/nonahisa/mynovel/本文/001.txt"
    );
  });

  it("繋いでも二重スラッシュを潰さない", () => {
    // **`path.join` に渡すと `vscode-vfs:/github/...` になって別物になる**
    const 繋いだ = paths.join(作品, "設定");
    expect(繋いだ.startsWith("vscode-vfs://github/")).toBe(true);
    expect(繋いだ).not.toContain("vscode-vfs:/g");
  });

  it("名前と親をたどれる", () => {
    const ファイル = paths.join(作品, "本文", "001_はじまり.txt");
    expect(paths.basename(ファイル)).toBe("001_はじまり.txt");
    expect(paths.basename(ファイル, ".txt")).toBe("001_はじまり");
    expect(paths.extname(ファイル)).toBe(".txt");
    expect(paths.dirname(ファイル)).toBe(作品 + "/本文");
  });

  it("親をたどっても、仕組みと場所が残る", () => {
    let ここ = paths.join(作品, "a", "b", "c");
    for (let i = 0; i < 3; i++) ここ = paths.dirname(ここ);
    expect(ここ).toBe(作品);
  });

  it("上へ戻る指定を畳む", () => {
    expect(paths.join(作品, "本文", "..", "設定")).toBe(作品 + "/設定");
    expect(paths.normalize(作品 + "/a/./b/../c")).toBe(作品 + "/a/c");
  });

  it("常に場所が確定している", () => {
    expect(paths.isAbsolute(作品)).toBe(true);
  });

  it("同じ作品の中なら、相対で表せる", () => {
    const 本文 = paths.join(作品, "本文");
    const ファイル = paths.join(作品, "本文", "001.txt");
    expect(paths.relative(本文, ファイル)).toBe("001.txt");
    expect(paths.relative(作品, ファイル)).toBe("本文/001.txt");
  });

  it("同じ置き場の別作品なら、相対で表せる", () => {
    // 仕組みも場所（github）も同じなので、たどれる
    const 別 = "vscode-vfs://github/nonahisa/another";
    expect(paths.relative(作品, 別)).toBe("../another");
  });

  it("たどり着けない先は、そのまま返す", () => {
    // **「../../」で表すと、まったく別の場所を指す。**
    // `path.relative` も、別のドライブに対してこうする
    const 別の置き場 = "vscode-vfs://github+abc/nonahisa/mynovel";
    expect(paths.relative(作品, 別の置き場)).toBe(別の置き場);
    // 手元のファイルとブラウザ上の作品のあいだも、たどれない
    expect(paths.relative("C:\\a", 作品)).toBe(作品);
    expect(paths.relative(作品, "C:\\a")).toBe("C:\\a");
  });

  it("区切りは常にスラッシュ", () => {
    expect(paths.separatorFor(作品)).toBe("/");
    expect(paths.separatorFor("C:\\a")).toBe(nodePath.sep);
  });

  it("resolve は、いちばん後ろの確定した場所から組み立てる", () => {
    expect(paths.resolve("C:\\ignored", 作品, "本文")).toBe(作品 + "/本文");
  });
});

describe("外を指しているか（goesOutside）", () => {
  /**
   * **`..${path.sep}` を直に書いている箇所が5つあった。** `path.sep` は
   * 常にOSの区切りだが、`relative()` はブラウザ上の作品に対して
   * 常に `/` を返す。取り違えると、作品の外のファイルを
   * 「中にある」と誤判定する。
   */
  it("手元のファイルで、外を正しく判定する", () => {
    const base = nodePath.resolve("a", "b");
    const inside = nodePath.relative(base, nodePath.resolve("a", "b", "c.txt"));
    const outside = nodePath.relative(base, nodePath.resolve("a", "d.txt"));
    expect(paths.goesOutside(base, inside)).toBe(false);
    expect(paths.goesOutside(base, outside)).toBe(true);
    expect(paths.goesOutside(base, "..")).toBe(true);
  });

  it("ブラウザ上の作品で、区切りを取り違えない", () => {
    // relative() はURIに対して常に "/" を返す。path.sep（Windowsなら \）
    // で比べると、外を指していても検出できない
    const base = 作品;
    const inside = paths.relative(base, paths.join(base, "本文", "001.txt"));
    const outside = paths.relative(
      base,
      "vscode-vfs://github/nonahisa/another"
    );
    expect(paths.goesOutside(base, inside)).toBe(false);
    expect(paths.goesOutside(base, outside)).toBe(true);
  });
});

describe("Uri との往復", () => {
  it("手元のファイルは、元の書き方に戻る", () => {
    // vscode のスタブが返す fsPath に合わせて確かめる
    const uri = paths.toUri("C:\\Users\\nonah\\a.txt");
    expect(uri.scheme).toBe("file");
    expect(paths.fromUri(uri)).toBe(uri.fsPath);
  });

  it("ブラウザ上の作品は、URIの文字列に戻る", () => {
    const ファイル = paths.join(作品, "本文", "001.txt");
    const uri = paths.toUri(ファイル);
    expect(uri.scheme).toBe("vscode-vfs");
    expect(uri.authority).toBe("github");
    expect(paths.fromUri(uri)).toBe(ファイル);
  });

  it("仕組みが分からないものは、OSのパスに倒す", () => {
    /**
     * **原稿の保存先を決める道に居る関数である。** `toString()` へ倒すと、
     * `Uri` でないものが渡ったときに `"[object Object]"` を静かに作る。
     *
     * 実際に、`.fsPath` を `fromUri()` へ機械的に置き換えたとき、
     * テストの作り物の文書（`uri` に scheme を持たない）で
     * **未保存の検出が丸ごと効かなくなった**（2026-08-21）。
     */
    const schemeless = { fsPath: "C:\\novels\\001.txt" } as never;
    expect(paths.fromUri(schemeless)).toBe("C:\\novels\\001.txt");
  });

  it("日本語のファイル名でも往復する", () => {
    // **URIは記号を伏せ字にする。** 往復で形が変わると別の場所を指す
    const ファイル = paths.join(作品, "本文", "第1話_はじまりの朝.txt");
    expect(paths.fromUri(paths.toUri(ファイル))).toBe(ファイル);
    expect(paths.basename(paths.fromUri(paths.toUri(ファイル)))).toBe(
      "第1話_はじまりの朝.txt"
    );
  });
});
