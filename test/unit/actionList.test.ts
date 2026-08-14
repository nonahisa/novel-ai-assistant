import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { TreeItemCollapsibleState } from "vscode";
import {
  ACTION_TREE,
  ActionListProvider,
  actionResourceUri,
  allActions,
  restoreExpandedGroups,
  visibleGroups,
  type ActionNode,
  type GroupStateStore,
} from "../../src/views/actionList";
import { ActionDecorationProvider } from "../../src/views/actionDecorations";
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

/** 分類の節点を作る。名前で引けないと、テストが並び順に縛られる */
function groupNode(label: string): ActionNode {
  const group = ACTION_TREE.find((entry) => entry.label === label);
  if (!group) throw new Error(`分類「${label}」がありません`);
  return { type: "group", group };
}

function actionNode(command: string): ActionNode {
  const item = allActions().find((entry) => entry.command === command);
  if (!item) throw new Error(`操作「${command}」がありません`);
  return { type: "action", item };
}

/** 小分類の節点を作る */
function sectionNode(groupLabel: string, sectionLabel: string): ActionNode {
  const group = ACTION_TREE.find((entry) => entry.label === groupLabel);
  if (!group) throw new Error(`分類「${groupLabel}」がありません`);
  const section = group.entries.find(
    (entry) => entry.kind === "section" && entry.label === sectionLabel
  );
  if (!section || section.kind !== "section") {
    throw new Error(`小分類「${sectionLabel}」がありません`);
  }
  return { type: "section", section, groupLabel };
}

function commandsOf(hasWork: boolean): string[] {
  return visibleGroups(hasWork).flatMap((group) =>
    group.entries.flatMap((entry) =>
      entry.kind === "section"
        ? entry.items.map((item) => item.command)
        : [entry.command]
    )
  );
}

describe("操作メニューの構成", () => {
  test("分類は決めた順に並ぶ", () => {
    // 作業の目的で並べる。実装単位ではない
    expect(ACTION_TREE.map((group) => group.label)).toEqual([
      "執筆データ",
      "作品管理",
      "執筆AI支援",
      "資料管理",
      "拡張機能の設定",
      "ヘルプ",
    ]);
  });

  test("コマンドIDが重複していない", () => {
    const commands = allActions().map((action) => action.command);

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

    for (const action of allActions()) {
      expect(declared, `${action.command} が package.json にない`).toContain(
        action.command
      );
    }
  });

  test("作品が未登録なら作品向けの操作を出さない", () => {
    // 押しても「作品が登録されていません」と言われるだけの項目は、
    // 押せない理由が作者に伝わらないので最初から並べない
    const commands = commandsOf(false);

    expect(commands).not.toContain("novelai.extractSettings");
    expect(commands).not.toContain("novelai.showWorkStats");
    expect(commands).not.toContain("novelai.gitSync");
  });

  test("作品が未登録でも、始める操作と設定は出す", () => {
    // 作品を作る前にAIやOllamaを整えておける
    const commands = commandsOf(false);

    expect(commands).toContain("novelai.createWorkWithPlot");
    expect(commands).toContain("novelai.addWork");
    expect(commands).toContain("novelai.addWorkFromGithub");
    expect(commands).toContain("novelai.setupAI");
    expect(commands).toContain("novelai.showLog");
  });

  test("中身が空になった小分類・分類は出さない", () => {
    // 作品未登録では「執筆データ」「資料管理」が丸ごと空になる
    const labels = visibleGroups(false).map((group) => group.label);

    expect(labels).not.toContain("執筆データ");
    expect(labels).not.toContain("資料管理");
    for (const group of visibleGroups(false)) {
      expect(group.entries.length).toBeGreaterThan(0);
      for (const entry of group.entries) {
        if (entry.kind === "section") {
          expect(entry.items.length).toBeGreaterThan(0);
        }
      }
    }
  });

  test("作品を要さない小分類は、作品が無くても中身が残る", () => {
    const 作品管理 = visibleGroups(false).find(
      (group) => group.label === "作品管理"
    );
    const sections = (作品管理?.entries ?? []).filter(
      (entry) => entry.kind === "section"
    );

    // 「GitHubで作品管理」は作品が要るので消え、「新作開始」「既存作追加」は残る
    expect(sections.map((section) => section.label)).toEqual([
      "新作開始",
      "既存作追加",
    ]);
  });
});

describe("AIの印", () => {
  test("印が付くのはAIを呼ぶ操作だけ", () => {
    // クラウドのAIは実行のたびに課金される。印の付け忘れ・付けすぎは
    // どちらも作者の判断を誤らせるので、一覧を固定する
    const aiCommands = allActions()
      .filter((action) => action.usesAI)
      .map((action) => action.command)
      .sort();

    expect(aiCommands).toEqual(
      [
        "novelai.checkTypos",
        "novelai.extractSettings",
        "novelai.generateCatchphrases",
        "novelai.generateSynopses",
        "novelai.generateWorkBlurb",
      ].sort()
    );
  });

  test("種別ごとの書き出しにはAIの印を付けない", () => {
    // 抽出済みのJSONから書き出すだけなので、AIは呼ばないし料金も出ない
    for (const command of [
      "novelai.generateCharacterDocs",
      "novelai.generateLocationDocs",
      "novelai.generateAbilityDocs",
      "novelai.generateWorldDocs",
      "novelai.generateSettingsDocs",
      "novelai.exportImeDictionary",
    ]) {
      const action = allActions().find((entry) => entry.command === command);
      expect(action?.usesAI, `${command}`).toBeFalsy();
    }
  });
});

describe("件数の印", () => {
  test("0件のときは何も出さない", () => {
    // 「0」と出ていると、何かあると思って開いてしまう
    const provider = new ActionDecorationProvider(async () => 0);

    expect(
      provider.provideFileDecoration(
        actionResourceUri(actionNode("novelai.applyPendingUpdates"))
      )
    ).toBeUndefined();
  });

  test("溜まっていれば件数を出す", async () => {
    const provider = new ActionDecorationProvider(async () => 3);
    await provider.refresh();

    expect(
      provider.provideFileDecoration(
        actionResourceUri(actionNode("novelai.applyPendingUpdates"))
      )?.badge
    ).toBe("3");
    // 分類を閉じたままでも気づけるよう、見出しにも出す
    expect(
      provider.provideFileDecoration(actionResourceUri(groupNode("資料管理")))
        ?.badge
    ).toBe("3");
  });

  test("分類と操作の間の小分類にも出す", async () => {
    // 分類を開いた作者に見えるのは小分類の行だけ。そこに印が無いと、
    // どれを開けば件数の元があるのか辿れない（実機で発覚、2026-08-14）
    const provider = new ActionDecorationProvider(async () => 3);
    await provider.refresh();

    expect(
      provider.provideFileDecoration(
        actionResourceUri(sectionNode("資料管理", "資料生成"))
      )?.badge
    ).toBe("3");
  });

  test("件数を持たない小分類には出さない", async () => {
    const provider = new ActionDecorationProvider(async () => 3);
    await provider.refresh();

    expect(
      provider.provideFileDecoration(
        actionResourceUri(sectionNode("執筆AI支援", "校正・校閲"))
      )
    ).toBeUndefined();
  });

  test("3桁以上は99で止める", async () => {
    // 印は2文字までしか出せない。切れた数字を見せるより上限で止める
    const provider = new ActionDecorationProvider(async () => 128);
    await provider.refresh();

    expect(
      provider.provideFileDecoration(
        actionResourceUri(actionNode("novelai.applyPendingUpdates"))
      )?.badge
    ).toBe("99");
  });

  test("AIを呼ぶ操作には「AI」と出す", () => {
    const provider = new ActionDecorationProvider(async () => 0);

    expect(
      provider.provideFileDecoration(
        actionResourceUri(actionNode("novelai.checkTypos"))
      )?.badge
    ).toBe("AI");
    expect(
      provider.provideFileDecoration(
        actionResourceUri(actionNode("novelai.generateSettingsDocs"))
      )
    ).toBeUndefined();
  });

  test("数えられなくてもメニューは出す", async () => {
    // 設定JSONが壊れていても、操作そのものは押せるべき
    const provider = new ActionDecorationProvider(async () => {
      throw new Error("読めません");
    });

    await expect(provider.refresh()).resolves.toBeUndefined();
    expect(provider.countOf("pendingUpdates")).toBe(0);
  });
});

describe("開閉を覚える", () => {
  const collapsibleOf = (
    provider: ActionListProvider,
    node: ActionNode
  ): TreeItemCollapsibleState =>
    provider.getTreeItem(node).collapsibleState as TreeItemCollapsibleState;

  test("はじめはすべて閉じておく", () => {
    // 全部開くと40項目近くが縦に並び、作品一覧の場所が押し出される
    const provider = new ActionListProvider(fakeRegistry(), memoryStore());

    for (const group of ACTION_TREE) {
      expect(collapsibleOf(provider, groupNode(group.label))).toBe(
        TreeItemCollapsibleState.Collapsed
      );
    }
  });

  test("開いた分類は次に開いたときも開いている", () => {
    const store = memoryStore();
    new ActionListProvider(fakeRegistry(), store).setExpanded("資料管理", true);

    // 保存した内容から作り直す＝次回の起動にあたる
    const second = new ActionListProvider(fakeRegistry(), store);

    expect(collapsibleOf(second, groupNode("資料管理"))).toBe(
      TreeItemCollapsibleState.Expanded
    );
    expect(collapsibleOf(second, groupNode("作品管理"))).toBe(
      TreeItemCollapsibleState.Collapsed
    );
  });

  test("小分類も分類とは別に覚える", () => {
    // 「作品管理」を開いても「新作開始」まで開いた状態にはしない
    const store = memoryStore();
    const provider = new ActionListProvider(fakeRegistry(), store);

    provider.setExpanded("作品管理/新作開始", true);

    expect(store.saved).toEqual(["作品管理/新作開始"]);
    expect([...restoreExpandedGroups(store.saved)]).toEqual([
      "作品管理/新作開始",
    ]);
  });

  test("閉じ直したら記憶からも消す", () => {
    const store = memoryStore();
    const provider = new ActionListProvider(fakeRegistry(), store);

    provider.setExpanded("資料管理", true);
    provider.setExpanded("資料管理", false);

    expect(store.saved).toEqual([]);
  });

  test("知らない分類名は読み込まない", () => {
    // 分類名を変えたり減らしたりしたときに、古い名前が残らないようにする
    expect([
      ...restoreExpandedGroups(["資料管理", "むかしの分類", "資料"]),
    ]).toEqual(["資料管理"]);
  });

  test("記憶が無くても動く", () => {
    const provider = new ActionListProvider(fakeRegistry());
    provider.setExpanded("ヘルプ", true);

    expect(provider.expandedGroups()).toEqual(["ヘルプ"]);
  });

  test("操作そのものは折りたためない", () => {
    const provider = new ActionListProvider(fakeRegistry(), memoryStore());

    expect(
      provider.getTreeItem(actionNode("novelai.showLog")).collapsibleState
    ).toBe(TreeItemCollapsibleState.None);
  });
});
