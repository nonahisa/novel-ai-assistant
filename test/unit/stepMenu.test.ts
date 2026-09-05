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
  stepActionResourceUri,
  REQUIRES_WORK_HINT,
  type ActionCounter,
  type ActionItem,
  type GroupStateStore,
} from "../../src/views/actionList";
import { ActionDecorationProvider } from "../../src/views/actionDecorations";
import type { WorkEntry } from "../../src/models/types";
import type { WorkRegistry } from "../../src/core/workRegistry";

/**
 * 簡単ステップメニュー（作者の依頼、2026-08-27。名前は2026-08-29に改名）。
 *
 * 確かめるのは2つに絞る。
 *
 * 1. **参照が実体に届いていること**——操作の中身は詳細メニュー
 *    （`ACTION_TREE`）にしか無い。コマンドを改名すると、画面からは
 *    項目が1つ消えるだけで気づけない
 * 2. **最上段で選んだ作品が、押した操作へ渡ること**——渡らないと、
 *    押すたびに作品を訊かれる（簡単ステップメニューを作った意味が無い）
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

/** 簡単ステップメニューに並ぶ操作をすべて取り出す */
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
  if (!item) {
    throw new Error(`操作「${command}」が簡単ステップメニューにありません`);
  }
  return { type: "action", item };
}

/**
 * 印の宛先を作る。詳細メニューと同じ `ActionNode` の形で渡す
 * （印の仕組みは1つしかなく、簡単ステップメニュー用に別の型を作らない）。
 */
function decorationNode(command: string): {
  type: "action";
  item: ActionItem;
} {
  const item = stepActions().find((entry) => entry.command === command);
  if (!item) {
    throw new Error(`操作「${command}」が簡単ステップメニューにありません`);
  }
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

describe("簡単ステップメニューの構成", () => {
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

  test("番号の付いた7段階のあとに、番号なしの「ヘルプ」が来る", () => {
    // 番号は「どの順でやるか」そのもの。並べ替えたら番号も直す。
    // **ヘルプに番号は振らない**——流れの中の一段階ではなく、
    // どの段階からでも寄る場所だから（作者の指定、2026-08-29）
    expect(STEP_MENU).toHaveLength(8);
    expect(STEP_MENU.map((step) => step.label)).toEqual([
      "1. 作品登録",
      "2. 新作構想",
      "3. 作品執筆",
      "4. 自己校正",
      "5. 投稿脱稿",
      "6. 編集部校正・校閲",
      "7. 電子出版等",
      "ヘルプ",
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

/**
 * 最下段のヘルプ（作者の依頼、2026-08-29）。
 *
 * **ここは「作品を選んでから」の規則の外に置く。** 何をすればよいか
 * 分からない人が最初に開くのがヘルプであり、そこで「作品を選んでください」と
 * 言われると先へ進めない。
 */
describe("最下段のヘルプ", () => {
  const helpStep = (): (typeof STEP_MENU)[number] =>
    STEP_MENU[STEP_MENU.length - 1];

  test("ヘルプは最後の段で、詳細メニューと同じ並び・同じ印を持つ", () => {
    expect(helpStep().label).toBe("ヘルプ");
    // 詳細メニューの「ヘルプ」分類と同じアイコン。別の絵にすると、
    // 同じものが2か所にあると気づけない
    expect(helpStep().icon).toBe("question");
    expect(
      helpStep().entries.map((entry) =>
        entry.kind === "action" ? entry.command : entry.label
      )
    ).toEqual([
      "novelai.openManual",
      "novelai.showLog",
      "novelai.openChatLog",
      "novelai.showVersion",
    ]);
  });

  test("作品を選んでいなくても押せる", () => {
    // 作品は2つ登録済みで、どれも選んでいない状態
    const provider = new StepMenuProvider(
      fakeRegistry([work("w1", "作品A"), work("w2", "作品B")]),
      memoryWorkStore()
    );

    for (const entry of helpStep().entries) {
      if (entry.kind !== "action" || entry.requiresWork) continue;
      const command = commandOf(provider, { type: "action", item: entry });

      expect(command?.command, entry.command).toBe(entry.command);
      // 作品を要さないので、対象は渡さない（渡すと相手がすり替わる）
      expect(command?.arguments, entry.command).toEqual([]);
    }
  });

  test("作品が1つも登録されていなくても押せる", () => {
    // 入れた直後に開くのがここ。**登録より先に読めなければ意味が無い**
    const provider = new StepMenuProvider(fakeRegistry([]), memoryWorkStore());

    for (const entry of helpStep().entries) {
      if (entry.kind !== "action" || entry.requiresWork) continue;
      expect(
        commandOf(provider, { type: "action", item: entry })?.command,
        entry.command
      ).toBe(entry.command);
    }
  });

  test("押せるものが3つある（要件を絞り込んで空振りしない）", () => {
    // 上の2つは「押せないものを飛ばす」書き方なので、全部が
    // `requiresWork` になると**何も確かめずに通ってしまう**
    const openable = helpStep().entries.filter(
      (entry) => entry.kind === "action" && !entry.requiresWork
    );

    expect(openable).toHaveLength(3);
  });

  test("「相談のログを開く」だけは作品が要る", () => {
    // 作品ごとに残しているログなので、対象が決まらないと開けない。
    // **ここが落ちたら、詳細メニュー側の `requiresWork` を変えたということ。**
    // そのときはヘルプ段の扱い（未選択でも押せる）も見直すこと
    const provider = new StepMenuProvider(
      fakeRegistry([work("w1", "作品A"), work("w2", "作品B")]),
      memoryWorkStore()
    );
    const node = actionNode("novelai.openChatLog");

    expect(commandOf(provider, node)).toBeUndefined();
    expect(descriptionOf(provider, node)).toBe(STEP_SELECT_HINT);
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
      "選択作品：作品A"
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
      "選択作品：作品B"
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

  test("実装できたものは、枠を外して実物に置き換える", () => {
    // 枠（準備中）は**まだコマンドが無い段階**を伝えるためのもので、
    // 実装が済んだら消す。残したままだと「予定」と薄字で出続け、
    // 実際には使える機能を作者が探しに行かない
    expect(
      stepPlaceholders().map((entry) => entry.label),
      "実装済みの枠が残っている"
    ).toEqual(["WEB投稿支援（準備中）"]);
  });
});

/**
 * 第7段「電子出版等」（作者の指定、2026-09-03）。
 *
 * EPUB（設計書6.65）は 0.29.17〜0.29.22 で実装できたので、「予定」の枠を
 * 外して実物を載せる。**操作の実体は詳細メニューの木だけが持つ**ので、
 * ここはコマンドIDで参照するだけである。
 */
describe("第7段に、電子書籍の操作が載る", () => {
  const publishStep = () =>
    STEP_MENU.find((step) => step.label === "7. 電子出版等")!;

  test("PDFとEPUBエディターが並ぶ（書き出しはエディターの中）", () => {
    // **「EPUBへ書き出す」は外のメニューから外した**（作者の指定、
    // 2026-09-04）。書き出しボタンはエディターの中にあり、外にも同じ
    // 入口があると「どちらから出すのが正しいのか」が分からない
    expect(
      publishStep().entries.map((entry) =>
        entry.kind === "action" ? entry.command : entry.label
      )
    ).toEqual(["novelai.exportPdf", "novelai.openEpubEditor"]);
  });

  test("実体は詳細メニューの木から引いている（写しではない）", () => {
    // 名前や説明をここへ書き写すと、木を直したときに片方だけ古くなる
    for (const command of ["novelai.openEpubEditor"]) {
      const inTree = allActions().find((entry) => entry.command === command);
      const inStep = stepActions().find((entry) => entry.command === command);

      expect(inTree, `${command} が詳細メニューにない`).toBeTruthy();
      expect(inStep, `${command} が第7段にない`).toBe(inTree);
    }
  });

  test("段の説明が、いま作れるものと合っている", () => {
    // 「いまはPDFまで」と書いたままにすると、載せた操作と食い違う
    expect(publishStep().detail).toContain("EPUB");
    expect(publishStep().detail).not.toContain("いまはPDF（印刷用）まで");
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

  /*
    **バッジは選択中の作品だけを数える**（作者の実機報告、2026-09-05）。

    簡単ステップメニューは最上段で作品を選ぶ画面なので、行の末尾の数字は
    その作品のものだと読める。ところが詳細メニューと同じ鍵を使っていたため、
    全作品合計がそのまま出ていた——選択作品は重複0・反映待ち0なのに
    「24」「1」と並んでいた。
  */
  const badgeOf = (
    decorations: ActionDecorationProvider,
    command: string,
    workId: string | undefined
  ): string | undefined =>
    decorations.provideFileDecoration(
      stepActionResourceUri(decorationNode(command), workId)
    )?.badge as string | undefined;

  /** 作品ごとに違う件数を返す口。合算（作品を渡さない）は26件 */
  const perWorkCounts = async (
    _counter: ActionCounter,
    workId?: string
  ): Promise<number> => {
    if (workId === "wA") return 2;
    if (workId === "wB") return 24;
    return 26;
  };

  test("選んだ作品の件数だけを出す", async () => {
    const decorations = new ActionDecorationProvider(perWorkCounts);

    await decorations.refreshWork("wA");
    expect(badgeOf(decorations, "novelai.unifyCharacters", "wA")).toBe("2");

    await decorations.refreshWork("wB");
    expect(badgeOf(decorations, "novelai.unifyCharacters", "wB")).toBe("24");
  });

  test("作品を選んでいなければ件数を出さない", async () => {
    // どの作品の数字か分からないものを出すと、選択中の作品の件数に見える。
    // 「どこかに溜まっている」の気づきは詳細メニュー（全作品合計）が担う
    const decorations = new ActionDecorationProvider(perWorkCounts);
    await decorations.refresh();
    await decorations.refreshWork("wA");

    expect(badgeOf(decorations, "novelai.unifyCharacters", undefined)).toBeUndefined();
    // AIの印は作品に関わらないので、選んでいなくても出す
    expect(badgeOf(decorations, "novelai.checkTypos", undefined)).toBe("AI");
  });

  test("ツールチップで、どの範囲の数字かが分かる", async () => {
    const decorations = new ActionDecorationProvider(perWorkCounts);
    await decorations.refreshWork("wA");

    const tooltip = decorations.provideFileDecoration(
      stepActionResourceUri(
        decorationNode("novelai.applyPendingUpdates"),
        "wA"
      )
    )?.tooltip;

    expect(tooltip).toContain("選択中の作品");
  });

  test("メニューの項目は、選んだ作品ごとに別の目印を持つ", () => {
    // 同じ鍵だと同じ数字が出る（それが今回の不具合）
    const works = [work("wA", "作品A"), work("wB", "作品B")];
    const pathFor = (savedId: string | undefined): string | undefined =>
      new StepMenuProvider(fakeRegistry(works), memoryWorkStore(savedId))
        .getTreeItem(actionNode("novelai.unifyCharacters"))
        .resourceUri?.path;

    expect(pathFor("wA")).toContain(encodeURIComponent("wA"));
    expect(pathFor("wB")).toContain(encodeURIComponent("wB"));
    expect(pathFor("wA")).not.toBe(pathFor("wB"));
    // 未選択のときは作品が入らない（＝件数が出ない目印）
    expect(pathFor(undefined)).not.toContain(encodeURIComponent("wA"));
  });

  test("ホバーの件数も、選んだ作品だけを数える", () => {
    const works = [work("wA", "作品A"), work("wB", "作品B")];
    const counts = (_counter: ActionCounter, workId: string): number =>
      workId === "wA" ? 2 : 24;
    const tooltipFor = (savedId: string | undefined): string => {
      const provider = new StepMenuProvider(
        fakeRegistry(works),
        memoryWorkStore(savedId),
        undefined,
        counts
      );
      const tooltip = provider.getTreeItem(
        actionNode("novelai.unifyCharacters")
      ).tooltip;
      return typeof tooltip === "string" ? tooltip : (tooltip?.value ?? "");
    };

    expect(tooltipFor("wA")).toContain("未反映: 2 件");
    expect(tooltipFor("wB")).toContain("未反映: 24 件");
    // 作品を選んでいなければ、件数そのものを出さない
    expect(tooltipFor(undefined)).not.toContain("未反映:");
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
    // 作品名は見出しに出さない（作者の撤回、2026-08-28）。
    // 最上段の「選択作品：〜」の行が代わりを務める
    expect(stepViewDescription(work("w1", "銀の航路"), true)).toBe("");
  });

  test("作品が無ければ「未登録」", () => {
    expect(stepViewDescription(undefined, false)).toBe(STEP_NO_WORK_LABEL);
  });

  test("登録済みだが未選択なら、最上段と同じ文言で促す", () => {
    expect(stepViewDescription(undefined, true)).toBe(STEP_CHOOSE_WORK_LABEL);
  });
});
