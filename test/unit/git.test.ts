import { afterAll, beforeAll, describe, expect, test } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  fetchRemote,
  isGitAvailable,
  parseAheadBehind,
  parseStatusPorcelain,
  pullFastForward,
  readSyncStatus,
  runGit,
  type GitCommandResult,
  type GitCommandRunner,
} from "../../src/core/git";
import {
  describeStatus,
  describeSyncBadge,
  isWarning,
} from "../../src/features/gitSync";

/** 応答を並べておくだけの偽git。引数の並びで返す値を決める */
function fakeGit(
  responses: Record<string, Partial<GitCommandResult>>
): GitCommandRunner {
  return async (args) => {
    const key = args.join(" ");
    const matched =
      responses[key] ??
      Object.entries(responses).find(([prefix]) =>
        key.startsWith(prefix)
      )?.[1];
    return {
      code: matched?.code ?? 0,
      stdout: matched?.stdout ?? "",
      stderr: matched?.stderr ?? "",
    };
  };
}

const TRACKED_BASE = {
  "rev-parse --is-inside-work-tree": { stdout: "true\n" },
  "rev-parse --show-toplevel": { stdout: "/work\n" },
  remote: { stdout: "origin\n" },
  "symbolic-ref --quiet --short HEAD": { stdout: "main\n" },
  "rev-parse --abbrev-ref --symbolic-full-name @{upstream}": {
    stdout: "origin/main\n",
  },
  "rev-list --left-right --count": { stdout: "0\t0\n" },
  "status --porcelain": { stdout: "" },
};

describe("コミット数の解析", () => {
  test("左が未取得、右が未送信になる", () => {
    // git rev-list --left-right --count <upstream>...HEAD の並び。
    // 取り違えると「取り込め」と「送れ」が逆に出る
    expect(parseAheadBehind("3\t2\n")).toEqual({ behind: 3, ahead: 2 });
  });

  test("空白区切りでも読める", () => {
    expect(parseAheadBehind("  0   5  ")).toEqual({ behind: 0, ahead: 5 });
  });

  test("想定外の出力は数として扱わない", () => {
    // 適当な数を作ると「未送信0件」と嘘をつくことになる
    expect(parseAheadBehind("fatal: bad revision")).toBeUndefined();
    expect(parseAheadBehind("")).toBeUndefined();
  });
});

describe("作業ツリーの状態の解析", () => {
  test("未追跡ファイルも変更として数える", () => {
    // 新しい話を書いてまだ追加していない状態。
    // 送信し忘れると失われるので、変更として扱う
    const result = parseStatusPorcelain("?? 本文/020.txt\n M 本文/019.txt\n");

    expect(result.dirty).toBe(2);
    expect(result.unmerged).toBe(0);
  });

  test("マージ未解決を数える", () => {
    const result = parseStatusPorcelain(
      "UU 本文/008.txt\nAA 設定/characters/char_001.json\n M 本文/009.txt\n"
    );

    expect(result.unmerged).toBe(2);
    expect(result.dirty).toBe(3);
  });

  test("片側だけがUでも未解決とする", () => {
    expect(parseStatusPorcelain("AU 本文/008.txt\n").unmerged).toBe(1);
    expect(parseStatusPorcelain("UD 本文/008.txt\n").unmerged).toBe(1);
  });

  test("CRLFと空行を数に入れない", () => {
    const result = parseStatusPorcelain(" M 本文/019.txt\r\n\r\n");

    expect(result.dirty).toBe(1);
  });

  test("変更が無ければ0件", () => {
    expect(parseStatusPorcelain("")).toEqual({ dirty: 0, unmerged: 0 });
  });
});

describe("同期状態の判定", () => {
  test("Gitリポジトリでなければ、その旨だけを返す", async () => {
    // Gitを使わずに書いている作品は異常ではない。
    // 警告として出すと、消せない表示が残り続ける
    const run = fakeGit({
      "rev-parse --is-inside-work-tree": { code: 128 },
      "--version": { stdout: "git version 2.55.0\n" },
    });

    const status = await readSyncStatus("/work", run);

    expect(status.kind).toBe("not_a_repo");
    expect(isWarning(status)).toBe(false);
  });

  test("gitコマンドが無い場合と、リポジトリでない場合を分ける", async () => {
    const run = fakeGit({
      "rev-parse --is-inside-work-tree": { code: 128 },
      "--version": { code: -1 },
    });

    expect((await readSyncStatus("/work", run)).kind).toBe("git_missing");
  });

  test("リモート未設定は警告にしない", async () => {
    const run = fakeGit({ ...TRACKED_BASE, remote: { stdout: "" } });

    const status = await readSyncStatus("/work", run);

    expect(status.kind).toBe("no_remote");
    expect(isWarning(status)).toBe(false);
  });

  test("上流の無いブランチを判別する", async () => {
    const run = fakeGit({
      ...TRACKED_BASE,
      "rev-parse --abbrev-ref --symbolic-full-name @{upstream}": { code: 128 },
    });

    const status = await readSyncStatus("/work", run);

    expect(status).toMatchObject({ kind: "no_upstream", branch: "main" });
  });

  test("切り離されたHEADを判別する", async () => {
    const run = fakeGit({
      ...TRACKED_BASE,
      "symbolic-ref --quiet --short HEAD": { code: 1 },
    });

    expect((await readSyncStatus("/work", run)).kind).toBe("detached");
  });

  test("未取得・未送信・競合を数える", async () => {
    const run = fakeGit({
      ...TRACKED_BASE,
      "rev-list --left-right --count": { stdout: "3\t2\n" },
      "status --porcelain": { stdout: "UU 本文/008.txt\n?? 本文/020.txt\n" },
    });

    const status = await readSyncStatus("/work", run);

    expect(status).toMatchObject({
      kind: "tracked",
      branch: "main",
      upstream: "origin/main",
      behind: 3,
      ahead: 2,
      dirty: 2,
      unmerged: 1,
    });
    expect(isWarning(status)).toBe(true);
  });

  test("同期が取れていれば警告にしない", async () => {
    const run = fakeGit(TRACKED_BASE);

    const status = await readSyncStatus("/work", run);

    expect(isWarning(status)).toBe(false);
    expect(describeSyncBadge(status)).toBeUndefined();
  });

  test("遅れと未送信をツリー用の短い印にする", async () => {
    const run = fakeGit({
      ...TRACKED_BASE,
      "rev-list --left-right --count": { stdout: "3\t2\n" },
    });

    expect(describeSyncBadge(await readSyncStatus("/work", run))).toBe("↓3 ↑2");
  });
});

describe("取り込みの安全確認", () => {
  test("未コミットの変更があるときは取り込まない", async () => {
    // 書きかけの原稿を巻き込まないため、gitに任せず先に止める
    const executed: string[] = [];
    const base = fakeGit({
      ...TRACKED_BASE,
      "status --porcelain": { stdout: " M 本文/019.txt\n" },
    });
    const run: GitCommandRunner = async (args, cwd, timeout) => {
      executed.push(args.join(" "));
      return base(args, cwd, timeout);
    };

    const result = await pullFastForward("/work", run);

    expect(result).toEqual({ ok: false, failure: { kind: "dirty" } });
    expect(executed).not.toContain("pull --ff-only");
  });

  test("早送りできない場合は、どちらを残すか決めない", async () => {
    // 両方の環境で書いた状態。機械が解決してよい話ではない
    const run = fakeGit({
      ...TRACKED_BASE,
      "rev-list --left-right --count": { stdout: "2\t3\n" },
      "pull --ff-only": { code: 128, stderr: "fatal: Not possible to fast-forward" },
    });

    const result = await pullFastForward("/work", run);

    expect(result).toEqual({ ok: false, failure: { kind: "diverged" } });
  });

  test("マージコミットを勝手に作らせない", async () => {
    const executed: string[] = [];
    const base = fakeGit(TRACKED_BASE);
    const run: GitCommandRunner = async (args, cwd, timeout) => {
      executed.push(args.join(" "));
      return base(args, cwd, timeout);
    };

    await pullFastForward("/work", run);

    expect(executed).toContain("pull --ff-only");
    expect(executed.join("\n")).not.toContain("--no-ff");
  });
});

describe("状態の説明文", () => {
  test("リポジトリでない場合は操作を勧めない", () => {
    expect(describeStatus({ kind: "not_a_repo" })).not.toContain("取り込");
  });

  test("未取得と未送信を両方伝える", () => {
    const text = describeStatus({
      kind: "tracked",
      root: "/work",
      branch: "main",
      upstream: "origin/main",
      behind: 3,
      ahead: 2,
      dirty: 0,
      unmerged: 0,
    });

    expect(text).toContain("未取得 3件");
    expect(text).toContain("未送信 2件");
  });
});

// ─── ここから実際のgitを動かす ───
//
// 単体テストが通っても実データで動かない、というのを繰り返しているため、
// コミット数の数え方と「未コミットなら取り込まない」の2点は
// 本物のリポジトリで確かめる。

const tempRoot = path.join(os.tmpdir(), "novelai-git-test");
/**
 * `test.skipIf` はテストを集める時点で評価される。
 * `beforeAll` で判定すると間に合わず、全部スキップされたまま
 * 「通った」ように見える（実際にそうなった）。ここで先に決める。
 */
const gitReady = await isGitAvailable();
let workDir = "";
let otherDir = "";

async function git(args: string[], cwd: string): Promise<void> {
  const result = await runGit(args, cwd, 30_000);
  if (result.code !== 0) {
    throw new Error(
      `git ${args.join(" ")} が失敗しました: ${result.stderr || result.stdout}`
    );
  }
}

/** コミットの作者情報。実行環境の設定に依存させない */
const IDENTITY = [
  "-c",
  "user.name=test",
  "-c",
  "user.email=test@example.com",
];

beforeAll(async () => {
  if (!gitReady) return;

  await fs.rm(tempRoot, { recursive: true, force: true });
  await fs.mkdir(tempRoot, { recursive: true });

  const remote = path.join(tempRoot, "remote.git");
  await git(["init", "--bare", "-b", "main", remote], tempRoot);

  workDir = path.join(tempRoot, "work");
  otherDir = path.join(tempRoot, "other");
  await git(["clone", remote, "work"], tempRoot);
  await fs.writeFile(path.join(workDir, "001.txt"), "一行目\n", "utf8");
  await git(["add", "."], workDir);
  await git([...IDENTITY, "commit", "-m", "初回"], workDir);
  await git(["push", "-u", "origin", "main"], workDir);

  await git(["clone", remote, "other"], tempRoot);
}, 60_000);

afterAll(async () => {
  if (!gitReady) return;
  await fs.rm(tempRoot, { recursive: true, force: true });
});

describe("実際のgitでの確認", () => {
  test.skipIf(!gitReady)("同期が取れている状態を正しく読む", async () => {
    const status = await readSyncStatus(workDir);

    expect(status).toMatchObject({
      kind: "tracked",
      branch: "main",
      behind: 0,
      ahead: 0,
      dirty: 0,
    });
  });

  test.skipIf(!gitReady)(
    "別の環境が進んだぶんを、fetch後に未取得として数える",
    async () => {
      await fs.writeFile(path.join(otherDir, "002.txt"), "二話\n", "utf8");
      await git(["add", "."], otherDir);
      await git([...IDENTITY, "commit", "-m", "別環境で第2話"], otherDir);
      await git(["push"], otherDir);

      // fetchする前は気づけない（＝これが「pullせずに書き始める」状態）
      const before = await readSyncStatus(workDir);
      expect(before).toMatchObject({ behind: 0 });

      const fetched = await fetchRemote(workDir);
      expect(fetched.ok).toBe(true);

      const after = await readSyncStatus(workDir);
      expect(after).toMatchObject({ behind: 1, ahead: 0 });
    },
    60_000
  );

  test.skipIf(!gitReady)(
    "未コミットの変更があるうちは取り込まない",
    async () => {
      const manuscript = path.join(workDir, "001.txt");
      await fs.writeFile(manuscript, "一行目\n書きかけ\n", "utf8");

      const result = await pullFastForward(workDir);

      expect(result).toEqual({ ok: false, failure: { kind: "dirty" } });
      // 書きかけがそのまま残っていること。ここが壊れると原稿が消える
      expect(await fs.readFile(manuscript, "utf8")).toBe("一行目\n書きかけ\n");
    },
    60_000
  );

  test.skipIf(!gitReady)(
    "片付ければ取り込め、未取得が解消する",
    async () => {
      await git(["checkout", "--", "001.txt"], workDir);

      const result = await pullFastForward(workDir);
      expect(result.ok).toBe(true);

      const status = await readSyncStatus(workDir);
      expect(status).toMatchObject({ behind: 0, ahead: 0 });
      // 取り込んだ内容が実際に届いている。
      // 改行は比較から外す：Windowsの `core.autocrlf` が既定で有効だと、
      // gitがチェックアウト時にLFをCRLFへ書き換えるため、
      // ここで固定すると環境によって落ちるテストになる
      const delivered = await fs.readFile(
        path.join(workDir, "002.txt"),
        "utf8"
      );
      expect(delivered.replace(/\r\n/g, "\n")).toBe("二話\n");
    },
    60_000
  );

  test.skipIf(!gitReady)(
    "この環境のコミットを未送信として数える",
    async () => {
      await fs.writeFile(path.join(workDir, "003.txt"), "三話\n", "utf8");
      await git(["add", "."], workDir);
      await git([...IDENTITY, "commit", "-m", "第3話"], workDir);

      expect(await readSyncStatus(workDir)).toMatchObject({
        ahead: 1,
        behind: 0,
      });
    },
    60_000
  );
});
