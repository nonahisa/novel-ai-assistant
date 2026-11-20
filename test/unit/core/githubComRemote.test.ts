import { describe, expect, test, vi } from "vitest";

/*
  **本物の `git credential approve` を走らせない。** 走ると、作り物の鍵が
  この PC の資格情報マネージャーへ本当に入る。子プロセスの口を差し替え、呼ばれた形だけ控える
*/
const execCalls = vi.hoisted(() => [] as Array<{ args: string[]; input: string }>);
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFile: (_file: string, args: string[], _options: unknown, callback: (error: Error | null) => void) => {
      const call = { args, input: "" };
      execCalls.push(call);
      setTimeout(() => callback(null), 0);
      return { stdin: { end: (text: string) => (call.input = text) } };
    },
  };
});

const { githubComRepoRef } = await import("../../../src/core/githubRepoRef");
const { rememberGithubCredential } = await import("../../../src/core/gitSetup");

/**
 * 編集部へ渡すときの送り先（`.aiwriter/editing.json` の `remoteUrl`）は、同期される
 * 作品フォルダーから読む。書き換えられていれば、GitHub の鍵を別のホストへ覚えさせて
 * 送ってしまう（セキュリティ点検 2026-11-21）。**github.com と確かめてから使う。**
 */
describe("github.com のリポジトリか（githubComRepoRef）", () => {
  test("github.com の取り寄せ用の URL は読む", () => {
    expect(githubComRepoRef("https://github.com/nonahisa/novel-editing.git")).toEqual({
      owner: "nonahisa",
      repo: "novel-editing",
    });
    expect(githubComRepoRef("https://GitHub.com/a/b")).toEqual({ owner: "a", repo: "b" });
    expect(githubComRepoRef("git@github.com:a/b.git")).toEqual({ owner: "a", repo: "b" });
  });

  test("github.com 以外のホストは読まない（owner/repo の形でも化けさせない）", () => {
    expect(githubComRepoRef("https://evil.example/a/b.git")).toBeUndefined();
    expect(githubComRepoRef("https://github.com.evil.example/a/b.git")).toBeUndefined();
    expect(githubComRepoRef("https://github.com@evil.example/a/b.git")).toBeUndefined();
    expect(githubComRepoRef("https://ghe.example.co.jp/team/novel.git")).toBeUndefined();
    expect(githubComRepoRef("git@evil.example:a/b.git")).toBeUndefined();
  });

  test("鍵の入った URL・http・ポート付き・余計な階層は読まない", () => {
    expect(githubComRepoRef("https://token@github.com/a/b.git")).toBeUndefined();
    expect(githubComRepoRef("http://github.com/a/b.git")).toBeUndefined();
    expect(githubComRepoRef("https://github.com:8443/a/b.git")).toBeUndefined();
    expect(githubComRepoRef("https://github.com/a/b/c.git")).toBeUndefined();
    expect(githubComRepoRef("C:/書庫/x.git")).toBeUndefined();
  });
});

describe("鍵を覚えさせるのは github.com だけ（rememberGithubCredential）", () => {
  test("github.com 以外のホストなら、git を呼ばずに断る", async () => {
    execCalls.length = 0;
    expect(await rememberGithubCredential("dummy-token-123456", "https://evil.example/a/b.git", ".")).toBe(false);
    expect(execCalls).toEqual([]);
  });

  test("github.com なら、ホストを github.com にして渡す", async () => {
    execCalls.length = 0;
    expect(await rememberGithubCredential("dummy-token-123456", "https://github.com/a/b.git", ".")).toBe(true);
    expect(execCalls).toHaveLength(1);
    expect(execCalls[0].input).toContain("host=github.com\n");
  });
});
