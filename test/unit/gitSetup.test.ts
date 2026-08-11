import { describe, expect, test, vi } from "vitest";

vi.mock("vscode", () => ({
  window: {},
  workspace: { getConfiguration: () => ({ get: () => undefined }) },
  commands: {},
  StatusBarAlignment: { Right: 2 },
  EventEmitter: class {
    event = () => ({ dispose() {} });
    fire() {}
    dispose() {}
  },
}));

import {
  DEFAULT_BRANCH,
  commitAll,
  currentBranch,
  describeNetworkFailure,
  hasCommitIdentity,
  initRepository,
  pushSetUpstream,
  suggestRepositoryName,
  validateRepositoryUrl,
} from "../../src/core/gitSetup";
import {
  canRecordChanges,
  nextSetupStep,
} from "../../src/features/gitOnboarding";
import type { GitCommandResult, GitCommandRunner } from "../../src/core/git";

/** 呼ばれたコマンドを記録する差し替え口 */
function runner(
  responses: Array<Partial<GitCommandResult>> = []
): GitCommandRunner & { calls: string[][] } {
  const calls: string[][] = [];
  const run = (async (args: string[]) => {
    calls.push(args);
    const next = responses.shift() ?? {};
    return { code: next.code ?? 0, stdout: next.stdout ?? "", stderr: next.stderr ?? "" };
  }) as GitCommandRunner & { calls: string[][] };
  run.calls = calls;
  return run;
}

describe("リポジトリを作る", () => {
  test("既定ブランチを main にする", async () => {
    const run = runner();

    await initRepository("C:/work", run);

    expect(run.calls[0]).toEqual(["init", "-b", DEFAULT_BRANCH]);
  });

  test("-b を使えない古いGitでも main に揃える", async () => {
    // Git 2.28 より前は init -b が無い。失敗したら参照を書き換える
    const run = runner([{ code: 129 }, { code: 0 }, { code: 0 }]);

    const result = await initRepository("C:/work", run);

    expect(result.ok).toBe(true);
    expect(run.calls[1]).toEqual(["init"]);
    expect(run.calls[2]).toEqual([
      "symbolic-ref",
      "HEAD",
      `refs/heads/${DEFAULT_BRANCH}`,
    ]);
  });

  test("名前かメールが空なら未設定として扱う", async () => {
    expect(
      await hasCommitIdentity("C:/w", runner([{ stdout: "作者\n" }, { stdout: "" }]))
    ).toBe(false);
    expect(
      await hasCommitIdentity(
        "C:/w",
        runner([{ stdout: "作者\n" }, { stdout: "a@example.com\n" }])
      )
    ).toBe(true);
  });

  test("初回コミットは全部を対象にする", async () => {
    const run = runner();

    await commitAll("C:/work", "初回コミット: 作品", run);

    expect(run.calls[0]).toEqual(["add", "-A"]);
    expect(run.calls[1]).toEqual(["commit", "-m", "初回コミット: 作品"]);
  });

  test("初回の送信は上流を設定する", async () => {
    const run = runner();

    await pushSetUpstream("C:/work", "main", run);

    expect(run.calls[0]).toEqual(["push", "-u", "origin", "main"]);
  });

  test("ブランチ名を取れなければ main とみなす", async () => {
    expect(await currentBranch("C:/w", runner([{ code: 128 }]))).toBe("main");
  });
});

describe("リポジトリURLの検査", () => {
  test.each([
    "https://github.com/nonahisa/novel.git",
    "https://github.com/nonahisa/novel",
    "git@github.com:nonahisa/novel.git",
    "ssh://git@github.com/nonahisa/novel.git",
  ])("%s は通す", (url) => {
    expect(validateRepositoryUrl(url)).toBeUndefined();
  });

  test.each(["", "  ", "github.com/nonahisa/novel", "https://github.com/nonahisa"])(
    "%s は断る",
    (url) => {
      // 打ち間違いのまま登録すると、送信のたびに失敗して原因が分かりにくい
      expect(validateRepositoryUrl(url)).toBeTruthy();
    }
  );
});

describe("リポジトリ名の候補", () => {
  test("英数字の作品名はそのまま使える形にする", () => {
    expect(suggestRepositoryName("My Novel 2")).toBe("My-Novel-2");
  });

  test("日本語の作品名からは作らない（勝手にローマ字へ直さない）", () => {
    expect(suggestRepositoryName("いじめられっ子")).toBe("");
  });
});

describe("失敗の理由を言い分ける", () => {
  test.each([
    "fatal: unable to access 'https://github.com/x/y.git/': Could not resolve host: github.com",
    "ssh: connect to host github.com port 22: Network is unreachable",
    "fatal: unable to access '...': Failed to connect to github.com port 443 after 21000 ms",
  ])("つながらない: %s", (detail) => {
    expect(describeNetworkFailure(detail)).toContain(
      "インターネットにつながっていない"
    );
  });

  test.each([
    "remote: Support for password authentication was removed. fatal: Authentication failed for 'https://github.com/x/y.git/'",
    "git@github.com: Permission denied (publickey).",
    "fatal: could not read from remote repository.",
  ])("ログインできない: %s", (detail) => {
    expect(describeNetworkFailure(detail)).toContain("ログインができませんでした");
  });

  test("送り先が無い", () => {
    expect(describeNetworkFailure("remote: Repository not found.")).toContain(
      "リポジトリが見つかりません"
    );
  });

  test("判定できないものは言い換えない（生の理由を見せる）", () => {
    // 当てにいって外すより、gitの言い分をそのまま見せるほうが害が小さい
    expect(describeNetworkFailure("error: pathspec 'x' did not match")).toBeUndefined();
    expect(describeNetworkFailure(undefined)).toBeUndefined();
    expect(describeNetworkFailure("")).toBeUndefined();
  });
});

describe("状態に応じた次の一手", () => {
  test("リポジトリでなければ、始める操作を出す", () => {
    expect(nextSetupStep({ kind: "not_a_repo" })?.label).toContain(
      "Gitで管理を始める"
    );
  });

  test("リモートが無ければ、つなぐ操作を出す", () => {
    expect(nextSetupStep({ kind: "no_remote", root: "C:/w" })?.label).toContain(
      "GitHubのリポジトリとつなぐ"
    );
  });

  test("上流が無ければ、はじめての送信を出す", () => {
    expect(
      nextSetupStep({ kind: "no_upstream", root: "C:/w", branch: "main" })?.label
    ).toContain("はじめて送信する");
  });

  test("同期済みなら何も出さない", () => {
    expect(
      nextSetupStep({
        kind: "tracked",
        root: "C:/w",
        branch: "main",
        upstream: "origin/main",
        behind: 0,
        ahead: 0,
        dirty: 0,
        unmerged: 0,
      })
    ).toBeUndefined();
  });

  test("gitが無ければ、導入の案内を出す", () => {
    // 「見つかりません」で終わると、作者はそこから進めない
    expect(nextSetupStep({ kind: "git_missing" })?.label).toContain(
      "Gitを導入するには"
    );
  });
});

describe("変更を記録できる状態か", () => {
  test("送り先が無くても記録できる（GitHubを使わない作者のため）", () => {
    expect(canRecordChanges({ kind: "no_remote", root: "C:/w" })).toBe(true);
  });

  test("まだリポジトリでなければ記録できない", () => {
    expect(canRecordChanges({ kind: "not_a_repo" })).toBe(false);
    expect(canRecordChanges({ kind: "git_missing" })).toBe(false);
  });
});
