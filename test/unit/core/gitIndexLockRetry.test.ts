import { afterEach, describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import {
  commitPaths,
  type GitCommandResult,
  type GitCommandRunner,
  INDEX_LOCK_RETRY_DELAYS_MS,
  isIndexLockContention,
  runGit,
  runGitForPaths,
  withIndexLockRetry,
} from "../../../src/core/git";

/**
 * ほかの git が `index.lock` を一瞬握っている間に、製品が index を書く命令を
 * 走らせたとき（Mac の e2e で、校閲の範囲を知らせる `publishLedger` の
 * `git add -A -- .aiwriter` が「File exists」で断られた。2026-11-07）。
 *
 * **本物の git で確かめる。** 断られ方（終了コードと文面）は git が決めるので、
 * 作り物の git では写せない。ロックは手で作り、300ms 後に消す——VS Code の
 * 組み込み Git や製品の見張りの `git status` が握って離すのと同じ形である。
 */

let base: string | undefined;

afterEach(() => {
  if (base) fs.rmSync(base, { recursive: true, force: true });
  base = undefined;
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function setUpRepo(): string {
  base = fs.mkdtempSync(nodePath.join(os.tmpdir(), "novelai-indexlock-"));
  const root = nodePath.join(base, "work");
  fs.mkdirSync(nodePath.join(root, ".aiwriter", "locks"), { recursive: true });
  git(root, "init", "--quiet");
  git(root, "config", "user.name", "試験");
  git(root, "config", "user.email", "test@example.invalid");
  git(root, "config", "core.autocrlf", "false");
  fs.writeFileSync(nodePath.join(root, "第1話.txt"), "本文\n", "utf8");
  git(root, "add", "-A");
  git(root, "commit", "--quiet", "-m", "最初の記録");
  return root;
}

/** `index.lock` を作り、`releaseAfterMs` 後に消す（消えたら解決する約束を返す） */
function holdIndexLock(root: string, releaseAfterMs: number): Promise<void> {
  const lockPath = nodePath.join(root, ".git", "index.lock");
  fs.writeFileSync(lockPath, "");
  return new Promise((resolve) => {
    setTimeout(() => {
      fs.rmSync(lockPath, { force: true });
      resolve();
    }, releaseAfterMs);
  });
}

function commitCount(root: string): number {
  return Number(git(root, "rev-list", "--count", "HEAD").trim());
}

describe("ほかの git が index.lock を一瞬握っているとき", () => {
  test("台帳のステージ（add -A -- .aiwriter）は、離されるのを待って通る", async () => {
    const root = setUpRepo();
    fs.writeFileSync(nodePath.join(root, ".aiwriter", "locks", "locks.jsonl"), "{}\n", "utf8");
    const released = holdIndexLock(root, 300);

    const staged = await runGitForPaths(runGit, ["add", "-A"], [".aiwriter"], root, 15_000);
    await released;

    expect(staged.code, staged.stderr).toBe(0);
    expect(git(root, "diff", "--cached", "--name-only").trim()).toBe(".aiwriter/locks/locks.jsonl");
  });

  test("名指しのコミットは、離されるのを待って通り、記録はちょうど1つ増える", async () => {
    const root = setUpRepo();
    fs.writeFileSync(nodePath.join(root, ".aiwriter", "locks", "locks.jsonl"), "{}\n", "utf8");
    git(root, "add", "--", ".aiwriter");
    const before = commitCount(root);
    const released = holdIndexLock(root, 300);

    const committed = await commitPaths(runGit, "台帳を記録", [".aiwriter"], root, 15_000);
    await released;

    expect(committed.code, committed.stderr).toBe(0);
    expect(commitCount(root)).toBe(before + 1);
    // 本文は巻き込まない（名指しのコミットの働きが、やり直しでも崩れない）
    expect(git(root, "status", "--porcelain").trim()).toBe("");
  });

  test("離されないままなら、待つのをやめて失敗をそのまま返す（黙って成功にしない）", async () => {
    const root = setUpRepo();
    fs.writeFileSync(nodePath.join(root, "第2話.txt"), "本文\n", "utf8");
    const lockPath = nodePath.join(root, ".git", "index.lock");
    fs.writeFileSync(lockPath, "");

    const started = Date.now();
    const staged = await runGit(["add", "-A"], root, 15_000);
    const elapsed = Date.now() - started;
    fs.rmSync(lockPath, { force: true });

    expect(staged.code).not.toBe(0);
    expect(staged.stderr).toContain("index.lock");
    // 待つ上限は数秒。命令の時間切れ（15秒）まで粘らない
    expect(elapsed).toBeLessThan(8_000);
    expect(git(root, "diff", "--cached", "--name-only").trim()).toBe("");
  }, 20_000);
});

/** git が index.lock の取り合いで断ったときの答え（LC_ALL=C の文面） */
const LOCKED: GitCommandResult = {
  code: 128,
  stdout: "",
  stderr:
    "fatal: Unable to create '/work/.git/index.lock': File exists.\n\nAnother git process seems to be running in this repository",
};
const OK: GitCommandResult = { code: 0, stdout: "", stderr: "" };

/** 答えを順に返す作り物の git。呼ばれた引数と時間切れを控える */
function scripted(answers: GitCommandResult[]): {
  run: GitCommandRunner;
  calls: { args: string[]; timeoutMs: number }[];
} {
  const calls: { args: string[]; timeoutMs: number }[] = [];
  const run: GitCommandRunner = async (args, _cwd, timeoutMs) => {
    calls.push({ args, timeoutMs });
    return answers[Math.min(calls.length - 1, answers.length - 1)];
  };
  return { run, calls };
}

/** 待ちを実時間で過ごさず、時計だけ進める */
function fakeClock(): { sleep: (ms: number) => Promise<void>; now: () => number; slept: number[] } {
  let time = 0;
  const slept: number[] = [];
  return {
    slept,
    now: () => time,
    sleep: async (ms) => {
      slept.push(ms);
      time += ms;
    },
  };
}

describe("やり直しの決まり（作り物の git）", () => {
  test("取り合いの文面だけを、取り合いと見る", () => {
    expect(isIndexLockContention(LOCKED)).toBe(true);
    expect(isIndexLockContention(OK)).toBe(false);
    expect(
      isIndexLockContention({ code: 128, stdout: "", stderr: "fatal: pathspec 'x' did not match any files" })
    ).toBe(false);
    // 時間切れ（-1）は、文面が残っていてもやり直さない
    expect(isIndexLockContention({ ...LOCKED, code: -1 })).toBe(false);
  });

  test("2回断られて3回目で通れば、通った答えを返す", async () => {
    const { run, calls } = scripted([LOCKED, LOCKED, OK]);
    const clock = fakeClock();
    const result = await withIndexLockRetry(run, clock)(["add", "-A"], "/work", 10_000);
    expect(result.code).toBe(0);
    expect(calls).toHaveLength(3);
    expect(clock.slept).toEqual(INDEX_LOCK_RETRY_DELAYS_MS.slice(0, 2));
  });

  test("ずっと断られるなら、回数の上限で最後の失敗をそのまま返す", async () => {
    const { run, calls } = scripted([LOCKED]);
    const result = await withIndexLockRetry(run, fakeClock())(["commit", "-m", "記録"], "/work", 60_000);
    expect(result).toEqual(LOCKED);
    expect(calls).toHaveLength(INDEX_LOCK_RETRY_DELAYS_MS.length + 1);
  });

  test("ロックでない失敗は、やり直さない", async () => {
    const other: GitCommandResult = { code: 1, stdout: "", stderr: "error: something else" };
    const { run, calls } = scripted([other, OK]);
    const result = await withIndexLockRetry(run, fakeClock())(["add", "-A"], "/work", 10_000);
    expect(result).toEqual(other);
    expect(calls).toHaveLength(1);
  });

  test("退避を作る命令（stash・--autostash）は、取り合いでもやり直さない", async () => {
    for (const args of [["stash", "push"], ["pull", "--ff-only", "--autostash"]]) {
      const { run, calls } = scripted([LOCKED, OK]);
      const result = await withIndexLockRetry(run, fakeClock())(args, "/work", 30_000);
      expect(result).toEqual(LOCKED);
      expect(calls).toHaveLength(1);
    }
  });

  test("やり直しも含めて、呼び手の時間切れを越えない（2回目以降は残りの時間だけ渡す）", async () => {
    const { run, calls } = scripted([LOCKED]);
    const clock = fakeClock();
    // 上限 1.5 秒：100ms・200ms と待って2回やり直す。次の 400ms を待つと
    // 残りが 1 秒を切るので、そこで止める
    const result = await withIndexLockRetry(run, clock)(["add", "-A"], "/work", 1_500);
    expect(result).toEqual(LOCKED);
    expect(calls.map((call) => call.timeoutMs)).toEqual([1_500, 1_400, 1_200]);
    expect(clock.slept.reduce((sum, ms) => sum + ms, 0)).toBeLessThanOrEqual(1_500);
  });
});
