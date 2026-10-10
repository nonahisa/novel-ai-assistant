import { describe, expect, test } from "vitest";
import {
  buildStatusBarSyncMenu,
  canSaveAndSync,
} from "../../../src/core/gitSyncStatusText";
import type { GitSyncStatus } from "../../../src/core/git";

/**
 * ステータスバーの「未送信／未記録」を押したときの一覧（設計書6.15.1）。
 *
 * 作者の報告（2026-10-10）：「一番上を選択しても同期されません。同期可能で
 * あれば、優先順位は同期が上です。また２回も選択肢が表示され冗長です」。
 * 1回目は作品選び（全作品が無い）、2回目は「変更を記録する」「状態を確認」
 * 「ログを表示」で、同期と分かるものが無かった。
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

function kinds(menu: ReturnType<typeof buildStatusBarSyncMenu>): string[] {
  if (menu.kind !== "menu") return [menu.kind];
  return menu.choices.map((choice) =>
    choice.kind === "work" || choice.kind === "divergence"
      ? `${choice.kind}:${choice.work.title}`
      : choice.kind
  );
}

describe("ステータスバーから押したときの一覧", () => {
  test("置き場が2つで未送信は片方だけ：先頭が保存・同期、続いて作品ごと、最後にログ", () => {
    // 作者の実データの形：novel は記録待ち17だけ、別の置き場に未送信1
    const menu = buildStatusBarSyncMenu([
      { work: w("小説"), status: tracked({ root: "C:/novel", dirty: 17 }) },
      { work: w("別の作品"), status: tracked({ root: "C:/other", ahead: 1 }) },
    ]);
    expect(kinds(menu)).toEqual([
      "syncAll",
      "work:小説",
      "work:別の作品",
      "log",
    ]);
    if (menu.kind !== "menu") throw new Error("一覧になるはず");
    // 同期の数は置き場ごとに1回だけ足す
    expect(menu.choices[0].description).toBe("未記録 17・未送信 1");
    // 作品ごとの行には、その置き場の数が並ぶ
    expect(menu.choices[1].description).toBe("未記録 17");
    expect(menu.choices[2].description).toBe("送信待ち 1");
  });

  test("記録待ちだけでも、送り先があれば保存・同期を先頭に出す", () => {
    const menu = buildStatusBarSyncMenu([
      { work: w("A"), status: tracked({ root: "C:/a", dirty: 2 }) },
      { work: w("B"), status: tracked({ root: "C:/b", dirty: 3 }) },
    ]);
    expect(kinds(menu)).toEqual(["syncAll", "work:A", "work:B", "log"]);
  });

  test("分岐しているなら分岐合流が同期より先", () => {
    const menu = buildStatusBarSyncMenu([
      { work: w("記録待ち"), status: tracked({ root: "C:/1", dirty: 1 }) },
      {
        work: w("分岐"),
        status: tracked({ root: "C:/2", ahead: 1, behind: 2 }),
      },
    ]);
    expect(kinds(menu)).toEqual([
      "divergence:分岐",
      "syncAll",
      "work:分岐",
      "work:記録待ち",
      "log",
    ]);
  });

  test("そろえる行の名前は作者の言葉で「2台の原稿をそろえる」（2026-10-11）", () => {
    const menu = buildStatusBarSyncMenu([
      { work: w("分岐"), status: tracked({ ahead: 1, behind: 1 }) },
    ]);
    if (menu.kind !== "menu") throw new Error("一覧になっていません");
    expect(menu.choices[0].label).toBe("2台の原稿をそろえる");
  });

  test("分岐した置き場が1つだけでも、作品選びを飛ばさずに分岐合流を先に見せる", () => {
    const menu = buildStatusBarSyncMenu([
      { work: w("分岐"), status: tracked({ ahead: 1, behind: 1 }) },
    ]);
    expect(kinds(menu)).toEqual([
      "divergence:分岐",
      "syncAll",
      "work:分岐",
      "log",
    ]);
  });

  test("取り込み待ちだけの置き場は、保存・同期を出さない（記録も送信も無い）", () => {
    const menu = buildStatusBarSyncMenu([
      { work: w("A"), status: tracked({ root: "C:/a", behind: 2 }) },
      { work: w("B"), status: tracked({ root: "C:/b", unmerged: 1 }) },
    ]);
    expect(kinds(menu)).toEqual(["work:B", "work:A", "log"]);
  });

  test("競合の残る置き場は同期が飛ばすので、保存・同期の数に入れない", () => {
    const menu = buildStatusBarSyncMenu([
      { work: w("競合"), status: tracked({ root: "C:/a", unmerged: 1, dirty: 4 }) },
      { work: w("送れる"), status: tracked({ root: "C:/b", ahead: 2 }) },
    ]);
    expect(kinds(menu)).toEqual(["syncAll", "work:競合", "work:送れる", "log"]);
    if (menu.kind !== "menu") throw new Error("一覧になるはず");
    expect(menu.choices[0].description).toBe("未送信 2");
  });

  test("送り先の無い置き場は候補にならず、何も無ければ nothing", () => {
    const menu = buildStatusBarSyncMenu([
      {
        work: w("送り先なし"),
        status: { kind: "no_remote", root: "C:/a", dirty: 3, dirtyHere: 3 },
      },
      { work: w("gitなし"), status: { kind: "git_missing" } },
    ]);
    expect(menu).toEqual({ kind: "nothing" });
  });

  test("手当ての要る置き場が1つだけ（分岐なし）なら、作品選びを飛ばして直接", () => {
    const menu = buildStatusBarSyncMenu([
      { work: w("一作"), status: tracked({ dirty: 2, ahead: 1 }) },
      { work: w("揃っている"), status: tracked({ root: "C:/b" }) },
    ]);
    expect(menu.kind).toBe("direct");
    if (menu.kind === "direct") expect(menu.work.title).toBe("一作");
  });

  test("書庫（1つの置き場に複数作品）は1行で、数は11倍にならない", () => {
    const menu = buildStatusBarSyncMenu([
      { work: w("一作目"), status: tracked({ dirty: 2 }) },
      { work: w("二作目"), status: tracked({ dirty: 2 }) },
      { work: w("別"), status: tracked({ root: "C:/b", ahead: 1 }) },
    ]);
    expect(kinds(menu)).toEqual(["syncAll", "work:一作目", "work:別", "log"]);
    if (menu.kind !== "menu") throw new Error("一覧になるはず");
    expect(menu.choices[0].description).toBe("未記録 2・未送信 1");
  });
});

describe("作品ごとの一覧に保存・同期を出すか", () => {
  test("送り先があり、記録待ちか未送信があれば出す", () => {
    expect(canSaveAndSync(tracked({ dirty: 1 }))).toBe(true);
    expect(canSaveAndSync(tracked({ ahead: 1 }))).toBe(true);
  });

  test("取り込み待ちだけ・揃っている・競合あり・送り先なし・git なしでは出さない", () => {
    expect(canSaveAndSync(tracked({ behind: 1 }))).toBe(false);
    expect(canSaveAndSync(tracked())).toBe(false);
    expect(canSaveAndSync(tracked({ dirty: 1, unmerged: 1 }))).toBe(false);
    expect(
      canSaveAndSync({ kind: "no_remote", root: "C:/a", dirty: 3, dirtyHere: 3 })
    ).toBe(false);
    expect(canSaveAndSync({ kind: "git_missing" })).toBe(false);
  });
});
