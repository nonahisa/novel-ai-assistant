import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { TreeItemCollapsibleState } from "vscode";
import {
  ACTION_GROUPS,
  ActionListProvider,
  groupedActions,
  restoreExpandedGroups,
  visibleActions,
  type ActionGroup,
  type GroupStateStore,
} from "../../src/views/actionList";
import type { WorkRegistry } from "../../src/core/workRegistry";

interface PackageManifest {
  contributes: { commands: Array<{ command: string }> };
}

/** 作品が1件ある体にする。分類の中身が空にならないようにするだけ */
function fakeRegistry(): WorkRegistry {
  return {
    list: () => [{ id: "w1" }],
    onDidChange: () => undefined,
  } as unknown as WorkRegistry;
}

function memoryStore(initial: string[] = []): GroupStateStore & {
  saved: string[];
} {
  const state = { saved: [...initial] };
  return {
    get saved() {
      return state.saved;
    },
    get: () => state.saved,
    set: (groups) => {
      state.saved = groups;
    },
  };
}

function collapsibleOf(
  provider: ActionListProvider,
  group: ActionGroup
): TreeItemCollapsibleState {
  return provider.getTreeItem({ type: "group", group })
    .collapsibleState as TreeItemCollapsibleState;
}

describe("操作メニューの分類", () => {
  test("決めた順に分類を並べる", () => {
    // 作業の流れで並べる。実装単位ではない
    expect(groupedActions(true).map((entry) => entry.group)).toEqual([
      ...ACTION_GROUPS,
    ]);
  });

  test("すべての操作がどれかの分類に入る", () => {
    const grouped = groupedActions(true).flatMap((entry) => entry.actions);

    expect(grouped).toHaveLength(visibleActions(true).length);
  });

  test("中身が無い分類は出さない", () => {
    // 作品未登録では「資料」「整える」「書き出す」が空になる
    const groups = groupedActions(false).map((entry) => entry.group);

    expect(groups).toEqual(["AI設定", "困ったとき"]);
    expect(groupedActions(false).every((entry) => entry.actions.length > 0)).toBe(
      true
    );
  });
});

describe("分類の開閉を覚える", () => {
  test("はじめはすべて閉じておく", () => {
    // 全部開くと13項目が縦に並び、作品一覧の場所が押し出される
    const provider = new ActionListProvider(fakeRegistry(), memoryStore());

    for (const group of ACTION_GROUPS) {
      expect(collapsibleOf(provider, group)).toBe(
        TreeItemCollapsibleState.Collapsed
      );
    }
  });

  test("開いた分類は次に開いたときも開いている", () => {
    const store = memoryStore();
    const first = new ActionListProvider(fakeRegistry(), store);
    first.setExpanded("資料", true);

    // 保存した内容から作り直す＝次回の起動にあたる
    const second = new ActionListProvider(fakeRegistry(), store);

    expect(collapsibleOf(second, "資料")).toBe(
      TreeItemCollapsibleState.Expanded
    );
    expect(collapsibleOf(second, "整える")).toBe(
      TreeItemCollapsibleState.Collapsed
    );
  });

  test("閉じ直したら記憶からも消す", () => {
    const store = memoryStore();
    const provider = new ActionListProvider(fakeRegistry(), store);

    provider.setExpanded("資料", true);
    provider.setExpanded("資料", false);

    expect(store.saved).toEqual([]);
    expect(
      collapsibleOf(new ActionListProvider(fakeRegistry(), store), "資料")
    ).toBe(TreeItemCollapsibleState.Collapsed);
  });

  test("記憶が無くても動く", () => {
    // 保存先を渡さない場合（テストや将来の呼び出し）でも落ちない
    const provider = new ActionListProvider(fakeRegistry());
    provider.setExpanded("資料", true);

    expect(provider.expandedGroups()).toEqual(["資料"]);
  });

  test("知らない分類名は読み込まない", () => {
    // 分類名を変えたり減らしたりしたときに、古い名前が残らないようにする
    expect([...restoreExpandedGroups(["資料", "むかしの分類"])]).toEqual([
      "資料",
    ]);
  });

  test("操作そのものは折りたためない", () => {
    const provider = new ActionListProvider(fakeRegistry(), memoryStore());
    const action = visibleActions(true)[0];

    expect(
      provider.getTreeItem({ type: "action", action }).collapsibleState
    ).toBe(TreeItemCollapsibleState.None);
  });
});

describe("操作メニューの一覧", () => {
  test("作品が未登録なら作品向けの操作を出さない", () => {
    // 押しても「作品が登録されていません」と言われるだけの項目は、
    // 押せない理由が作者に伝わらないので最初から並べない
    const commands = visibleActions(false).map((action) => action.command);

    expect(commands).not.toContain("novelai.extractSettings");
    expect(commands).not.toContain("novelai.generateSettingsDocs");
    expect(commands).not.toContain("novelai.showWorkStats");
  });

  test("作品が未登録でもAIの設定は出す", () => {
    // 作品を登録する前にAIを設定しておける
    const commands = visibleActions(false).map((action) => action.command);

    expect(commands).toContain("novelai.setupAI");
    expect(commands).toContain("novelai.testAI");
  });

  test("作品があれば全部の操作を出す", () => {
    expect(visibleActions(true).length).toBeGreaterThan(
      visibleActions(false).length
    );
    expect(visibleActions(true).map((action) => action.command)).toContain(
      "novelai.extractSettings"
    );
  });

  test("コマンドIDが重複していない", () => {
    const commands = visibleActions(true).map((action) => action.command);

    expect(new Set(commands).size).toBe(commands.length);
  });

  test("並べた操作はすべてpackage.jsonに登録されている", () => {
    // 一覧はコマンドIDを文字列で持つため、コマンドを改名すると
    // 何も起きないボタンが残る。実際に改名して壊した経験があるので固定する
    const manifest = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8")
    ) as PackageManifest;
    const declared = new Set(
      manifest.contributes.commands.map((entry) => entry.command)
    );

    for (const action of visibleActions(true)) {
      expect(declared, `${action.command} が package.json にない`).toContain(
        action.command
      );
    }
  });
});
