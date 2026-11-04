import { describe, expect, test } from "vitest";
import {
  readSyncStatus,
  refreshAfterFetch,
  type GitCommandRunner,
  type GitSyncStatus,
} from "../../../src/core/git";

/**
 * fetch のあとの読み直し（2026-11-05）。
 *
 * fetch が変えるのはリモートの追跡の参照だけなので、読み直しは上流の解決と
 * ahead／behind の数だけにする。**確認の窓に渡る状態は、丸ごと読み直したときと
 * 同じでなければならない**——偽の git で、fetch の前後それぞれの世界を作り、
 * 両方の道の結果が一致することと、git を起こす回数が減ったことを見る。
 */

const ROOT = "C:/置き場";

interface World {
  /** 上流の名前。undefined なら上流なし */
  upstream?: string;
  behind: number;
  ahead: number;
  dirtyLines?: number;
  remote?: string;
  notRepo?: boolean;
}

function fakeGit(world: World, calls: string[][]): GitCommandRunner {
  return async (args) => {
    calls.push(args);
    const joined = args.join(" ");
    if (world.notRepo && args[0] === "rev-parse") {
      return { code: 128, stdout: "", stderr: "fatal: not a git repository" };
    }
    if (args[0] === "--version") return { code: 0, stdout: "git version 2.55", stderr: "" };
    if (joined === "rev-parse --is-inside-work-tree --show-toplevel") {
      return { code: 0, stdout: `true\n${ROOT}`, stderr: "" };
    }
    if (args[0] === "status") {
      const n = world.dirtyLines ?? 2;
      const lines = Array.from({ length: n }, (_, k) => ` M 本文/${k}.txt`).join("\n");
      return { code: 0, stdout: n ? `${lines}\n` : "", stderr: "" };
    }
    if (joined === "remote") return { code: 0, stdout: world.remote ?? "origin", stderr: "" };
    if (args[0] === "symbolic-ref") return { code: 0, stdout: "main", stderr: "" };
    if (joined.startsWith("rev-parse --abbrev-ref")) {
      return world.upstream
        ? { code: 0, stdout: world.upstream, stderr: "" }
        : { code: 128, stdout: "", stderr: "fatal: no upstream configured" };
    }
    if (args[0] === "rev-list") {
      return { code: 0, stdout: `${world.behind}\t${world.ahead}`, stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
}

/** fetch の前の世界で読み、fetch のあとの世界へ移って、2つの道を比べる */
async function compare(before: World, after: World) {
  const prev = await readSyncStatus(ROOT, fakeGit(before, []));
  const fullCalls: string[][] = [];
  const full = await readSyncStatus(ROOT, fakeGit(after, fullCalls));
  const refreshCalls: string[][] = [];
  const refreshed = await refreshAfterFetch(prev, ROOT, fakeGit(after, refreshCalls));
  return { prev, full, refreshed, fullCalls: fullCalls.length, refreshCalls: refreshCalls.length };
}

describe("refreshAfterFetch", () => {
  test("fetch で behind が増える：丸ごと読み直しと同じ状態・git は6本から2本", async () => {
    const r = await compare(
      { upstream: "origin/main", behind: 0, ahead: 1 },
      { upstream: "origin/main", behind: 3, ahead: 1 }
    );
    expect(r.refreshed).toEqual(r.full);
    expect(r.refreshed).toMatchObject({ kind: "tracked", behind: 3, ahead: 1 });
    expect(r.fullCalls).toBe(6);
    expect(r.refreshCalls).toBe(2);
  });

  test("上流が初めて現れる：丸ごと読み直しと同じ状態（tracked になる）", async () => {
    const r = await compare(
      { behind: 0, ahead: 0 },
      { upstream: "origin/main", behind: 2, ahead: 0 }
    );
    expect(r.prev.kind).toBe("no_upstream");
    expect(r.refreshed).toEqual(r.full);
    expect(r.refreshed.kind).toBe("tracked");
  });

  test("上流が無いまま：丸ごと読み直しと同じ状態・git は5本から1本", async () => {
    const r = await compare({ behind: 0, ahead: 0 }, { behind: 0, ahead: 0 });
    expect(r.refreshed).toEqual(r.full);
    expect(r.refreshed.kind).toBe("no_upstream");
    // 上流なしは丸ごとでも rev-list まで行かないので5本
    expect(r.fullCalls).toBe(5);
    expect(r.refreshCalls).toBe(1);
  });

  test("上流が消えた（tracked → no_upstream）：丸ごと読み直しと同じ状態", async () => {
    const r = await compare(
      { upstream: "origin/main", behind: 1, ahead: 0 },
      { behind: 0, ahead: 0 }
    );
    expect(r.refreshed).toEqual(r.full);
    expect(r.refreshed.kind).toBe("no_upstream");
  });

  test("リポジトリでない・リモートが無い：丸ごと読み直す側に倒れて同じ状態", async () => {
    const notRepo = await compare(
      { notRepo: true, behind: 0, ahead: 0 },
      { notRepo: true, behind: 0, ahead: 0 }
    );
    expect(notRepo.refreshed).toEqual(notRepo.full);
    expect(notRepo.refreshed.kind).toBe("not_a_repo");
    const noRemote = await compare(
      { remote: "", behind: 0, ahead: 0 },
      { remote: "", behind: 0, ahead: 0 }
    );
    expect(noRemote.refreshed).toEqual(noRemote.full);
    expect(noRemote.refreshed.kind).toBe("no_remote");
  });

  test("前の状態が tracked／no_upstream 以外（detached）なら丸ごと読み直す", async () => {
    const detached: GitSyncStatus = { kind: "detached", root: ROOT };
    const calls: string[][] = [];
    const out = await refreshAfterFetch(
      detached,
      ROOT,
      fakeGit({ upstream: "origin/main", behind: 0, ahead: 0 }, calls)
    );
    expect(calls.length).toBe(6);
    expect(out.kind).toBe("tracked");
  });
});
