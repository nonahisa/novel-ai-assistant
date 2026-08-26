import { describe, expect, test } from "vitest";
import {
  actionablePlans,
  afterCommit,
  describeOutcomes,
  describePlan,
  describeTargetWorks,
  planSyncAll,
  planSyncTarget,
  type SyncTargetState,
} from "../../src/core/syncAllPlan";
import type { GitSyncStatus } from "../../src/core/git";
import type { WorkEntry } from "../../src/models/types";

/**
 * 作品をすべて同期する（設計書5.5.14）。
 *
 * 作者の依頼（2026-08-24）：「作品をすべて同期するを実装してください」。
 *
 * **置き場ごとにまとめて動かす。** 既定では1つのリポジトリに複数の作品が
 * 入っているので、作品ごとに回すと同じ置き場を何度も処理してしまう。
 */

function work(id: string, title: string, folderPath: string): WorkEntry {
  return { id, title, folderPath } as WorkEntry;
}

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
    dirty: 0,
    unmerged: 0,
    ...over,
  };
}

function state(over: Partial<SyncTargetState> = {}): SyncTargetState {
  return {
    folderPath: "C:/書庫",
    label: "書庫",
    works: [work("w1", "作品A", "C:/書庫/作品A")],
    status: tracked(),
    trackable: 0,
    ...over,
  };
}

describe("置き場ごとの手順", () => {
  test("同期が取れていれば、何もしない", () => {
    const plan = planSyncTarget(state());
    expect(plan.commit).toBe(false);
    expect(plan.pull).toBe(false);
    expect(plan.push).toBe(false);
    expect(plan.skip).toBe("nothing");
  });

  test("未記録の変更があれば、記録して送信する", () => {
    const plan = planSyncTarget(state({ trackable: 3 }));
    expect(plan.commit).toBe(true);
    // 記録すれば送るものができる
    expect(plan.push).toBe(true);
  });

  test("別の環境が進んでいれば、取り込む", () => {
    const plan = planSyncTarget(state({ status: tracked({ behind: 2 }) }));
    expect(plan.pull).toBe(true);
    expect(plan.push).toBe(false);
  });

  test("送っていないコミットがあれば、送信する", () => {
    const plan = planSyncTarget(state({ status: tracked({ ahead: 1 }) }));
    expect(plan.push).toBe(true);
    expect(plan.commit).toBe(false);
  });

  /** 記録が先。未記録のままでは取り込みが必ず飛ばされる（5.5.1） */
  test("記録も取り込みも要るときは、両方やる", () => {
    const plan = planSyncTarget(
      state({ trackable: 2, status: tracked({ behind: 3 }) })
    );
    expect(plan.commit).toBe(true);
    expect(plan.pull).toBe(true);
    expect(plan.push).toBe(true);
  });

  /** 競合マーカーごと履歴へ入れない（5.5.3） */
  test("競合が残っていたら、何もしない", () => {
    const plan = planSyncTarget(
      state({ trackable: 5, status: tracked({ unmerged: 1, behind: 1 }) })
    );
    expect(plan.commit).toBe(false);
    expect(plan.pull).toBe(false);
    expect(plan.push).toBe(false);
    expect(plan.skip).toBe("unmerged");
  });

  test("Gitで管理していない作品は飛ばす", () => {
    const plan = planSyncTarget(
      state({ trackable: 4, status: { kind: "not_a_repo" } })
    );
    expect(plan.commit).toBe(false);
    expect(plan.skip).toBe("not_a_repo");
  });

  /** 送り先が無くても、履歴には残せる */
  test("送り先が未設定でも、記録はする", () => {
    const plan = planSyncTarget(
      state({ trackable: 2, status: { kind: "no_remote", root: "C:/書庫" } })
    );
    expect(plan.commit).toBe(true);
    expect(plan.push).toBe(false);
  });

  test("一度も送信していない置き場は、記録して理由を残す", () => {
    const plan = planSyncTarget(
      state({
        trackable: 1,
        status: { kind: "no_upstream", root: "C:/書庫", branch: "main" },
      })
    );
    expect(plan.commit).toBe(true);
    expect(plan.push).toBe(false);
    expect(plan.skip).toBe("no_upstream");
  });

  test("動かすものだけを取り出せる", () => {
    const plans = planSyncAll([
      state(),
      state({ trackable: 1 }),
      state({ status: { kind: "not_a_repo" } }),
    ]);
    expect(actionablePlans(plans)).toHaveLength(1);
  });
});

describe("何が起きるかを書く", () => {
  test("やることを並べる", () => {
    const text = describePlan(
      planSyncTarget(state({ trackable: 2, status: tracked({ behind: 1 }) }))
    );
    expect(text).toContain("記録 2件");
    expect(text).toContain("取り込み 1件");
  });

  /** 記録するぶんも送られる。数字だけだと足りなく見える */
  test("記録して送るときは、そのことが分かる", () => {
    const text = describePlan(planSyncTarget(state({ trackable: 2 })));
    expect(text).toContain("記録したぶん");
  });

  test("やることが無ければ、理由を書く", () => {
    expect(describePlan(planSyncTarget(state()))).toBe("同期は取れています");
    expect(
      describePlan(planSyncTarget(state({ status: { kind: "not_a_repo" } })))
    ).toBe("Gitで管理していません");
  });

  test("作品が1つなら、作品名を出す", () => {
    expect(describeTargetWorks(state())).toBe("作品A");
  });

  test("複数なら、置き場と中の作品を出す", () => {
    const text = describeTargetWorks(
      state({
        works: [
          work("w1", "作品A", "C:/書庫/作品A"),
          work("w2", "作品B", "C:/書庫/作品B"),
        ],
      })
    );
    expect(text).toContain("書庫");
    expect(text).toContain("作品A");
    expect(text).toContain("作品B");
  });
});

describe("済んだあとの報告", () => {
  const plan = planSyncTarget(state({ trackable: 1 }));

  test("できたことを数える", () => {
    const text = describeOutcomes([
      { plan, committed: true, pulled: false, pushed: true },
    ]);
    expect(text).toContain("記録 1か所");
    expect(text).toContain("送信 1か所");
  });

  /** 半分しか通っていないときに気づけるようにする */
  test("通らなかったものも書く", () => {
    const text = describeOutcomes([
      { plan, committed: true, pulled: false, pushed: false, error: "拒まれた" },
    ]);
    expect(text).toContain("1か所は最後まで通りませんでした");
  });

  test("何も無ければ、そう書く", () => {
    expect(describeOutcomes([])).toBe("同期するものはありませんでした。");
  });
});

describe("記録の結果を、次の手順へ翻訳する", () => {
  /**
   * 2026-08-26、作者の実機で
   * 「記録できませんでした: On branch main / nothing to commit, working tree clean」
   * が出た。**そこで打ち切っていたので、取り込み1件・送信11件が飛んでいた。**
   */
  test("記録するものが無くても、止めない", () => {
    const next = afterCommit({ ok: true, nothingToCommit: true });

    expect(next.stop).toBe(false);
    // 記録はしていないので、報告で「記録した」と数えない
    expect(next).toMatchObject({ committed: false });
  });

  test("記録できたら、記録したと数える", () => {
    expect(afterCommit({ ok: true })).toEqual({ stop: false, committed: true });
  });

  test("本当に失敗したときは止めて、理由を返す", () => {
    // 続けても同じ理由で止まる。取り込みは未記録の変更があると動かない
    const next = afterCommit({ ok: false, detail: "fatal: index.lock" });

    expect(next).toEqual({
      stop: true,
      error: "記録できませんでした: fatal: index.lock",
    });
  });

  test("理由が分からなくても、黙って止まらない", () => {
    expect(afterCommit({ ok: false })).toMatchObject({
      error: "記録できませんでした: （詳細なし）",
    });
  });
});
