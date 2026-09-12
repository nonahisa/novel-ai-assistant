import { describe, expect, test } from "vitest";
import {
  ACTION_TREE,
  ActionListProvider,
  visibleGroups,
} from "../../src/views/actionList";
import type { WorkRegistry } from "../../src/core/workRegistry";

/**
 * 詳細メニューが丸ごと欠けないこと（実機確認 A-21、0.40.8 の保険）。
 *
 * **まっさらな環境で作品を11件登録した直後、分類の大半が消えた**
 * （2026-09-08、作者が実機で発見）。開き直すまで戻らず、
 * 「この拡張機能にはこれだけしか無い」と見える状態だった。
 *
 * 真因（何が例外を投げたか）は未特定のままで、直し方は
 * **「1項目で例外が出ても、分類ごと消さない」**という受け止め方である。
 * その受け止めに**テストが無かった**ので、ここで固定する。
 * 投げる場所として使えるのは印の計算（`ActionCounts`）で、
 * これは作品ごとのデータを読むため、登録の直後に最も投げやすい。
 */

/** 作品が n 件ある登録簿。provider は `list().length` と変更の通知しか使わない */
function registryWith(count: number): WorkRegistry {
  return {
    list: () => new Array(count).fill({}),
    onDidChange: () => ({ dispose: () => undefined }),
  } as unknown as WorkRegistry;
}

/** 印の計算が必ず投げる。登録の直後に壊れたデータを読んだ状態の代わり */
function throwingCounts(): () => number {
  return () => {
    throw new Error("印の計算が投げた（A-21 の再現）");
  };
}

describe("詳細メニューは、印の計算が投げても分類を欠けさせない（A-21）", () => {
  test("最上位の分類は、印が投げても全部そろう", () => {
    const provider = new ActionListProvider(
      registryWith(11),
      undefined,
      throwingCounts()
    );

    const groups = provider.getChildren();

    expect(groups.map((node) => node.type)).toEqual(
      ACTION_TREE.map(() => "group")
    );
  });

  test("**分類の見出しは、印が投げても素の表示で残る**", () => {
    // 0.40.8 より前はここで例外がそのまま出て、VS Code がその節点を
    // 落としていた（7分類が3分類に減った）
    const provider = new ActionListProvider(
      registryWith(11),
      undefined,
      throwingCounts()
    );

    const labels = provider
      .getChildren()
      .map((node) => provider.getTreeItem(node).label);

    expect(labels).toEqual(ACTION_TREE.map((group) => group.label));
  });

  test("分類の中身も、印が投げても並ぶ", () => {
    const provider = new ActionListProvider(
      registryWith(1),
      undefined,
      throwingCounts()
    );

    for (const group of provider.getChildren()) {
      expect(provider.getChildren(group).length).toBeGreaterThan(0);
    }
  });
});

describe("作品の登録の仕方は、分類の並びに関わらない（A-21 の残り2項目）", () => {
  /**
   * 項目は「1作品だけ登録したときも同じか（一括登録に限る話かどうか）」と
   * 「GitHubから作品を追加・新規作品を作成でも同じか」だった。
   *
   * **どちらも、並ぶものを決める側が作品を見ていない。**
   * `visibleGroups` は引数を使わず `ACTION_TREE` をそのまま返し、
   * 分類の中身も作品ごとに変わらない（押せるかどうかだけが変わる。
   * `isActionEnabled`）。**登録の件数でも経路でも、並びは1通りしかない。**
   */
  test("0件・1件・11件で、分類も中身も同じ", () => {
    const shape = (count: number) =>
      new ActionListProvider(registryWith(count))
        .getChildren()
        .map((group) => [
          group.type === "group" ? group.label ?? group.group.label : "",
          new ActionListProvider(registryWith(count)).getChildren(group).length,
        ]);

    expect(shape(1)).toEqual(shape(0));
    expect(shape(11)).toEqual(shape(0));
  });

  test("並びを決める側は、作品を見ていない", () => {
    expect(visibleGroups(false)).toEqual(visibleGroups(true));
    expect(visibleGroups(true)).toEqual(ACTION_TREE);
  });
});
