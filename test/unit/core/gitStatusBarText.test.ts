import { describe, expect, test } from "vitest";
import { describeSyncStatusBar } from "../../src/core/gitSyncStatusText";
import type { GitSyncStatus } from "../../src/core/git";

/**
 * ステータスバーの文言（設計書6.15.1）。
 *
 * **11倍の数え違いを見張る。** `behind`／`ahead`／`dirty`／`unmerged` は
 * 置き場ぜんぶの数なので（設計書5.5.1）、作品ごとに足すと書庫（1つの
 * リポジトリに11作品）では11倍になる。印の側は
 * `unsentMark.test.ts` が見張っているが、**ステータスバー側はここまで
 * 見張られていなかった**——印を直しても、こちらの再発は止まらない。
 */

function tracked(
  over: Partial<Extract<GitSyncStatus, { kind: "tracked" }>> = {}
): GitSyncStatus {
  return {
    kind: "tracked",
    root: "C:/書庫",
    branch: "main",
    upstream: "origin/main",
    behind: 0,
    ahead: 0,
    behindHere: 0,
    aheadHere: 0,
    dirty: 0,
    dirtyHere: 0,
    unmerged: 0,
    ...over,
  };
}

describe("ステータスバーの文言", () => {
  test("書庫に11作品あっても、未送信の数は置き場1つぶん", () => {
    const entries = Array.from({ length: 11 }, () => ({
      status: tracked({ ahead: 3 }),
    }));
    // 11倍なら「未送信 33」になる
    expect(describeSyncStatusBar(entries)).toBe("$(git-branch) 未送信 3");
  });

  test("別の置き場は、それぞれ足す", () => {
    expect(
      describeSyncStatusBar([
        { status: tracked({ ahead: 3 }) },
        { status: tracked({ root: "C:/別作品", ahead: 1, dirty: 4 }) },
      ])
    ).toBe("$(git-branch) 未送信 4 / 未記録 4");
  });

  test("0 の欄は並ばない", () => {
    const text = describeSyncStatusBar([{ status: tracked({ dirty: 2 }) }]);
    expect(text).toBe("$(git-branch) 未記録 2");
    expect(text).not.toContain("未取得");
    expect(text).not.toContain("未送信");
    expect(text).not.toContain("競合");
  });

  test("4つ並ぶときの順番は 未取得 / 未送信 / 未記録 / 競合", () => {
    expect(
      describeSyncStatusBar([
        { status: tracked({ behind: 1, ahead: 2, dirty: 3, unmerged: 4 }) },
      ])
    ).toBe("$(git-branch) 未取得 1 / 未送信 2 / 未記録 3 / 競合 4");
  });

  test("警告が無ければ隠す", () => {
    expect(describeSyncStatusBar([])).toBeUndefined();
    // 数がすべて0のものだけなら、出すものが無い（＝隠す）
    expect(describeSyncStatusBar([{ status: tracked() }])).toBeUndefined();
  });

  test("置き場の分からない状態は数えない", () => {
    // gitが無い・リポジトリでない作品は `root` を持たないので、
    // 置き場ごとに畳みようがない
    expect(
      describeSyncStatusBar([
        { status: { kind: "git_missing" } },
        { status: { kind: "not_a_repo" } },
        { status: tracked({ ahead: 2 }) },
      ])
    ).toBe("$(git-branch) 未送信 2");
  });

  test("頭に $(git-branch) が付く", () => {
    const text = describeSyncStatusBar([{ status: tracked({ behind: 1 }) }]);
    expect(text?.startsWith("$(git-branch) ")).toBe(true);
  });
});
