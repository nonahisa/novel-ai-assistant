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
  isItemShownInActionList,
  isItemVisibleInRuntime,
  shownEntries,
  visibleEntries,
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
  contributes: {
    commands: Array<{ command: string }>;
    menus: { commandPalette: Array<{ command: string; when: string }> };
  };
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
      // **最下段に「テスト中」**（作者の指定、2026-08-26）。
      // 中身は確認リストから自動生成する。残りが尽きれば自然に消える
      "テスト中",
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
    expect(commands).toContain("novelai.showWritingStats");
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
      // 過去の版は、GitHubのサイトで履歴を開けば見て写せる
      const action = allActions().find(
        (entry) => entry.command === "novelai.gitRestore"
      );
      expect(action).toBeDefined();
      if (!action) return;

      const hint = disabledHint(action, true, "author", false);
      expect(hint).toBe(PROCESSES_BLOCKED_HINT);
      expect(explainDisabled(action, hint)).toContain("GitHub");
    });

    /**
     * **GitHubからの追加は、ブラウザでも押せる**（設計書5.8.12）。
     *
     * 取り寄せる（`git clone`）代わりに、GitHubの中身を直に読む仕組みを
     * 指す。**やることが同じなら、道具が違っても塞がない。**
     */
    test("GitHubから作品を追加は、ブラウザでも押せる", () => {
      const action = allActions().find(
        (entry) => entry.command === "novelai.addWorkFromGithub"
      );
      expect(action).toBeDefined();
      if (!action) return;
      expect(isActionEnabled(action, true, "author", false)).toBe(true);
      expect(disabledHint(action, true, "author", false)).toBeUndefined();
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
    //
    // **並び順も見る。** 「編集部とやり取り」は作者の指示で末尾へ移した
    // （2026-08-31）。編集部と組まない作者には出番が無く、毎日使う
    // 「新作開始」「既存作追加」より上にあると目が滑る
    expect(sections.map((section) => section.label)).toEqual([
      "GitHubで作品管理",
      "新作開始",
      "既存作追加",
      "編集部とやり取り",
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
        // 単話プロットの検査・本文との照合（P-27・P-28。設計書6.36.3）。
        // **入口は1つ。** どちらを掛けるかは実行時に選ぶ
        "novelai.checkEpisodePlot",
        // 伏線の検知（配置・回収。設計書6.35.2・6.35.3）。
        // **一覧を開く・手で追加・状態を変えるは、AIを呼ばないので入らない**
        "novelai.checkForeshadows",
        "novelai.checkForeshadowResolution",
        "novelai.checkOpening",
        "novelai.extractSettings",
        "novelai.extractCharactersOnly",
        "novelai.extractLocationsOnly",
        "novelai.extractAbilitiesOnly",
        "novelai.extractOrganizationsOnly",
        "novelai.extractWorldOnly",
        "novelai.generateCatchphrases",
        // 更新告知文（P-30）。**告知の設定は入らない**——訊いて保存するだけで
        // AIを呼ばないので、印を付けると料金が出るように見える
        "novelai.generateAnnouncement",
        "novelai.generatePlot",
        "novelai.generateSynopses",
        "novelai.generateWorkBlurb",
        // 相談のメニューの入口は「大きく開く」だけ（横の細いパネルは
        // 本文の右クリックのみ。0.29.23で項目を消した——作者の指定）
        "novelai.openChatPanel",
        // 読める長さの測定（設計書6.27.11）。作品の本文は送らないが、
        // **AIを何度も呼ぶ**ので有料AIでは料金が出る。印は要る
        "novelai.measureContext",
        // 章立ての提案（P-31、設計書6.66.4）。**手で章を作る操作
        // （ここから章を始める・名前を変える・外す）は詳細メニューに無い**
        // ——作品一覧の右クリックだけで、AIも呼ばない
        "novelai.proposeChapters",
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

  test("詳細メニューは全作品を合わせて数える", async () => {
    // **作品を選ばずに見るメニュー**なので、「どこかに溜まっている」ことが
    // 分かればよい（設計書6.17）。簡単ステップメニューが選択中の作品だけを
    // 数えるようになっても（2026-09-05）、こちらは合算のままにする
    const provider = new ActionDecorationProvider(async (_counter, workId) =>
      workId === undefined ? 26 : 2
    );
    await provider.refresh();

    expect(
      provider.provideFileDecoration(
        actionResourceUri(actionNode("novelai.unifyCharacters"))
      )?.badge
    ).toBe("26");
    expect(
      provider.provideFileDecoration(actionResourceUri(groupNode("資料管理")))
        ?.badge
    ).toBe("26");
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

/**
 * 校正・校閲の並び（作者の指示、2026-08-22）。
 *
 * 「『編集部からの提案を見る』を一番下、『校閲を始める／終える』をその上に
 * 配置してください」。
 *
 * **並びは作者が決めたものなので、機械で留める。** 項目を足すときに、
 * うっかり末尾へ差し込むと崩れる——崩れても動きは変わらないので、
 * 実機で気づくまで分からない。
 */
describe("校正・校閲の並び", () => {
  function proofreadingSection() {
    for (const group of ACTION_TREE) {
      for (const entry of group.entries) {
        if (entry.kind === "section" && entry.label === "校正・校閲") {
          return entry;
        }
      }
    }
    throw new Error("「校正・校閲」が見つかりません");
  }

  test("編集部とのやり取りは、いちばん下の2つに置く", () => {
    const commands = proofreadingSection().items.map((item) => item.command);

    expect(commands[commands.length - 1]).toBe("novelai.reviewProposals");
    expect(commands[commands.length - 2]).toBe("novelai.toggleReviewLock");
  });

  test("作者が1人で回す作業が、その上に並ぶ", () => {
    // 毎日通るのは上のほう。相手のいる作業を上に置くと、そこを通り抜ける
    const commands = proofreadingSection().items.map((item) => item.command);

    expect(commands[0]).toBe("novelai.checkTypos");
    expect(commands).toContain("novelai.checkProofread");
    // 校閲ロックより前に、検知の類がすべて並んでいる
    const lockAt = commands.indexOf("novelai.toggleReviewLock");
    for (const command of [
      "novelai.checkTypos",
      "novelai.checkNotation",
      "novelai.checkProofread",
      "novelai.checkDeviations",
      "novelai.checkContradictions",
    ]) {
      expect(commands.indexOf(command), command).toBeLessThan(lockAt);
    }
  });
});

/**
 * 投稿キット（設計書6.68）。
 *
 * **入口は2つとも同じ小分類に置く。** 「新話を投稿する」と、その設定
 * （サイト・URL・投稿済みの基準線）が離れていると、URLを直したいときに
 * どこを探せばよいのか分からない。
 */
describe("投稿キットの入口", () => {
  function otherSupport() {
    for (const group of ACTION_TREE) {
      for (const entry of group.entries) {
        if (entry.kind === "section" && entry.label === "その他支援") {
          return entry;
        }
      }
    }
    throw new Error("「その他支援」が見つかりません");
  }

  test("「新話を投稿する」と「投稿サイトの設定」が同じ小分類に並ぶ", () => {
    const commands = otherSupport().items.map((item) => item.command);

    expect(commands).toContain("novelai.postNewEpisode");
    expect(commands).toContain("novelai.configurePostingSites");
    // 投稿サイト用のコピーの隣（同じ場面で使う操作をばらけさせない）
    expect(commands.indexOf("novelai.configurePostingSites")).toBe(
      commands.indexOf("novelai.postNewEpisode") + 1
    );
  });

  /**
   * ランキングの記録（設計書6.68.5）。**設定の隣に置く。**
   * サイトごとの作品情報を入れる画面（設定）と、そこで見た順位を書き足す
   * 操作は、同じ「投稿サイトとのやり取り」の場面で使う。
   */
  test("「ランキングを記録する」が、投稿サイトの設定の隣に並ぶ", () => {
    const commands = otherSupport().items.map((item) => item.command);

    expect(commands.indexOf("novelai.recordRanking")).toBe(
      commands.indexOf("novelai.configurePostingSites") + 1
    );
  });

  /** **AIは呼ばない。** 呼ぶのは最後の更新告知（別の操作）だけである */
  test("どちらにもAIの印を付けない", () => {
    for (const command of [
      "novelai.postNewEpisode",
      "novelai.configurePostingSites",
      "novelai.recordRanking",
    ]) {
      const action = allActions().find((entry) => entry.command === command);
      expect(action?.usesAI, command).toBeFalsy();
    }
  });
});

describe("ブラウザ版でだけ出す操作", () => {
  /**
   * 作者の指摘（2026-08-26）：「操作メニューのヘルプの動作を診断ってまだ使うでしょうか？」
   *
   * ブラウザ版で保存できないときの切り分けに作ったもので、**手元では出番が無い**。
   * この作品の原則は「消さずに押せなくして理由を出す」だが、ここは例外である
   * ——**手元でも動くので、押せない理由を書けない。**
   */
  test("手元のVS Codeでは出さない", () => {
    const item = allActions().find(
      (action) => action.command === "novelai.diagnoseWeb"
    );

    expect(item?.browserOnly).toBe(true);
    expect(isItemVisibleInRuntime(item!, true)).toBe(false);
  });

  test("ブラウザ版では出す", () => {
    const item = allActions().find(
      (action) => action.command === "novelai.diagnoseWeb"
    );

    expect(isItemVisibleInRuntime(item!, false)).toBe(true);
  });

  test("印の無い操作は、どちらでも出す", () => {
    const item = allActions().find(
      (action) => action.command === "novelai.showVersion"
    );

    expect(isItemVisibleInRuntime(item!, true)).toBe(true);
    expect(isItemVisibleInRuntime(item!, false)).toBe(true);
  });

  test("小分類は絞り込みで消えない", () => {
    // 中身が空になっても見出しは残す（`visibleEntries` は action だけを見る）
    const entries = [
      { kind: "section" as const, label: "小分類", items: [] },
      {
        kind: "action" as const,
        command: "novelai.diagnoseWeb",
        label: "診断",
        icon: "pulse",
        requiresWork: false,
        detail: "",
        browserOnly: true,
      },
    ];

    expect(visibleEntries(entries, true)).toHaveLength(1);
    expect(visibleEntries(entries, false)).toHaveLength(2);
  });

  test("コマンドそのものは残す", () => {
    // 手元で切り分けが要るときは、コマンドパレットから呼べる
    const commands = allActions().map((action) => action.command);

    expect(commands).toContain("novelai.diagnoseWeb");
  });
});

/**
 * 相談の入口を、相談の画面そのものへ移した（作者の指定、2026-09-03）。
 *
 * 横の細いパネルの「メインに表示」ボタンが入口になったので、詳細メニューの
 * 項目は要らなくなった。**ただし木からは消さない**——簡単ステップメニューが
 * コマンドIDでこの項目を引いており（`stepMenu.ts`）、消すと見出しと説明を
 * 失う。0.29.9 で作った `hiddenFromActionList`（設計書6.56.3）で、
 * 実体を残したまま画面にだけ出さない。
 */
describe("相談の項目は、木に残して画面から隠す", () => {
  function chatPanelAction() {
    return allActions().find(
      (action) => action.command === "novelai.openChatPanel"
    );
  }

  test("木には残る（簡単ステップメニューが参照している）", () => {
    const action = chatPanelAction();

    expect(action, "木から消すと簡単ステップメニューが壊れる").toBeTruthy();
    expect(action?.label).toBe("AIに相談する（大きく開く）");
    // 隠すのは画面だけ。動く環境かどうかの判定には混ぜない
    expect(isItemVisibleInRuntime(action!, true)).toBe(true);
  });

  test("詳細メニューの画面には出さない", () => {
    const action = chatPanelAction();

    expect(action?.hiddenFromActionList).toBe(true);
    expect(isItemShownInActionList(action!, true)).toBe(false);
  });

  test("「執筆AI支援」を描画すると、この項目だけが落ちる", () => {
    const group = ACTION_TREE.find((entry) => entry.label === "執筆AI支援");
    const has = (entries: readonly { kind: string }[]) =>
      entries.some(
        (entry) =>
          entry.kind === "action" &&
          (entry as { command: string }).command === "novelai.openChatPanel"
      );

    // 画面（getChildren）が使うのは shownEntries のほう
    expect(has(shownEntries(group!.entries, true))).toBe(false);
    // AIへ渡す機能の一覧・実機確認リストが使うほうには残る
    expect(has(visibleEntries(group!.entries, true))).toBe(true);
    // 見出しごと畳まれてはいない（ほかの操作が残っている）
    expect(shownEntries(group!.entries, true).length).toBeGreaterThan(0);
  });

  /**
   * 「EPUBへ書き出す」の入口を、エディターの中へ一本化した
   * （作者の指定、2026-09-04）。書き出しボタンはEPUBエディターの中に
   * 既にあり、外にも同じ入口があると「どちらから出すのが正しいのか」が
   * 分からない。**コマンド自体は残す**（エディターから呼ぶため）。
   */
  test("EPUBの書き出しは、木に残したまま画面から隠す", () => {
    const action = allActions().find(
      (entry) => entry.command === "novelai.exportEpub"
    );

    expect(action, "木から消すとエディターの説明の出どころが無くなる").toBeTruthy();
    expect(action?.hiddenFromActionList).toBe(true);
    expect(isItemShownInActionList(action!, true)).toBe(false);
    // 隠すのは画面だけ。動く環境かどうかの判定には混ぜない
    expect(isItemVisibleInRuntime(action!, true)).toBe(true);
  });

  /**
   * **コマンドパレットも塞ぐ**（0.32.0のレビュー）。詳細メニューからだけ
   * 消しても、Ctrl+Shift+P で「EPUBを書き出す（試作）」が出てきては
   * 「どちらから出すのが正しいのか」が分からないままである。
   */
  test("EPUBの書き出しは、コマンドパレットにも出さない", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8")
    ) as PackageManifest;
    const hidden = manifest.contributes.menus.commandPalette
      .filter((entry) => entry.when === "false")
      .map((entry) => entry.command);

    expect(hidden).toContain("novelai.exportEpub");
  });

  test("「相談する作品を選ぶ」はそのまま出す", () => {
    const chooseWork = allActions().find(
      (action) => action.command === "novelai.chooseChatWork"
    );

    expect(chooseWork, "相談する作品を選ぶが見当たらない").toBeTruthy();
    expect(chooseWork?.hiddenFromActionList).toBeFalsy();
  });
});

describe("開発ビルドでだけ出す操作（ストリーミング実験）", () => {
  /**
   * F5限定の実験（設計書6.63.1）を、押して入切できるようにした
   * （作者の依頼、2026-09-03）。環境変数 `NOVELAI_OLLAMA_STREAM=1` を
   * `.vscode/launch.json` へ書く道しか無く、試すまでが遠すぎた。
   *
   * **`browserOnly` とは扱いが違う。** あちらは定義を残して出さないだけだが、
   * こちらは**本番ビルドでは定義ごと落ちる**（`__DEV_HELPERS__` の枝の中で
   * 展開している）。試験は開発ビルドとして走るので、ここでは在ることを見る。
   */
  function toggle() {
    return allActions().find(
      (action) => action.command === "novelai.dev.toggleOllamaStream"
    );
  }

  test("AIの小分類に、開発用の印つきで並ぶ", () => {
    const item = toggle();

    expect(item?.devOnly).toBe(true);
    // 環境で消す印（browserOnly）とは別物。手元でもブラウザ版でも出す
    expect(isItemVisibleInRuntime(item!, true)).toBe(true);
  });

  test("置き場所は「拡張機能の設定」→「AI」", () => {
    const group = ACTION_TREE.find((entry) => entry.label === "拡張機能の設定");
    const ai = group?.entries.find(
      (entry) => entry.kind === "section" && entry.label === "AI"
    );
    const commands =
      ai?.kind === "section" ? ai.items.map((item) => item.command) : [];

    expect(commands).toContain("novelai.dev.toggleOllamaStream");
  });
});
