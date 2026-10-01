import { describe, expect, test } from "vitest";
import { listSyncTargets } from "../../../src/core/gitSyncStatusText";
import type { GitSyncStatus } from "../../../src/core/git";

/**
 * ステータスバーから押したときの、同期する置き場の候補。
 * 作者の指摘（2026-10-01）：「未記録 2」を押すと全作品が並び、どれが
 * 未記録か分からない。手当ての要る置き場だけを、重いものから並べる。
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

const w = (title: string) => ({ id: title, title });

describe("同期する置き場の候補", () => {
  test("手当ての要る置き場だけが並ぶ", () => {
    const targets = listSyncTargets([
      { work: w("A"), status: tracked({ root: "C:/a", dirty: 2 }) },
      { work: w("B"), status: tracked({ root: "C:/b" }) },
      { work: w("C"), status: { kind: "not_a_repo" } },
    ]);
    expect(targets.map((t) => t.work.title)).toEqual(["A"]);
  });

  test("説明に件数が並ぶ（0の欄は出ない）", () => {
    const [one] = listSyncTargets([
      { work: w("A"), status: tracked({ dirty: 2, ahead: 1 }) },
    ]);
    expect(one.description).toBe("未記録 2・送信待ち 1");
  });

  test("書庫は1行にまとまり、作品名が添えられる", () => {
    const targets = listSyncTargets([
      { work: w("たゆたう鉛_確認用"), status: tracked({ dirty: 2 }) },
      { work: w("二作目"), status: tracked({ dirty: 2 }) },
      { work: w("三作目"), status: tracked({ dirty: 2 }) },
      { work: w("四作目"), status: tracked({ dirty: 2 }) },
    ]);
    expect(targets).toHaveLength(1);
    // 数は置き場1つぶん（11倍にならない）
    expect(targets[0].description).toBe("未記録 2");
    expect(targets[0].label).toBe("書庫（たゆたう鉛_確認用 ほか3作品）");
    expect(targets[0].works).toHaveLength(4);
  });

  test("1作品だけの置き場は作品名がそのまま出る", () => {
    const [one] = listSyncTargets([
      { work: w("単独"), status: tracked({ root: "C:/単独", ahead: 1 }) },
    ]);
    expect(one.label).toBe("単独");
  });

  test("競合・分岐が先、そのあとは元の順", () => {
    const targets = listSyncTargets([
      { work: w("記録待ち"), status: tracked({ root: "C:/1", dirty: 1 }) },
      { work: w("分岐"), status: tracked({ root: "C:/2", ahead: 1, behind: 1 }) },
      { work: w("送信待ち"), status: tracked({ root: "C:/3", ahead: 1 }) },
      { work: w("競合"), status: tracked({ root: "C:/4", unmerged: 2 }) },
    ]);
    expect(targets.map((t) => t.work.title)).toEqual([
      "分岐",
      "競合",
      "記録待ち",
      "送信待ち",
    ]);
    expect(targets[0].description).toContain("分岐");
    expect(targets[1].description).toContain("競合 2");
  });

  test("取り込み待ちは言葉で出る", () => {
    const [one] = listSyncTargets([
      { work: w("A"), status: tracked({ behind: 3 }) },
    ]);
    expect(one.description).toBe("取り込み待ち 3");
  });

  test("何も無ければ空", () => {
    expect(listSyncTargets([])).toEqual([]);
  });
});
