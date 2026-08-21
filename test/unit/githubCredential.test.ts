import { describe, it, expect } from "vitest";
import { parseHttpsRemote } from "../../src/core/gitSetup";

/**
 * VS Codeのアカウントで得た鍵を、git側にも覚えさせる（設計書5.5.12）。
 *
 * **「VS Codeのアカウントを使う」と答えたのに、送信でまた聞かれた**
 * （2026-08-21、作者が実機で発見）。リポジトリを作るのはGitHubのAPIで、
 * 送るのは別プロセスの git なので、鍵が引き継がれていなかった。
 *
 * **URLの読み違いは、別のアカウントの保管場所へ鍵を書くことになる。**
 * ここは慎重に確かめる。
 */
describe("送り先のURLから、ホストと所有者を取り出す", () => {
  it("GitHubの標準的なURL", () => {
    expect(parseHttpsRemote("https://github.com/nonahisa/novel.git")).toEqual({
      host: "github.com",
      owner: "nonahisa",
    });
  });

  it("末尾の .git が無くても読める", () => {
    expect(parseHttpsRemote("https://github.com/nonahisa/novel")).toEqual({
      host: "github.com",
      owner: "nonahisa",
    });
  });

  it("末尾のスラッシュを許す", () => {
    expect(parseHttpsRemote("https://github.com/nonahisa/novel/")).toEqual({
      host: "github.com",
      owner: "nonahisa",
    });
  });

  it("前後の空白を落とす", () => {
    expect(parseHttpsRemote("  https://github.com/a/b.git  ")).toEqual({
      host: "github.com",
      owner: "a",
    });
  });

  it("GitHub Enterprise でもホストを取り違えない", () => {
    // 別のホストの保管場所へ書かないため、ホストはURLから取る
    expect(parseHttpsRemote("https://ghe.example.co.jp/team/novel.git")).toEqual(
      { host: "ghe.example.co.jp", owner: "team" }
    );
  });

  it("SSHの形は扱わない", () => {
    // 鍵の渡し方が違う。ここで無理に扱うと別物へ書く
    expect(parseHttpsRemote("git@github.com:nonahisa/novel.git")).toBeUndefined();
  });

  it("httpは扱わない", () => {
    // 暗号化されていない経路へ鍵を渡さない
    expect(parseHttpsRemote("http://github.com/a/b.git")).toBeUndefined();
  });

  it("所有者までしか無いURLは扱わない", () => {
    expect(parseHttpsRemote("https://github.com/nonahisa")).toBeUndefined();
  });

  it("階層が深いURLは扱わない", () => {
    // 想定していない形を推測で通さない
    expect(
      parseHttpsRemote("https://github.com/a/b/c.git")
    ).toBeUndefined();
  });

  it("URLでないものは扱わない", () => {
    expect(parseHttpsRemote("")).toBeUndefined();
    expect(parseHttpsRemote("ただの文字列")).toBeUndefined();
  });
});
