import { afterEach, describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import {
  COMMAND_LINE_PATH_BUDGET,
  commitPaths,
  runGit,
  runGitForPaths,
  splitPathsForCommandLine,
} from "../../../src/core/git";

/**
 * 多くのパスを git へ渡す部品（残課題 F2、設計書6.67）。
 *
 * Windows では1回の起動に渡せる命令の長さに上限（32,767字）があり、
 * 200話規模の話数の付け替えで届く。ステージは束に分け、コミットは
 * 1つのまま標準入力でパスを渡す。**標準入力の道は本物の git で確かめる**
 * ——作り物の git では「索引に載っていた別のものを巻き込まない」が
 * 確かめられない。
 */

describe("パスを束に分ける", () => {
  test("目安の字数を超えないように分け、順番と中身を変えない", () => {
    const entries = Array.from({ length: 50 }, (_, index) => `本文/第${index + 1}話　とても長い題名.txt`);
    const batches = splitPathsForCommandLine(entries, 200);
    expect(batches.length).toBeGreaterThan(1);
    expect(batches.flat()).toEqual(entries);
    for (const batch of batches) {
      const cost = batch.reduce((sum, entry) => sum + entry.length + 3, 0);
      expect(cost).toBeLessThanOrEqual(200);
    }
  });

  test("1つだけで目安を超えるパスも落とさない", () => {
    const long = "あ".repeat(300);
    expect(splitPathsForCommandLine(["a", long, "b"], 100)).toEqual([["a"], [long], ["b"]]);
  });

  test("目安は Windows の上限（32,767字）より十分小さい", () => {
    expect(COMMAND_LINE_PATH_BUDGET).toBeLessThan(32_767 - 4_000);
  });
});

let base: string | undefined;

afterEach(() => {
  if (base) fs.rmSync(base, { recursive: true, force: true });
  base = undefined;
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function setUpRepo(): string {
  base = fs.mkdtempSync(nodePath.join(os.tmpdir(), "novelai-pathargs-"));
  const root = nodePath.join(base, "work");
  fs.mkdirSync(nodePath.join(root, "本文"), { recursive: true });
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "core.autocrlf", "false");
  // 日本語のファイル名を引用符付きの8進数にしない（比べやすくするため）
  git(root, "config", "core.quotepath", "false");
  git(root, "config", "user.name", "作者");
  git(root, "config", "user.email", "author@example.com");
  for (let n = 1; n <= 6; n++) {
    fs.writeFileSync(nodePath.join(root, "本文", `第${n}話　雪の街.txt`), `第${n}話の本文\n`);
  }
  fs.writeFileSync(nodePath.join(root, "メモ.txt"), "最初のメモ\n");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "初回");
  return root;
}

describe("名指ししたパスだけを1つのコミットにする（本物のgit）", { timeout: 30_000 }, () => {
  test("標準入力でパスを渡しても、名前の変更だけが1つのコミットに入り、索引の別の変更は巻き込まない", async () => {
    const root = setUpRepo();
    // 作者が別の仕事で索引へ載せていたもの。**コミットに入ってはいけない**
    fs.writeFileSync(nodePath.join(root, "メモ.txt"), "書きかけのメモ\n");
    git(root, "add", "メモ.txt");

    // 第1〜6話を1つずつ後ろへずらす（後ろから）
    const paths: string[] = [];
    for (let n = 6; n >= 1; n--) {
      const from = nodePath.join(root, "本文", `第${n}話　雪の街.txt`);
      const to = nodePath.join(root, "本文", `第${n + 1}話　雪の街.txt`);
      fs.renameSync(from, to);
      paths.push(from, to);
    }

    const added = await runGitForPaths(runGit, ["add"], paths, root, 15_000);
    expect(added.code).toBe(0);
    // 目安を小さくして、**標準入力の道**を通す
    const committed = await commitPaths(runGit, "話数を調整", paths, root, 15_000, 10);
    expect(committed.stderr).toBe("");
    expect(committed.code).toBe(0);

    // コミットは1つだけ増え、中身は本文の名前の変更だけ
    expect(git(root, "rev-list", "--count", "HEAD").trim()).toBe("2");
    const changed = git(root, "show", "--name-only", "--format=", "HEAD")
      .split("\n")
      .filter((line) => line.trim().length > 0);
    expect(changed.every((line) => line.startsWith("本文/"))).toBe(true);
    expect(changed.some((line) => line.includes("メモ"))).toBe(false);
    // 別の仕事のメモは、索引に載ったまま残っている
    expect(git(root, "diff", "--cached", "--name-only").trim()).toBe("メモ.txt");
    // 作業ツリーに取り残しが無い（名前の変更は全部記録された）
    const status = git(root, "status", "--porcelain", "--", "本文").trim();
    expect(status).toBe("");
  });

  test("短いときは今までどおり命令に並べる（古い git を締め出さない）", async () => {
    const calls: string[][] = [];
    await commitPaths(
      async (args) => {
        calls.push(args);
        return { code: 0, stdout: "", stderr: "" };
      },
      "調整",
      ["本文/a.txt", "本文/b.txt"],
      "C:/work",
      15_000
    );
    expect(calls).toEqual([["commit", "-m", "調整", "--", "本文/a.txt", "本文/b.txt"]]);
  });
});
