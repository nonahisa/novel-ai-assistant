import { describe, expect, test } from "vitest";
import {
  STARTUP_CHECK_LIMIT,
  orderStartupTargets,
  overlappingChangedFiles,
  planHandoff,
} from "../../src/core/handoffPlan";
import type { GitSyncStatus } from "../../src/core/git";

/**
 * 機械を行き来したときの手順（設計書6.15.1）。
 *
 * 作者の裁定（2026-09-21）を、そのまま表にして確かめる。
 *
 * | 状態 | どうするか |
 * |---|---|
 * | ローカルに溜まっている | 送る |
 * | リモートだけ進んでいる | 黙って取る |
 * | 両方に動きがあり、ファイルが重ならない | 黙って揃える |
 * | 両方に動きがあり、同じファイルが変わっている | 止めて訊く |
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

describe("作者の裁定の表", () => {
  test("ローカルに溜まっているなら、送る", () => {
    expect(planHandoff({ status: tracked({ ahead: 3 }) })).toEqual({
      kind: "send",
      ahead: 3,
      dirty: 0,
    });
  });

  test("リモートだけ進んでいるなら、黙って取る", () => {
    expect(planHandoff({ status: tracked({ behind: 2 }) })).toEqual({
      kind: "take",
      behind: 2,
      dirty: 0,
    });
  });

  test("両方に動きがあり、ファイルが重ならないなら、黙って揃える", () => {
    const action = planHandoff({
      status: tracked({ ahead: 2, behind: 3 }),
      overlap: [],
    });
    expect(action).toEqual({ kind: "fold", ahead: 2, behind: 3, dirty: 0 });
  });

  test("両方に動きがあり、同じファイルが変わっているなら、止めて訊く", () => {
    const action = planHandoff({
      status: tracked({ ahead: 2, behind: 3 }),
      overlap: ["本文/008.txt"],
    });
    expect(action).toMatchObject({ kind: "ask", overlap: ["本文/008.txt"] });
  });

  test("同期が取れていれば、何もしない", () => {
    expect(planHandoff({ status: tracked() })).toEqual({ kind: "nothing" });
  });

  test("gitを使っていない作品には手を出さない", () => {
    expect(planHandoff({ status: { kind: "not_a_repo" } })).toEqual({
      kind: "nothing",
    });
    expect(planHandoff({ status: { kind: "git_missing" } })).toEqual({
      kind: "nothing",
    });
    // まだ一度も送っていない置き場も、異常ではないので黙っている
    expect(
      planHandoff({
        status: {
          kind: "no_upstream",
          root: "C:/書庫",
          branch: "main",
          dirty: 4,
          dirtyHere: 4,
        },
      })
    ).toEqual({ kind: "nothing" });
  });
});

describe("自動では進めない場面", () => {
  test("競合マーカーが残っていたら、何もしない（設計書5.5.1）", () => {
    // **記録すればマーカーごと履歴に入り、送信すれば別の環境へも広がる**
    const action = planHandoff({
      status: tracked({ ahead: 2, behind: 1, unmerged: 1 }),
    });
    expect(action).toMatchObject({ kind: "blocked", reason: "unmerged" });
  });

  test("未保存のエディタがあれば、送らずに知らせる", () => {
    const action = planHandoff({
      status: tracked({ ahead: 3 }),
      unsaved: true,
    });
    expect(action).toMatchObject({ kind: "blocked", reason: "unsaved" });
  });

  test("未保存でも、することが無ければ黙っている", () => {
    expect(planHandoff({ status: tracked(), unsaved: true })).toEqual({
      kind: "nothing",
    });
  });

  test("未記録があるときは、取り込まない（書きかけを塗り替えるため）", () => {
    const action = planHandoff({ status: tracked({ behind: 2, dirty: 1 }) });
    expect(action).toMatchObject({ kind: "blocked", reason: "dirty" });
  });

  test("未記録があるときは、合流もしない（書きかけごと履歴に入るため）", () => {
    const action = planHandoff({
      status: tracked({ behind: 2, ahead: 2, dirty: 1 }),
      overlap: [],
    });
    expect(action).toMatchObject({ kind: "blocked", reason: "dirty" });
  });

  test("未記録があっても、送信はする（出るのはコミット済みだけ）", () => {
    // pushが外へ出すのは**既にコミットしたもの**だけで、
    // 書きかけは1文字も出ていかない
    expect(planHandoff({ status: tracked({ ahead: 2, dirty: 5 }) })).toEqual({
      kind: "send",
      ahead: 2,
      dirty: 5,
    });
  });

  test("未記録だけがあるときは、知らせるだけ", () => {
    const action = planHandoff({ status: tracked({ dirty: 4 }) });
    expect(action).toMatchObject({ kind: "blocked", reason: "dirty", dirty: 4 });
  });
});

describe("重なりはファイル単位で見る", () => {
  test("同じファイルが両方で変わっていれば拾う", () => {
    expect(
      overlappingChangedFiles(
        ["本文/008.txt", "設定/人物/主人公.json"],
        ["本文/008.txt", "本文/009.txt"]
      )
    ).toEqual(["本文/008.txt"]);
  });

  test("触ったファイルが分かれていれば、重ならない", () => {
    expect(
      overlappingChangedFiles(["本文/008.txt"], ["本文/009.txt"])
    ).toEqual([]);
  });

  test("区切りと大文字小文字の違いで、見落とさない", () => {
    // **見落とすと自動で混ぜてしまう。** 余分に拾っても「訊く」が増えるだけ
    expect(
      overlappingChangedFiles(["本文\\008.TXT"], ["本文/008.txt"])
    ).toEqual(["本文\\008.TXT"]);
  });

  test("同じファイルを二重に数えない", () => {
    expect(
      overlappingChangedFiles(
        ["本文/008.txt", "本文\\008.txt"],
        ["本文/008.txt"]
      )
    ).toEqual(["本文/008.txt"]);
  });
});

describe("起動時の点検の順番と間引き", () => {
  test("手元に送り残しのある置き場を先に見る", () => {
    const { checked } = orderStartupTargets([
      { root: "C:/きれい", pending: false },
      { root: "C:/書庫", pending: true },
    ]);
    expect(checked.map((one) => one.root)).toEqual(["C:/書庫", "C:/きれい"]);
  });

  test("同じ置き場は1回だけ（書庫に11作品でも、取りに行くのは1回）", () => {
    const { checked } = orderStartupTargets([
      { root: "C:/書庫", pending: false },
      { root: "C:/書庫", pending: true },
      { root: "C:/書庫", pending: false },
    ]);
    expect(checked).toHaveLength(1);
    // 1つでも送り残しがあれば、その置き場は送り残し扱いにする
    expect(checked[0].pending).toBe(true);
  });

  test("上限を超えた置き場は、あとに回す（開いた瞬間に全部取りに行かない）", () => {
    const targets = Array.from({ length: STARTUP_CHECK_LIMIT + 3 }, (_, i) => ({
      root: `C:/置き場${i}`,
      pending: false,
    }));
    const { checked, deferred } = orderStartupTargets(targets);
    expect(checked).toHaveLength(STARTUP_CHECK_LIMIT);
    expect(deferred).toHaveLength(3);
  });

  test("送り残しのある置き場は、上限の中へ必ず入る", () => {
    const targets = [
      ...Array.from({ length: STARTUP_CHECK_LIMIT }, (_, i) => ({
        root: `C:/きれい${i}`,
        pending: false,
      })),
      { root: "C:/溜まっている", pending: true },
    ];
    const { checked } = orderStartupTargets(targets);
    expect(checked.map((one) => one.root)).toContain("C:/溜まっている");
  });

  test("上限が壊れていても、1つは見る", () => {
    const { checked } = orderStartupTargets(
      [{ root: "C:/書庫", pending: true }],
      0
    );
    expect(checked).toHaveLength(1);
  });
});
