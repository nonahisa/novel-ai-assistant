import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { TreeItemCollapsibleState } from "vscode";
import {
  ACTION_TREE,
  ActionListProvider,
  actionResourceUri,
  allActions,
  disabledHint,
  explainDisabled,
  isActionEnabled,
  REQUIRES_WORK_HINT,
  restoreExpandedGroups,
  visibleGroups,
  type ActionNode,
  type GroupStateStore,
} from "../../src/views/actionList";
import {
  PROCESSES_BLOCKED_HINT,
  processRequiredCommands,
} from "../../src/core/processAvailability";
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

  test("作品が未登録でも、操作は消さずに出す", () => {
    // **消していた。** そのため作品を登録していない状態では、6つある
    // 分類のうち3つが丸ごと消え、残る操作は13件だけだった。
    // 初めて使う人には、そもそも何ができる拡張機能なのかが分からない
    // （作者の指示、2026-08-17）
    const commands = commandsOf(false);

    expect(commands).toContain("novelai.extractSettings");
    expect(commands).toContain("novelai.showWorkStats");
    expect(commands).toContain("novelai.gitSync");
  });

  test("作品が無ければ、作品を要する操作は押せない", () => {
    for (const action of allActions()) {
      expect(isActionEnabled(action, false), action.command).toBe(
        !action.requiresWork
      );
      // 作品があれば、すべて押せる
      expect(isActionEnabled(action, true), action.command).toBe(true);
    }
  });

  test("押せない理由を、どうすれば使えるかまで書く", () => {
    // 「使えない」だけでは、次に何をすればよいか分からない
    expect(REQUIRES_WORK_HINT).toContain("作品を登録すると");
  });

  /**
   * ブラウザ版（vscode.dev）では、外部プロセス（git・Ollama）を
   * 起動できない（設計書5.8.5）。**消すのではなく、押せなくして
   * 理由を出す**——編集者モードと同じ考え方を、実行環境にも広げた。
   */
  describe("外部プロセスを起動できない環境（ブラウザ版）", () => {
    test("該当する操作だけが押せなくなる", () => {
      for (const action of allActions()) {
        const needsProcesses = processRequiredCommands().includes(
          action.command
        );
        expect(
          isActionEnabled(action, true, "author", false),
          action.command
        ).toBe(!needsProcesses);
      }
    });

    test("手元（Node）扱いのときは、これまでどおり全部押せる", () => {
      for (const action of allActions()) {
        expect(
          isActionEnabled(action, true, "author", true),
          action.command
        ).toBe(true);
      }
    });

    test("理由には、代わりの道が書いてある", () => {
      // 別のリポジトリを開く道は、ブラウザでもある（アドレス欄を書き換える）
      const action = allActions().find(
        (entry) => entry.command === "novelai.addWorkFromGithub"
      );
      expect(action).toBeDefined();
      if (!action) return;

      const hint = disabledHint(action, true, "author", false);
      expect(hint).toBe(PROCESSES_BLOCKED_HINT);
      expect(explainDisabled(action, hint)).toContain("vscode.dev");
    });

    test("同期は塞がない。押せばソース管理へ案内する（設計書5.8.9）", () => {
      // **行き止まりにしない。** gitコマンドは打てないが、保存する道は在る
      const action = allActions().find(
        (entry) => entry.command === "novelai.gitSync"
      );
      expect(action).toBeDefined();
      if (!action) return;

      expect(isActionEnabled(action, true, "author", false)).toBe(true);
      expect(disabledHint(action, true, "author", false)).toBeUndefined();
    });

    test("編集者モードの制限と、実行環境の制限は両方効く", () => {
      // novelai.resolveConflicts は編集者モードでは許されているが、
      // ブラウザでは使えない。両方の理由を正しく見分けられること
      const action = allActions().find(
        (entry) => entry.command === "novelai.resolveConflicts"
      );
      expect(action).toBeDefined();
      if (!action) return;

      expect(isActionEnabled(action, true, "editor", true)).toBe(true);
      expect(isActionEnabled(action, true, "editor", false)).toBe(false);
      expect(disabledHint(action, true, "editor", false)).toBe(
        PROCESSES_BLOCKED_HINT
      );
    });
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

  test("作品の有無で、並ぶものが変わらない", () => {
    // **分類が丸ごと消えると、何ができる拡張機能か分からなくなる**
    const withWork = visibleGroups(true).map((group) => group.label);
    const without = visibleGroups(false).map((group) => group.label);

    expect(without).toEqual(withWork);
    expect(without).toContain("執筆データ");
    expect(without).toContain("資料管理");
    for (const group of visibleGroups(false)) {
      expect(group.entries.length).toBeGreaterThan(0);
      for (const entry of group.entries) {
        if (entry.kind === "section") {
          expect(entry.items.length).toBeGreaterThan(0);
        }
      }
    }
  });

  test("小分類も、作品が無くても消えない", () => {
    const 作品管理 = visibleGroups(false).find(
      (group) => group.label === "作品管理"
    );
    const sections = (作品管理?.entries ?? []).filter(
      (entry) => entry.kind === "section"
    );

    // 「GitHubで作品管理」は作品が要るが、**消さずに出して押せなくする**
    expect(sections.map((section) => section.label)).toEqual([
      "GitHubで作品管理",
      "編集部とやり取り",
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
        "novelai.plotInterview",
        "novelai.checkTypos",
        "novelai.checkProofread",
        "novelai.checkContradictions",
        "novelai.checkDeviations",
        "novelai.extractSettings",
        "novelai.extractCharactersOnly",
        "novelai.extractLocationsOnly",
        "novelai.extractAbilitiesOnly",
        "novelai.extractOrganizationsOnly",
        "novelai.extractWorldOnly",
        "novelai.generateCatchphrases",
        "novelai.generatePlot",
        "novelai.generateSynopses",
        "novelai.generateWorkBlurb",
        "novelai.openChat",
      ].sort()
    );
  });

  test("種別ごとの抽出にはAIの印を付ける", () => {
    // 2種類目からはキャッシュが効いてAIを呼ばないが、初回は呼ぶ。
    // 「呼ばないこともある」は印を外す理由にならない
    for (const command of [
      "novelai.extractCharactersOnly",
      "novelai.extractLocationsOnly",
      "novelai.extractAbilitiesOnly",
      "novelai.extractOrganizationsOnly",
      "novelai.extractWorldOnly",
    ]) {
      const action = allActions().find((entry) => entry.command === command);
      expect(action?.usesAI, `${command}`).toBe(true);
    }
  });

  test("書き出しにはAIの印を付けない", () => {
    // 抽出済みのJSONから書き出すだけなので、AIは呼ばないし料金も出ない
    for (const command of [
      "novelai.generateSettingsDocs",
      "novelai.exportImeDictionary",
    ]) {
      const action = allActions().find((entry) => entry.command === command);
      expect(action?.usesAI, `${command}`).toBeFalsy();
    }
  });

  test("表記ゆれ検知にはAIの印を付けない", () => {
    // ルールだけで判定するので料金がかからない。誤字脱字検知と並ぶため、
    // 印の有無で見分けられることに意味がある
    const action = allActions().find(
      (entry) => entry.command === "novelai.checkNotation"
    );
    expect(action?.usesAI).toBeFalsy();
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
        actionResourceUri(sectionNode("資料管理", "資料抽出"))
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

describe("操作メニューの印の色", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf-8")) as {
    contributes: {
      colors?: { id: string; defaults: Record<string, string> }[];
    };
  };

  /**
   * コードが使う色IDが `package.json` に無いと、VS Codeは**黙って色を付けない**。
   * 例外も警告も出ないので、綴りを間違えても気づけない。
   */
  test("コードが使う色IDが package.json に定義されている", () => {
    const source = readFileSync("src/views/actionDecorations.ts", "utf-8");
    const used = [...source.matchAll(/ThemeColor\("(novelai\.[^"]+)"\)/g)].map(
      (m) => m[1]
    );
    expect(used.length).toBeGreaterThan(0);

    const declared = (pkg.contributes.colors ?? []).map((c) => c.id);
    for (const id of used) {
      expect(declared).toContain(id);
    }
  });

  test("明るいテーマと暗いテーマの両方に色がある", () => {
    for (const color of pkg.contributes.colors ?? []) {
      // 片方だけ決めると、決めていないほうは既定の薄い色に戻る
      expect(color.defaults.light).toMatch(/^#[0-9a-f]{6}$/i);
      expect(color.defaults.dark).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });
});
