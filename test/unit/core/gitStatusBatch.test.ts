import { describe, expect, test } from "vitest";
import {
  createSyncStatusBatch,
  readRepoRoot,
  readSyncStatus,
  type GitCommandResult,
  type GitCommandRunner,
} from "../../../src/core/git";

/**
 * 同期前のチェックの git を減らす（docs/measurements/2026-10-29-非AIの速さ.md）。
 *
 * 待ちのほぼ全部が git の起動（1回約19ms）で、書庫の作品ごとに
 * **置き場ぜんぶの数**（status 全体・remote・枝・上流・rev-list 全体）を
 * 読み直していた。ここでは、
 *
 * - 根の確かめを1回にまとめたこと
 * - 根だけを読む口（`readRepoRoot`）
 * - 一巡のあいだだけ置き場ぜんぶの読みを使い回す仕組み（`createSyncStatusBatch`）
 *
 * を、呼ばれた git の数で確かめる。
 */

/** 呼ばれた git を（引数を空白でつないだ形で）残す作り物 */
function recordingGit(
  reply: (key: string, cwd: string) => Partial<GitCommandResult>
): { run: GitCommandRunner; calls: Array<{ key: string; cwd: string }> } {
  const calls: Array<{ key: string; cwd: string }> = [];
  const run: GitCommandRunner = async (args, cwd) => {
    const key = args.join(" ");
    calls.push({ key, cwd });
    const got = reply(key, cwd);
    return { code: got.code ?? 0, stdout: got.stdout ?? "", stderr: got.stderr ?? "" };
  };
  return { run, calls };
}

/** 書庫（/library）に作品が入っている、追跡中の置き場 */
function libraryReply(key: string): Partial<GitCommandResult> {
  if (key === "rev-parse --is-inside-work-tree --show-toplevel") {
    return { stdout: "true\n/library\n" };
  }
  if (key === "rev-parse --show-toplevel") return { stdout: "/library\n" };
  // 2回に分けていたころの呼び方にも答える（直す前に落ちる形を見るため）
  if (key === "rev-parse --is-inside-work-tree") return { stdout: "true\n" };
  if (key === "status --porcelain") {
    return { stdout: " M 短編/001.txt\n M 長編/001.txt\n" };
  }
  if (key === "status --porcelain -- .") return { stdout: " M 短編/001.txt\n" };
  if (key === "remote") return { stdout: "origin\n" };
  if (key === "symbolic-ref --quiet --short HEAD") return { stdout: "main\n" };
  if (key === "rev-parse --abbrev-ref --symbolic-full-name @{upstream}") {
    return { stdout: "origin/main\n" };
  }
  if (key === "rev-list --left-right --count origin/main...HEAD -- .") {
    return { stdout: "0\t1\n" };
  }
  if (key === "rev-list --left-right --count origin/main...HEAD") {
    return { stdout: "2\t5\n" };
  }
  return {};
}

const count = (calls: Array<{ key: string }>, key: string): number =>
  calls.filter((call) => call.key === key).length;

describe("根の確かめ（readSyncStatus の最初）", () => {
  test("作業ツリーの中かどうかと根を、1回の git で読む", async () => {
    const git = recordingGit(libraryReply);

    const status = await readSyncStatus("/library/短編", git.run);

    expect(status).toMatchObject({ kind: "tracked", root: "/library" });
    expect(count(git.calls, "rev-parse --is-inside-work-tree --show-toplevel")).toBe(1);
    // 別々に2回呼ばない
    expect(count(git.calls, "rev-parse --is-inside-work-tree")).toBe(0);
    expect(count(git.calls, "rev-parse --show-toplevel")).toBe(0);
  });

  test(".git の中（作業ツリーの外）はリポジトリでない扱い（今までと同じ）", async () => {
    // 本物の git は "false" を出したあと、根が無いので 128 で終わる
    const git = recordingGit((key) => {
      if (key === "rev-parse --is-inside-work-tree --show-toplevel") {
        return { code: 128, stdout: "false\n", stderr: "fatal: this operation must be run in a work tree" };
      }
      if (key === "--version") return { stdout: "git version 2.55.0\n" };
      return {};
    });

    expect((await readSyncStatus("/library/.git", git.run)).kind).toBe("not_a_repo");
  });

  test("作業ツリーの中なのに根が読めなければ、失敗として返す（今までと同じ）", async () => {
    const git = recordingGit((key) => {
      if (key === "rev-parse --is-inside-work-tree --show-toplevel") {
        return { code: 128, stdout: "true\n", stderr: "fatal: 何かが壊れている" };
      }
      if (key === "--version") return { stdout: "git version 2.55.0\n" };
      return {};
    });

    expect((await readSyncStatus("/library/短編", git.run)).kind).toBe("failed");
  });

  test("リポジトリでない／git が無いの区別は変えない", async () => {
    const notRepo = recordingGit((key) => {
      if (key === "rev-parse --is-inside-work-tree --show-toplevel") return { code: 128 };
      if (key === "--version") return { stdout: "git version 2.55.0\n" };
      return {};
    });
    const missing = recordingGit((key) => {
      if (key === "rev-parse --is-inside-work-tree --show-toplevel") return { code: -1 };
      if (key === "--version") return { code: -1 };
      return {};
    });

    expect((await readSyncStatus("/work", notRepo.run)).kind).toBe("not_a_repo");
    expect((await readSyncStatus("/work", missing.run)).kind).toBe("git_missing");
  });
});

describe("根だけを読む（readRepoRoot）", () => {
  test("置き場の根を1回の git で返す", async () => {
    const git = recordingGit(libraryReply);

    expect(await readRepoRoot("/library/短編", git.run)).toBe("/library");
    expect(git.calls.map((call) => call.key)).toEqual(["rev-parse --show-toplevel"]);
  });

  test("リポジトリでなければ undefined", async () => {
    const git = recordingGit(() => ({ code: 128 }));

    expect(await readRepoRoot("/work", git.run)).toBeUndefined();
  });
});

describe("一巡のあいだ、置き場ぜんぶの読みを使い回す（createSyncStatusBatch）", () => {
  test("同じ置き場の3作品で、置き場ぜんぶの数は1回ずつしか読まない", async () => {
    const git = recordingGit(libraryReply);
    const batch = createSyncStatusBatch();

    const statuses = [];
    for (const folder of ["/library/短編", "/library/長編", "/library/中編"]) {
      statuses.push(await readSyncStatus(folder, git.run, batch));
    }

    // 置き場ぜんぶの読み：1回ずつ
    expect(count(git.calls, "status --porcelain")).toBe(1);
    expect(count(git.calls, "remote")).toBe(1);
    expect(count(git.calls, "symbolic-ref --quiet --short HEAD")).toBe(1);
    expect(count(git.calls, "rev-parse --abbrev-ref --symbolic-full-name @{upstream}")).toBe(1);
    expect(count(git.calls, "rev-list --left-right --count origin/main...HEAD")).toBe(1);
    // **作品ごとに要る分は毎回読む**（根の確かめ・その作品の中だけの数）
    expect(count(git.calls, "rev-parse --is-inside-work-tree --show-toplevel")).toBe(3);
    expect(count(git.calls, "status --porcelain -- .")).toBe(3);
    expect(count(git.calls, "rev-list --left-right --count origin/main...HEAD -- .")).toBe(3);
    // 中身は使い回さなかったときと同じ
    const alone = await readSyncStatus("/library/長編", recordingGit(libraryReply).run);
    expect(statuses[1]).toEqual(alone);
    expect(statuses[2]).toMatchObject({ dirty: 2, dirtyHere: 1, behind: 2, ahead: 5, aheadHere: 1 });
  });

  test("渡さなければ、今までどおり毎回読む", async () => {
    const git = recordingGit(libraryReply);

    await readSyncStatus("/library/短編", git.run);
    await readSyncStatus("/library/長編", git.run);

    expect(count(git.calls, "status --porcelain")).toBe(2);
    expect(count(git.calls, "remote")).toBe(2);
  });

  test("forget した置き場は読み直す（取り寄せのあと、古い数を返さない）", async () => {
    let behind = 2;
    const git = recordingGit((key) => {
      if (key === "rev-list --left-right --count origin/main...HEAD") {
        return { stdout: `${behind}\t5\n` };
      }
      return libraryReply(key);
    });
    const batch = createSyncStatusBatch();

    await readSyncStatus("/library/短編", git.run, batch);
    behind = 7;
    batch.forget("/library");
    const after = await readSyncStatus("/library/長編", git.run, batch);

    expect(after).toMatchObject({ behind: 7 });
    expect(count(git.calls, "remote")).toBe(2);
  });

  test("別の置き場の読みは混ぜない", async () => {
    const git = recordingGit((key, cwd) => {
      const root = cwd.startsWith("/other") ? "/other" : "/library";
      if (key === "rev-parse --is-inside-work-tree --show-toplevel") {
        return { stdout: `true\n${root}\n` };
      }
      if (key === "status --porcelain") {
        return { stdout: root === "/other" ? "" : " M 短編/001.txt\n M 長編/001.txt\n" };
      }
      return libraryReply(key);
    });
    const batch = createSyncStatusBatch();

    await readSyncStatus("/library/短編", git.run, batch);
    const other = await readSyncStatus("/other", git.run, batch);

    expect(other).toMatchObject({ root: "/other", dirty: 0 });
    expect(count(git.calls, "status --porcelain")).toBe(2);
  });
});

describe("使い回しは、失敗した答えを覚えない（母艦のレビュー 2026-10-30）", () => {
  test("一度失敗した置き場ぜんぶの命令は、次の作品で読み直す", async () => {
    let remoteFailures = 1;
    const git = recordingGit((key) => {
      // 一時的に `git remote` が失敗する（ほかの git が index を握っていた等）
      if (key === "remote" && remoteFailures > 0) {
        remoteFailures -= 1;
        return { code: 128, stderr: "fatal: 一時的な失敗" };
      }
      return libraryReply(key);
    });
    const batch = createSyncStatusBatch();

    const first = await readSyncStatus("/library/短編", git.run, batch);
    const second = await readSyncStatus("/library/長編", git.run, batch);

    expect(first.kind).toBe("failed");
    // 失敗した答えを使い回すと、同じ置き場の作品がみな失敗になる
    expect(second.kind).toBe("tracked");
    expect(count(git.calls, "remote")).toBe(2);
  });
});
