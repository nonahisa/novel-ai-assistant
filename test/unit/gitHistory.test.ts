import { describe, expect, test } from "vitest";
import {
  isEmptyPlan,
  listCommits,
  parseCommitLog,
  parseNameStatus,
  planRestore,
  restoreToCommit,
} from "../../src/core/gitHistory";
import { folderNameFromUrl, looksLikeAuthFailure } from "../../src/core/gitClone";
import type { GitCommandResult, GitCommandRunner } from "../../src/core/git";

const UNIT = String.fromCharCode(31);

/** gitの代わり。呼ばれた引数を覚えて、決めた答えを返す */
function fakeGit(
  answers: Array<Partial<GitCommandResult>>
): GitCommandRunner & { calls: string[][] } {
  const calls: string[][] = [];
  let index = 0;
  const run = (async (args: string[]) => {
    calls.push(args);
    const answer = answers[Math.min(index++, answers.length - 1)] ?? {};
    return { code: 0, stdout: "", stderr: "", ...answer };
  }) as GitCommandRunner & { calls: string[][] };
  run.calls = calls;
  return run;
}

describe("履歴を読む", () => {
  test("日時・件名つきで新しい順に読む", () => {
    const entries = parseCommitLog(
      [
        `abc123def456${UNIT}abc123d${UNIT}2026-08-14 21:03${UNIT}第12話を書いた`,
        `0011223344ff${UNIT}0011223${UNIT}2026-08-13 09:15${UNIT}誤字を直した`,
        "",
      ].join("\n")
    );

    expect(entries).toEqual([
      {
        id: "abc123def456",
        shortId: "abc123d",
        date: "2026-08-14 21:03",
        subject: "第12話を書いた",
      },
      {
        id: "0011223344ff",
        shortId: "0011223",
        date: "2026-08-13 09:15",
        subject: "誤字を直した",
      },
    ]);
  });

  test("件名が空でも落とさない", () => {
    // 件名の無いコミットは作れてしまう。読めないと履歴ごと出せなくなる
    const entries = parseCommitLog(`aaa${UNIT}aaa${UNIT}2026-08-14 21:03${UNIT}`);

    expect(entries).toHaveLength(1);
    expect(entries[0].subject).toBe("");
  });

  test("gitが失敗したら空にする", async () => {
    const run = fakeGit([{ code: 128, stderr: "not a git repository" }]);

    expect(await listCommits("C:\\work", 30, run)).toEqual([]);
  });
});

describe("戻すと何が起きるかを数える", () => {
  test("増えた・消えた・変わったを分ける", () => {
    // その版から今への向きで付くので、A（今しか無い）は戻すと消える側
    const plan = parseNameStatus(
      ["M", "本文/001.txt", "A", "本文/012.txt", "D", "設定/plot.md"].join("\0")
    );

    expect(plan.changed).toEqual(["本文/001.txt"]);
    expect(plan.addedSince).toEqual(["本文/012.txt"]);
    expect(plan.removedSince).toEqual(["設定/plot.md"]);
  });

  test("改名は「元が戻り、今の名前が消える」として数える", () => {
    const plan = parseNameStatus(
      ["R100", "本文/001.txt", "本文/001_出会い.txt"].join("\0")
    );

    expect(plan.removedSince).toEqual(["本文/001.txt"]);
    expect(plan.addedSince).toEqual(["本文/001_出会い.txt"]);
  });

  test("同じ内容なら空になる", async () => {
    const run = fakeGit([{ stdout: "" }]);
    const plan = await planRestore("C:\\work", "abc123", run);

    expect(isEmptyPlan(plan)).toBe(true);
  });
});

describe("過去の版へ戻す", () => {
  test("書き戻したあと、その版に無いファイルを消す", async () => {
    // checkoutだけでは「あとで増えたファイル」が残り、戻したことにならない
    const run = fakeGit([{ code: 0 }, { code: 0 }]);

    const result = await restoreToCommit(
      "C:\\work",
      "abc123",
      { changed: ["本文/001.txt"], addedSince: ["本文/012.txt"], removedSince: [] },
      run
    );

    expect(result.ok).toBe(true);
    expect(run.calls[0]).toEqual(["checkout", "abc123", "--", "."]);
    expect(run.calls[1]).toEqual([
      "rm",
      "--force",
      "--quiet",
      "--",
      "本文/012.txt",
    ]);
  });

  test("消すファイルが無ければ、消す操作は呼ばない", async () => {
    const run = fakeGit([{ code: 0 }]);

    await restoreToCommit(
      "C:\\work",
      "abc123",
      { changed: ["本文/001.txt"], addedSince: [], removedSince: [] },
      run
    );

    expect(run.calls).toHaveLength(1);
  });

  test("書き戻せなければ理由を返す", async () => {
    const run = fakeGit([{ code: 1, stderr: "error: pathspec did not match" }]);

    const result = await restoreToCommit(
      "C:\\work",
      "abc123",
      { changed: [], addedSince: [], removedSince: [] },
      run
    );

    expect(result.ok).toBe(false);
    expect(result.detail).toContain("pathspec");
  });
});

describe("GitHubから取り寄せる", () => {
  test("URLからフォルダー名を決める", () => {
    expect(folderNameFromUrl("https://github.com/nonahisa/my-novel.git")).toBe(
      "my-novel"
    );
    expect(folderNameFromUrl("https://github.com/nonahisa/my-novel/")).toBe(
      "my-novel"
    );
    expect(folderNameFromUrl("git@github.com:nonahisa/my-novel.git")).toBe(
      "my-novel"
    );
  });

  test("フォルダー名に使えない文字は落とす", () => {
    expect(folderNameFromUrl("https://example.com/user/no:vel")).toBe("novel");
  });

  test("認証で断られたかを見分ける", () => {
    // 非公開のリポジトリは、認証を聞かれた時点で失敗する。
    // 判定を外しても案内が1つ増えるだけで、原稿には影響しない
    expect(
      looksLikeAuthFailure("fatal: could not read Username for 'https://github.com'")
    ).toBe(true);
    expect(looksLikeAuthFailure("remote: Repository not found.")).toBe(true);
    expect(looksLikeAuthFailure("fatal: unable to access: Could not resolve host")).toBe(
      false
    );
  });
});
