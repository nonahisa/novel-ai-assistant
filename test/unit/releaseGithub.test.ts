import { describe, expect, test } from "vitest";

/**
 * `scripts/releaseGithub.mjs` の**判断の部分だけ**を確かめる。
 *
 * gh も git も実際には呼ばない。呼ぶ側（`run`）はスクリプトの中に閉じており、
 * ここで読み込んでも動かない（`process.argv[1]` を見る入口の番人がある）。
 */
type Command = { command: string; args: string[] };

const releaseGithub = (await import("../../scripts/releaseGithub.mjs")) as {
  parseReleaseArguments(argv: string[]): {
    dryRun: boolean;
    skipVerify: boolean;
    notesPath?: string;
  };
  extractChangelogSection(changelogText: string, version: string): string;
  evaluatePrerequisites(state: {
    workingTreeStatus: string;
    currentBranch: string;
    headCommit: string;
    remoteCommit: string;
    tagCommit: string;
    ghAuthenticated: boolean;
    ghAuthMessage?: string;
    version: string;
    dryRun: boolean;
  }): { problems: string[]; warnings: string[]; tagExists: boolean };
  buildTagCommands(tag: string, message: string): Command[];
  buildGithubReleaseCommands(input: {
    tag: string;
    vsixPath: string;
    notesPath: string;
    releaseExists: boolean;
  }): Command[];
  buildReleaseUrl(repositoryUrl: string | undefined, tag: string): string;
  formatCommand(command: Command): string;
};

const cleanState = {
  workingTreeStatus: "",
  currentBranch: "main",
  headCommit: "abc123",
  remoteCommit: "abc123",
  tagCommit: "",
  ghAuthenticated: true,
  version: "1.2.3",
  dryRun: false,
};

describe("引数の解釈", () => {
  test("既定はどれも立っていない", () => {
    expect(releaseGithub.parseReleaseArguments([])).toEqual({
      dryRun: false,
      skipVerify: false,
      notesPath: undefined,
    });
  });

  test("--dry-run と --skip-verify を受ける", () => {
    const options = releaseGithub.parseReleaseArguments([
      "--dry-run",
      "--skip-verify",
    ]);
    expect(options.dryRun).toBe(true);
    expect(options.skipVerify).toBe(true);
  });

  test("--notes は空白区切りでも = でも受ける", () => {
    expect(
      releaseGithub.parseReleaseArguments(["--notes", "notes.md"]).notesPath
    ).toBe("notes.md");
    expect(
      releaseGithub.parseReleaseArguments(["--notes=notes.md"]).notesPath
    ).toBe("notes.md");
  });

  test("--notes の値が抜けていれば止める", () => {
    expect(() =>
      releaseGithub.parseReleaseArguments(["--notes", "--dry-run"])
    ).toThrow("--notes にはリリースノートのファイル");
    expect(() => releaseGithub.parseReleaseArguments(["--notes="])).toThrow(
      "--notes にはリリースノートのファイル"
    );
  });

  test("知らない引数は黙って無視せず止める", () => {
    expect(() => releaseGithub.parseReleaseArguments(["--publish"])).toThrow(
      "知らない引数です: --publish"
    );
  });
});

describe("CHANGELOGからの節の切り出し", () => {
  const changelog = [
    "# Change Log",
    "",
    "## 0.33.10 - 2026-09-05",
    "",
    "### 見出し",
    "",
    "- 直したこと",
    "",
    "## 0.33.1 - 2026-09-04",
    "",
    "- 前の版",
    "",
  ].join("\n");

  test("見出し行を落として、その版の中身だけを返す", () => {
    expect(releaseGithub.extractChangelogSection(changelog, "0.33.10")).toBe(
      "### 見出し\n\n- 直したこと"
    );
  });

  test("次の ## の手前で止まる（前の版を巻き込まない）", () => {
    expect(
      releaseGithub.extractChangelogSection(changelog, "0.33.10")
    ).not.toContain("前の版");
  });

  test("0.33.1 は 0.33.10 に当たらない", () => {
    expect(releaseGithub.extractChangelogSection(changelog, "0.33.1")).toBe(
      "- 前の版"
    );
  });

  test("節が無ければ止める", () => {
    expect(() =>
      releaseGithub.extractChangelogSection(changelog, "0.34.0")
    ).toThrow("CHANGELOG.md に 0.34.0 の節がありません");
  });

  test("節が空なら止める（中身の無いリリースノートを出さない）", () => {
    expect(() =>
      releaseGithub.extractChangelogSection(
        "## 1.0.0 - 2026-01-01\n\n## 0.9.0 - 2025-12-31\n\n- 何か\n",
        "1.0.0"
      )
    ).toThrow("CHANGELOG.md の 1.0.0 の節が空です");
  });
});

describe("前提の確認", () => {
  test("すべて満たしていれば止めない", () => {
    const result = releaseGithub.evaluatePrerequisites(cleanState);
    expect(result.problems).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.tagExists).toBe(false);
  });

  test("未コミットの変更があれば止める", () => {
    const result = releaseGithub.evaluatePrerequisites({
      ...cleanState,
      workingTreeStatus: " M src/extension.ts\n",
    });
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toContain("未コミットの変更");
    expect(result.problems[0]).toContain("src/extension.ts");
  });

  test("main 以外の枝では止める", () => {
    const result = releaseGithub.evaluatePrerequisites({
      ...cleanState,
      currentBranch: "feature/x",
    });
    expect(result.problems[0]).toContain("feature/x");
  });

  test("push が済んでいなければ止める", () => {
    const result = releaseGithub.evaluatePrerequisites({
      ...cleanState,
      remoteCommit: "def456",
    });
    expect(result.problems[0]).toContain("origin/main と一致していません");
  });

  test("origin/main が取れなければ止める", () => {
    const result = releaseGithub.evaluatePrerequisites({
      ...cleanState,
      remoteCommit: "",
    });
    expect(result.problems[0]).toContain("git fetch origin");
  });

  test("gh が未ログインなら止める", () => {
    const result = releaseGithub.evaluatePrerequisites({
      ...cleanState,
      ghAuthenticated: false,
      ghAuthMessage: "ログインしてください",
    });
    expect(result.problems).toEqual(["ログインしてください"]);
  });

  test("--dry-run のときだけ、gh の未ログインは警告に落とす", () => {
    const result = releaseGithub.evaluatePrerequisites({
      ...cleanState,
      ghAuthenticated: false,
      ghAuthMessage: "ログインしてください",
      dryRun: true,
    });
    expect(result.problems).toEqual([]);
    expect(result.warnings).toEqual(["ログインしてください"]);
  });

  test("同じコミットを指すタグは作り直さない（止めもしない）", () => {
    const result = releaseGithub.evaluatePrerequisites({
      ...cleanState,
      tagCommit: "abc123",
    });
    expect(result.problems).toEqual([]);
    expect(result.tagExists).toBe(true);
  });

  test("別のコミットを指すタグがあれば止める", () => {
    const result = releaseGithub.evaluatePrerequisites({
      ...cleanState,
      tagCommit: "old999",
    });
    expect(result.problems[0]).toContain("タグ v1.2.3 は既にあり");
  });

  test("満たさないものは1つずつではなく、まとめて出す", () => {
    const result = releaseGithub.evaluatePrerequisites({
      ...cleanState,
      workingTreeStatus: " M a.ts\n",
      currentBranch: "work",
      ghAuthenticated: false,
    });
    expect(result.problems).toHaveLength(3);
  });
});

describe("組み立てるコマンド", () => {
  test("タグは注釈つきで作り、origin へ押す", () => {
    expect(releaseGithub.buildTagCommands("v1.2.3", "作品 v1.2.3")).toEqual([
      { command: "git", args: ["tag", "-a", "v1.2.3", "-m", "作品 v1.2.3"] },
      { command: "git", args: ["push", "origin", "v1.2.3"] },
    ]);
  });

  test("リリースが無ければ create（--target は渡さない）", () => {
    const commands = releaseGithub.buildGithubReleaseCommands({
      tag: "v1.2.3",
      vsixPath: "/repo/release/app-1.2.3.vsix",
      notesPath: "/repo/release/v1.2.3-notes.md",
      releaseExists: false,
    });
    expect(commands).toEqual([
      {
        command: "gh",
        args: [
          "release",
          "create",
          "v1.2.3",
          "/repo/release/app-1.2.3.vsix",
          "--title",
          "v1.2.3",
          "--notes-file",
          "/repo/release/v1.2.3-notes.md",
        ],
      },
    ]);
    expect(commands[0].args).not.toContain("--target");
  });

  test("リリースが既にあれば、資産とノートを差し替える", () => {
    expect(
      releaseGithub.buildGithubReleaseCommands({
        tag: "v1.2.3",
        vsixPath: "/repo/release/app-1.2.3.vsix",
        notesPath: "/repo/release/v1.2.3-notes.md",
        releaseExists: true,
      })
    ).toEqual([
      {
        command: "gh",
        args: [
          "release",
          "upload",
          "v1.2.3",
          "/repo/release/app-1.2.3.vsix",
          "--clobber",
        ],
      },
      {
        command: "gh",
        args: ["release", "edit", "v1.2.3", "--notes-file", "/repo/release/v1.2.3-notes.md"],
      },
    ]);
  });

  test("表示は、空白を含む引数だけ引用符で囲む", () => {
    expect(
      releaseGithub.formatCommand({
        command: "git",
        args: ["tag", "-a", "v1.2.3", "-m", "統合小説執筆環境 v1.2.3"],
      })
    ).toBe('git tag -a v1.2.3 -m "統合小説執筆環境 v1.2.3"');
  });
});

describe("リリースのURL", () => {
  test("package.json の repository.url から組み立てる", () => {
    expect(
      releaseGithub.buildReleaseUrl(
        "https://github.com/nonahisa/novel-ai-assistant.git",
        "v0.33.10"
      )
    ).toBe("https://github.com/nonahisa/novel-ai-assistant/releases/tag/v0.33.10");
  });

  test("git+ の接頭辞と末尾のスラッシュを落とす", () => {
    expect(
      releaseGithub.buildReleaseUrl("git+https://github.com/a/b/", "v1.0.0")
    ).toBe("https://github.com/a/b/releases/tag/v1.0.0");
  });

  test("repository.url が無ければ止める", () => {
    expect(() => releaseGithub.buildReleaseUrl(undefined, "v1.0.0")).toThrow(
      "repository.url がありません"
    );
  });
});
