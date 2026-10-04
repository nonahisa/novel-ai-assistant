import { describe, expect, test } from "vitest";
import type { GitSyncStatus } from "../../../src/core/git";
import {
  alignToRepository,
  describeSyncStatusBar,
  isStaleRead,
  isWarning,
} from "../../../src/core/gitSyncStatusText";

/**
 * 同じ置き場の兄弟の控えを揃える判断（設計書6.15.1。2026-10-05）。
 *
 * 作者の報告「未記録９がふえました」：git status は0件なのに、
 * ステータスバーは古い兄弟の作品の数を出していた。
 */

function tracked(
  root: string,
  counts: Partial<{
    dirty: number;
    dirtyHere: number;
    ahead: number;
    aheadHere: number;
    behind: number;
    behindHere: number;
  }> = {}
): GitSyncStatus {
  return {
    kind: "tracked",
    root,
    branch: "main",
    upstream: "origin/main",
    behind: counts.behind ?? 0,
    ahead: counts.ahead ?? 0,
    behindHere: counts.behindHere ?? 0,
    aheadHere: counts.aheadHere ?? 0,
    dirty: counts.dirty ?? 0,
    dirtyHere: counts.dirtyHere ?? 0,
    unmerged: 0,
  };
}

describe("ステータスバーは古い兄弟の数を代表にしない", () => {
  test("揃えないと、数え直して0になった作品が外れて古い兄弟の7が出る（不具合の形）", () => {
    const stale = tracked("C:/lib", { dirty: 7, dirtyHere: 4 });
    const fresh = tracked("C:/lib");
    const before = [{ status: stale }, { status: fresh }].filter(({ status }) =>
      isWarning(status)
    );
    expect(describeSyncStatusBar(before)).toBe("$(git-branch) 未記録 7");

    const after = [
      { status: alignToRepository(stale, fresh) },
      { status: fresh },
    ].filter(({ status }) => isWarning(status));
    expect(describeSyncStatusBar(after)).toBeUndefined();
  });
});

describe("alignToRepository", () => {
  test("置き場ぜんぶの数は新しい読みを使い、作品のぶんは置き場ぜんぶで頭を押さえる", () => {
    const sibling = tracked("C:/lib", {
      dirty: 9,
      dirtyHere: 6,
      ahead: 3,
      aheadHere: 2,
      behind: 1,
      behindHere: 1,
    });
    const fresh = tracked("C:/lib", { dirty: 2, ahead: 0, behind: 4 });
    const aligned = alignToRepository(sibling, fresh);
    expect(aligned).toMatchObject({
      dirty: 2,
      dirtyHere: 2,
      ahead: 0,
      aheadHere: 0,
      behind: 4,
      // 作品のぶんは作品ごとなので、増えた分までは推し量らない
      behindHere: 1,
    });
  });

  test("区切りや大文字小文字だけ違う根も同じ置き場とみなす（Windows）", () => {
    const sibling = tracked("C:\\Lib\\", { dirty: 3, dirtyHere: 3 });
    const fresh = tracked("c:/lib");
    const aligned = alignToRepository(sibling, fresh);
    if (process.platform === "win32") {
      expect(aligned).toMatchObject({ dirty: 0, dirtyHere: 0 });
    } else {
      expect(aligned).toBe(sibling);
    }
  });

  test("別の置き場には触らない", () => {
    const sibling = tracked("C:/other", { dirty: 3, dirtyHere: 3 });
    expect(alignToRepository(sibling, tracked("C:/lib"))).toBe(sibling);
  });

  test("置き場の分からない状態とは揃えない", () => {
    const sibling = tracked("C:/lib", { dirty: 3, dirtyHere: 3 });
    expect(alignToRepository(sibling, { kind: "failed", detail: "x" })).toBe(
      sibling
    );
    const unknown: GitSyncStatus = { kind: "not_a_repo" };
    expect(alignToRepository(unknown, tracked("C:/lib"))).toBe(unknown);
  });

  test("上流の無い置き場でも記録待ちを揃える", () => {
    const sibling: GitSyncStatus = {
      kind: "no_upstream",
      root: "C:/lib",
      branch: "main",
      dirty: 5,
      dirtyHere: 5,
    };
    const fresh: GitSyncStatus = {
      kind: "no_upstream",
      root: "C:/lib",
      branch: "main",
      dirty: 0,
      dirtyHere: 0,
    };
    expect(alignToRepository(sibling, fresh)).toMatchObject({
      dirty: 0,
      dirtyHere: 0,
    });
  });
});

describe("isStaleRead", () => {
  test("後から始めた読みが既に受け取られていれば古い", () => {
    expect(isStaleRead(5, 3)).toBe(true);
    expect(isStaleRead(3, 5)).toBe(false);
    expect(isStaleRead(undefined, 1)).toBe(false);
  });
});
