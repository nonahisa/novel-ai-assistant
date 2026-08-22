import { describe, expect, it } from "vitest";
import {
  describeRepoRef,
  describeRepoRefProblem,
  githubVfsLocation,
  parseGithubRepoRef,
  vscodeDevUrl,
} from "../../src/core/githubRepoRef";

/**
 * GitHubのリポジトリの指し方（設計書5.8.12）。
 *
 * **作者は、そのとき手元にあるものを貼る。** ブラウザのアドレス欄をそのまま
 * 貼ることもあれば、GitHubのページのURL、`git clone` 用のURL、
 * `持ち主/名前` とだけ書くこともある。**どれで来ても同じ場所を指せること**を
 * 見張る。ここを狭くすると、作者は「なぜか受け付けてもらえない」に当たる。
 */

describe("リポジトリの指し方を読む", () => {
  const expected = { owner: "nonahisa", repo: "HisasNovels" };

  it("持ち主/名前 だけでも読める", () => {
    expect(parseGithubRepoRef("nonahisa/HisasNovels")).toEqual(expected);
  });

  it("GitHubのページのURLを貼っても読める", () => {
    expect(parseGithubRepoRef("https://github.com/nonahisa/HisasNovels")).toEqual(
      expected
    );
  });

  it("clone用のURL（.git付き）も読める", () => {
    expect(
      parseGithubRepoRef("https://github.com/nonahisa/HisasNovels.git")
    ).toEqual(expected);
  });

  it("SSHの形も読める", () => {
    expect(
      parseGithubRepoRef("git@github.com:nonahisa/HisasNovels.git")
    ).toEqual(expected);
  });

  /**
   * **これがいちばん貼られやすい。** 作者はブラウザでその画面を開いており、
   * アドレス欄をそのままコピーするのが自然である。
   */
  it("ブラウザのアドレス欄をそのまま貼っても読める", () => {
    expect(
      parseGithubRepoRef("https://vscode.dev/github/nonahisa/HisasNovels")
    ).toEqual(expected);
    expect(
      parseGithubRepoRef(
        "https://vscode.dev/github/nonahisa/HisasNovels?vscode-lang=ja"
      )
    ).toEqual(expected);
  });

  it("github.dev のアドレスも読める", () => {
    expect(
      parseGithubRepoRef("https://github.dev/nonahisa/HisasNovels")
    ).toEqual(expected);
  });

  it("仮想ファイルシステムのURIも読める（診断結果からそのまま貼れる）", () => {
    expect(
      parseGithubRepoRef("vscode-vfs://github/nonahisa/HisasNovels")
    ).toEqual(expected);
  });

  it("ファイルまで開いたURLでも、リポジトリを取り出す", () => {
    expect(
      parseGithubRepoRef(
        "https://github.com/nonahisa/HisasNovels/tree/main/いじめられっ子"
      )
    ).toEqual(expected);
  });

  it("前後の空白は落とす", () => {
    expect(parseGithubRepoRef("  nonahisa/HisasNovels \n")).toEqual(expected);
  });

  it("持ち主だけでは読めない", () => {
    expect(parseGithubRepoRef("nonahisa")).toBeUndefined();
  });

  it("空は読めない", () => {
    expect(parseGithubRepoRef("   ")).toBeUndefined();
  });

  it("名前に使えない文字が入っていれば読めない", () => {
    expect(parseGithubRepoRef("nonahisa/His as")).toBeUndefined();
    expect(parseGithubRepoRef("nona hisa/HisasNovels")).toBeUndefined();
  });

  /**
   * **`..` を通すと、指す場所がずれる。** 名前として受けてはいけない。
   */
  it("親をたどる名前は受けない", () => {
    expect(parseGithubRepoRef("nonahisa/..")).toBeUndefined();
  });
});

describe("入力欄に出す言い方", () => {
  it("空のときは、書き方の例を出す", () => {
    const text = describeRepoRefProblem("");
    expect(text).toBeDefined();
    expect(text).toContain("nonahisa/HisasNovels");
  });

  it("読めたときは何も言わない", () => {
    expect(describeRepoRefProblem("nonahisa/HisasNovels")).toBeUndefined();
    expect(
      describeRepoRefProblem("https://vscode.dev/github/nonahisa/HisasNovels")
    ).toBeUndefined();
  });

  it("読めないときは、直し方が分かる言い方にする", () => {
    const text = describeRepoRefProblem("nonahisa");
    expect(text).toBeDefined();
    expect(text).toContain("持ち主");
  });
});

describe("指し先の組み立て", () => {
  const ref = { owner: "nonahisa", repo: "HisasNovels" };

  it("ブラウザのVS Codeが中身を読む場所", () => {
    expect(githubVfsLocation(ref)).toBe(
      "vscode-vfs://github/nonahisa/HisasNovels"
    );
  });

  it("新しいタブで開くためのアドレス", () => {
    expect(vscodeDevUrl(ref)).toBe(
      "https://vscode.dev/github/nonahisa/HisasNovels"
    );
  });

  it("画面に出す短い名前", () => {
    expect(describeRepoRef(ref)).toBe("nonahisa/HisasNovels");
  });

  /** 組み立てたものを読み直しても同じ場所を指す（往復して壊れない） */
  it("組み立てた場所を読み直しても同じ", () => {
    expect(parseGithubRepoRef(githubVfsLocation(ref))).toEqual(ref);
    expect(parseGithubRepoRef(vscodeDevUrl(ref))).toEqual(ref);
  });
});
