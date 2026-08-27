import { describe, expect, test } from "vitest";
import { TreeItemCollapsibleState } from "vscode";
import {
  STEP_CHOOSE_WORK_LABEL,
  STEP_MENU,
  STEP_MENU_MISSING_COMMANDS,
  STEP_NO_WORK_HINT,
  STEP_NO_WORK_LABEL,
  STEP_REFERENCED_COMMANDS,
  STEP_SELECT_HINT,
  STEP_WORK_COMMAND,
  StepMenuProvider,
  restoreExpandedSteps,
  stepViewDescription,
  type StepNode,
  type StepPlaceholder,
  type StepWorkStore,
} from "../../src/views/stepMenu";
import {
  ACTION_SCHEME,
  allActions,
  REQUIRES_WORK_HINT,
  type ActionItem,
  type GroupStateStore,
} from "../../src/views/actionList";
import type { WorkEntry } from "../../src/models/types";
import type { WorkRegistry } from "../../src/core/workRegistry";

/**
 * ステップメニュー（作者の依頼、2026-08-27）。
 *
 * 確かめるのは2つに絞る。
 *
 * 1. **参照が実体に届いていること**——操作の中身は詳細メニュー
 *    （`ACTION_TREE`）にしか無い。コマンドを改名すると、画面からは
 *    項目が1つ消えるだけで気づけない
 * 2. **最上段で選んだ作品が、押した操作へ渡ること**——渡らないと、
 *    押すたびに作品を訊かれる（ステップメニューを作った意味が無い）
 */

function work(id: string, title: string): WorkEntry {
  return {
    id,
    title,
    folderPath: `C:/works/${id}`,
    registeredAt: "2026-08-27T00:00:00.000Z",
  };
}

function fakeRegistry(works: WorkEntry[]): WorkRegistry {
  return {
    list: () => works,
    onDidChange: () => ({ dispose() {} }),
  } as unknown as WorkRegistry;
}

function memoryWorkStore(initial?: string): StepWorkStore & {
  saved: string | undefined;
} {
  const state = { saved: initial };
  return {
    get saved() {
      return state.saved;
    },
    get: () => state.saved,
    set: (id) => {
      state.saved = id;
    },
  };
}

function memoryGroupStore(initial: string[] = []): GroupStateStore & {
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

/** ステップメニューに並ぶ操作をすべて取り出す */
function stepActions(): ActionItem[] {
  return STEP_MENU.flatMap((step) =>
    step.entries.flatMap((entry) =>
      entry.kind === "section"
        ? entry.items
        : entry.kind === "action"
          ? [entry]
          : []
    )
  );
}

function stepPlaceholders(): StepPlaceholder[] {
  return STEP_MENU.flatMap((step) =>
    step.entries.filter(
      (entry): entry is StepPlaceholder => entry.kind === "placeholder"
    )
  );
}

/** 操作の節点を作る。名前で引けないと、テストが並び順に縛られる */
function actionNode(command: string): StepNode {
  const item = stepActions().find((entry) => entry.command === command);
  if (!item) throw new Error(`操作「${command}」がステップメニューにありません`);
  return { type: "action", item };
}

/** ツリーの項目が持つ実行指示。押せないものは持たない */
interface TreeCommand {
  command: string;
  title: string;
  arguments?: unknown[];
}

function commandOf(
  provider: StepMenuProvider,
  node: StepNode
): TreeCommand | undefined {
  return provider.getTreeItem(node).command as TreeCommand | undefined;
}

function descriptionOf(provider: StepMenuProvider, node: StepNode): string {
  return String(provider.getTreeItem(node).description ?? "");
}

describe("ステップメニューの構成", () => {
  test("参照しているコマンドは、すべて詳細メニューに実在する", () => {
    // **操作の実体は二重に持たない。** ここが切れると、画面から項目が
    // 1つ消えるだけで、誰も気づけないまま出続ける
    const known = new Set(allActions().map((action) => action.command));

    expect(STEP_REFERENCED_COMMANDS.length).toBeGreaterThan(0);
    for (const command of STEP_REFERENCED_COMMANDS) {
      expect(known, `${command} が詳細メニューにない`).toContain(command);
    }
    expect(STEP_MENU_MISSING_COMMANDS).toEqual([]);
  });

  test("段階は7つで、番号の付いた名前が並ぶ", () => {
    // 番号は「どの順でやるか」そのもの。並べ替えたら番号も直す
    expect(STEP_MENU).toHaveLength(7);
    expect(STEP_MENU.map((step) => step.label)).toEqual([
      "1. 作品登録",
      "2. 新作構想",
      "3. 作品執筆",
      "4. 自己校正",
      "5. 投稿脱稿",
      "6. 編集部校正・校閲",
      "7. 電子出版等",
    ]);
  });

  test("段階には、何をする段階かの説明が付く", () => {
    for (const step of STEP_MENU) {
      expect(step.detail.length, step.label).toBeGreaterThan(0);
    }
  });

  test("小分類は「3. 作品執筆」だけに置く", () => {
    const sections = STEP_MENU.flatMap((step) =>
      step.entries
        .filter((entry) => entry.kind === "section")
        .map((entry) => `${step.label}/${entry.label}`)
    );

    expect(sections).toEqual([
      "3. 作品執筆/執筆の場",
      "3. 作品執筆/資料生成",
      "3. 作品執筆/入力を楽に",
    ]);
  });

  test("環境によって出ない操作は並べない", () => {
    // **ブラウザ版だけの操作（`browserOnly`）と開発用の道具（`devOnly`）は
    // 置かない。** 出したり消したりが要る項目を流れの中に混ぜると、
    // 「1つ足りない」ことに作者が気づけない
    for (const action of stepActions()) {
      expect(action.browserOnly, action.command).toBeFalsy();
      expect(action.devOnly, action.command).toBeFalsy();
    }
  });

  test("最上段は作品選択窓で、その下に段階が並ぶ", () => {
    const provider = new StepMenuProvider(fakeRegistry([work("w1", "作品A")]));
    const roots = provider.getChildren();

    expect(roots[0]).toEqual({ type: "selector" });
    expect(roots).toHaveLength(1 + STEP_MENU.length);
  });
});

describe("作品が1つも登録されていないとき", () => {
  const provider = (): StepMenuProvider =>
    new StepMenuProvider(fakeRegistry([]), memoryWorkStore());

  test("最上段は「未登録」で、押せない", () => {
    const item = provider().getTreeItem({ type: "selector" });

    expect(item.label).toBe(STEP_NO_WORK_LABEL);
    expect(item.description).toBe(STEP_NO_WORK_HINT);
    // 押しても選ぶものが無い。**押せなくして、どうすればよいかを出す**
    expect(item.command).toBeUndefined();
  });

  test("作品を要する操作は押せない", () => {
    const target = provider();

    for (const action of stepActions().filter((entry) => entry.requiresWork)) {
      expect(
        commandOf(target, { type: "action", item: action }),
        action.command
      ).toBeUndefined();
    }
  });

  test("押せない理由は「作品を登録すると使えます」", () => {
    // まだ1つも無いのだから、選べと言われても選べない
    expect(descriptionOf(provider(), actionNode("novelai.checkTypos"))).toBe(
      REQUIRES_WORK_HINT
    );
  });
});

describe("作品が1つだけのとき", () => {
  const only = work("w1", "作品A");
  const provider = (): StepMenuProvider =>
    new StepMenuProvider(fakeRegistry([only]), memoryWorkStore());

  test("選ばなくても、その作品が対象になる", () => {
    // 1つしか無いのに選ばせるのは、押す手間が1つ増えるだけ
    expect(provider().selectedWork()).toEqual(only);
    expect(provider().getTreeItem({ type: "selector" }).label).toBe(
      "作品：作品A"
    );
  });

  test("作品を要する操作へ、その作品が渡る", () => {
    const command = commandOf(provider(), actionNode("novelai.checkTypos"));

    expect(command?.command).toBe("novelai.checkTypos");
    // `resolveWork` が受ける形。これが渡らないと、押すたびに作品を訊かれる
    expect(command?.arguments?.[0]).toEqual({ type: "work", work: only });
  });
});

describe("作品が複数あるとき", () => {
  const first = work("w1", "作品A");
  const second = work("w2", "作品B");
  const registry = (): WorkRegistry => fakeRegistry([first, second]);

  test("選んでいなければ、最上段で選ぶよう促す", () => {
    const provider = new StepMenuProvider(registry(), memoryWorkStore());
    const item = provider.getTreeItem({ type: "selector" });

    expect(item.label).toBe(STEP_CHOOSE_WORK_LABEL);
    // 選び直せるように、押せる状態にしておく
    expect((item.command as TreeCommand | undefined)?.command).toBe(
      STEP_WORK_COMMAND
    );
  });

  test("選んでいなければ、作品を要する操作は押せない", () => {
    const provider = new StepMenuProvider(registry(), memoryWorkStore());
    const node = actionNode("novelai.checkTypos");

    expect(commandOf(provider, node)).toBeUndefined();
    // **「作品を登録すると使えます」では的外れ。** 登録は済んでいる
    expect(descriptionOf(provider, node)).toBe(STEP_SELECT_HINT);
  });

  test("選んだ作品が、押した操作へ渡る", () => {
    const provider = new StepMenuProvider(registry(), memoryWorkStore("w2"));

    expect(provider.selectedWork()).toEqual(second);
    expect(
      commandOf(provider, actionNode("novelai.checkTypos"))?.arguments?.[0]
    ).toEqual({ type: "work", work: second });
    expect(provider.getTreeItem({ type: "selector" }).label).toBe(
      "作品：作品B"
    );
  });

  test("選んだ作品が登録から消えたら、未選択へ戻す", () => {
    // 覚えているのはIDだけ。**実在の確認は表示のたびに行う**ので、
    // 作品を外しても、消えた作品を指したまま操作が走ることはない
    const provider = new StepMenuProvider(registry(), memoryWorkStore("w9"));

    expect(provider.selectedWork()).toBeUndefined();
    expect(provider.getTreeItem({ type: "selector" }).label).toBe(
      STEP_CHOOSE_WORK_LABEL
    );
    expect(commandOf(provider, actionNode("novelai.checkTypos"))).toBeUndefined();
  });

  test("選び直すと覚えて、次からその作品が渡る", () => {
    const store = memoryWorkStore();
    const provider = new StepMenuProvider(registry(), store);

    provider.selectWork("w1");

    expect(store.saved).toBe("w1");
    expect(
      commandOf(provider, actionNode("novelai.checkTypos"))?.arguments?.[0]
    ).toEqual({ type: "work", work: first });
  });
});

describe("作品を渡す相手を間違えない", () => {
  test("作品を要さない操作には、何も渡さない", () => {
    // **開いているファイルに効く操作へ作品を渡すと、対象がすり替わる。**
    // 登録系（作品を作る操作）も、渡す相手ではない
    const provider = new StepMenuProvider(
      fakeRegistry([work("w1", "作品A")]),
      memoryWorkStore()
    );

    for (const action of stepActions().filter((entry) => !entry.requiresWork)) {
      const command = commandOf(provider, { type: "action", item: action });
      expect(command?.arguments, action.command).toEqual([]);
    }
    expect(
      commandOf(provider, actionNode("novelai.addWork"))?.arguments
    ).toEqual([]);
  });
});

describe("準備中の項目", () => {
  test("押しても何も起きないので、command を持たせない", () => {
    const provider = new StepMenuProvider(
      fakeRegistry([work("w1", "作品A")]),
      memoryWorkStore()
    );

    expect(stepPlaceholders().length).toBeGreaterThan(0);
    for (const placeholder of stepPlaceholders()) {
      const item = provider.getTreeItem({
        type: "placeholder",
        placeholder,
        stepLabel: "5. 投稿脱稿",
      });
      expect(item.command, placeholder.label).toBeUndefined();
      // 「予定」と薄字で出して、いま押せないことを押す前に伝える
      expect(item.description).toBe("予定");
    }
  });

  test("いま何で代われるかまで書く", () => {
    const posting = stepPlaceholders().find((entry) =>
      entry.label.includes("WEB投稿支援")
    );

    expect(posting?.detail).toContain("投稿サイト用に変換してコピー");
  });
});

describe("AIと件数の印", () => {
  test("AIを使う操作は、詳細メニューと同じ目印を持つ", () => {
    // 印を出す仕組み（`actionDecorations.ts`）は resourceUri で判定する。
    // **新しい仕組みは作らない**ので、同じURIを渡すだけで印が付く
    const provider = new StepMenuProvider(
      fakeRegistry([work("w1", "作品A")]),
      memoryWorkStore()
    );
    const item = provider.getTreeItem(actionNode("novelai.checkTypos"));

    expect(item.resourceUri?.scheme).toBe(ACTION_SCHEME);
    expect(item.resourceUri?.path).toContain(
      encodeURIComponent("novelai.checkTypos")
    );
  });
});

describe("開閉を覚える", () => {
  test("はじめはすべて閉じておく", () => {
    // 7段階を全部開くと、上に置いた作品一覧が押し出される
    const provider = new StepMenuProvider(
      fakeRegistry([work("w1", "作品A")]),
      memoryWorkStore(),
      memoryGroupStore()
    );

    for (const step of STEP_MENU) {
      expect(
        provider.getTreeItem({ type: "step", step }).collapsibleState,
        step.label
      ).toBe(TreeItemCollapsibleState.Collapsed);
    }
  });

  test("開いた段階は次に開いたときも開いている", () => {
    const store = memoryGroupStore();
    new StepMenuProvider(
      fakeRegistry([]),
      memoryWorkStore(),
      store
    ).setExpanded("4. 自己校正", true);

    const second = new StepMenuProvider(
      fakeRegistry([]),
      memoryWorkStore(),
      store
    );
    const step = STEP_MENU.find((entry) => entry.label === "4. 自己校正");

    expect(store.saved).toEqual(["4. 自己校正"]);
    expect(
      second.getTreeItem({ type: "step", step: step! }).collapsibleState
    ).toBe(TreeItemCollapsibleState.Expanded);
  });

  test("知らない段階名は読み込まない", () => {
    // 段階の名前を変えたり減らしたりしたときに、古い名前が残らないようにする
    expect([
      ...restoreExpandedSteps([
        "4. 自己校正",
        "3. 作品執筆/資料生成",
        "むかしの段階",
      ]),
    ]).toEqual(["4. 自己校正", "3. 作品執筆/資料生成"]);
  });
});

describe("ビューの見出しに出す作品名", () => {
  // 最上段の選択窓はスクロールで画面の外へ流れる。
  // 見出しの薄字は常に見えるので、そこにも対象を出す（作者の依頼、2026-08-27）
  test("選んだ作品のタイトルが出る", () => {
    expect(stepViewDescription(work("w1", "銀の航路"), true)).toBe("銀の航路");
  });

  test("作品が無ければ「未登録」", () => {
    expect(stepViewDescription(undefined, false)).toBe(STEP_NO_WORK_LABEL);
  });

  test("登録済みだが未選択なら、最上段と同じ文言で促す", () => {
    expect(stepViewDescription(undefined, true)).toBe(STEP_CHOOSE_WORK_LABEL);
  });
});
