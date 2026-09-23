import { describe, expect, test } from "vitest";
import type * as vscode from "vscode";
import { ActionDecorationProvider } from "../../src/views/actionDecorations";
import {
  actionResourceUri,
  ActionListProvider,
  findAction,
  stepActionResourceUri,
  type ActionNode,
  type GroupStateStore,
} from "../../src/views/actionList";
import { StepMenuProvider, type StepNode } from "../../src/views/stepMenu";
import { createActionSpotlight } from "../../src/features/actionSpotlight";
import type { WorkEntry } from "../../src/models/types";
import type { WorkRegistry } from "../../src/core/workRegistry";

/**
 * 案内を**目立たせる**ところ（設計書6.104。作者の報告、2026-09-22
 * 「相談で光らせるが目立ちません」）。
 *
 * 選ぶだけでは薄くて気づけなかったので、印・瞬き・もう一度の3つを足した。
 * ここで守るのはそのうちの2つである（「もう一度」の札は
 * `guidedTourWiring.test.ts` が見張る）。
 *
 * 1. 案内が指している項目にだけ「▶」が付き、**済むと外れる**
 * 2. `reveal` を**2回**呼ぶ（1回では瞬かない）。**失敗しても投げない**
 */

const work: WorkEntry = {
  id: "w1",
  title: "ためし",
  folderPath: "C:/works/w1",
  registeredAt: "2026-09-22T00:00:00.000Z",
};

function fakeRegistry(): WorkRegistry {
  return {
    list: () => [work],
    onDidChange: () => ({ dispose() {} }),
  } as unknown as WorkRegistry;
}

const noStore: GroupStateStore = { get: () => [], set: () => undefined };

function actionNode(command: string): ActionNode {
  const item = findAction(command);
  if (!item) throw new Error(`${command} が操作の一覧に無い`);
  return { type: "action", item };
}

/** 案内の段になっている操作。AIも件数も持たないので、印の入れ替わりが見やすい */
const GUIDED = "novelai.checkContradictions";
/** 件数の印が出る操作。**案内の印がこれに勝つ**ことを見る */
const COUNTED = "novelai.applyPendingUpdates";

describe("案内が指している項目の印（ActionDecorationProvider）", () => {
  test("指している間だけ▶が付き、外すと消える", async () => {
    const decorations = new ActionDecorationProvider(async () => 0);
    const uri = actionResourceUri(actionNode(GUIDED));

    decorations.setSpotlight(GUIDED);
    const marked = decorations.provideFileDecoration(uri);
    expect(marked?.badge, "案内の印が出ていない").toBe("▶");
    expect(marked?.tooltip).toContain("案内");
    // **色を付ける。** 印だけでは、行の右端に小さく出るだけで気づけない
    expect(marked?.color, "色が付いていない").toBeDefined();

    // **済んだら元の印へ戻る**（この操作はAIを呼ぶので「AI」に戻る）。
    // 案内のあいだ隠していただけで、消したわけではない
    decorations.setSpotlight(undefined);
    expect(
      decorations.provideFileDecoration(uri)?.badge,
      "案内が済んでも印が残っている"
    ).toBe("AI");
  });

  test("簡単ステップメニュー側の目印にも同じ印が出る", () => {
    // 鍵はどちらもコマンドIDなので、1つ持つだけで両方のメニューに出る
    const decorations = new ActionDecorationProvider(async () => 0);
    decorations.setSpotlight(GUIDED);
    const uri = stepActionResourceUri(actionNode(GUIDED), work.id);
    expect(decorations.provideFileDecoration(uri)?.badge).toBe("▶");
  });

  test("案内の印は、件数の印に勝つ（1つしか出せないため）", async () => {
    const decorations = new ActionDecorationProvider(async () => 3);
    await decorations.refresh();
    const uri = actionResourceUri(actionNode(COUNTED));
    expect(
      decorations.provideFileDecoration(uri)?.badge,
      "件数の印が出ていない（この試験の前提が変わった）"
    ).toBe("3");

    decorations.setSpotlight(COUNTED);
    expect(decorations.provideFileDecoration(uri)?.badge).toBe("▶");

    // **外したら件数が戻る。** 案内のあいだ隠していただけである
    decorations.setSpotlight(undefined);
    expect(decorations.provideFileDecoration(uri)?.badge).toBe("3");
  });

  test("指していない項目には出ない", () => {
    const decorations = new ActionDecorationProvider(async () => 0);
    decorations.setSpotlight(GUIDED);
    const other = actionResourceUri(actionNode("novelai.postNewEpisode"));
    expect(decorations.provideFileDecoration(other)?.badge).not.toBe("▶");
  });

  test("同じものを指し直しても描き直させない（画面がちらつく）", () => {
    const decorations = new ActionDecorationProvider(async () => 0);
    let fired = 0;
    decorations.onDidChangeFileDecorations(() => {
      fired += 1;
    });
    decorations.setSpotlight(GUIDED);
    decorations.setSpotlight(GUIDED);
    expect(fired).toBe(1);
    decorations.setSpotlight(undefined);
    expect(fired).toBe(2);
  });
});

/** `reveal` に渡された節点を溜めるだけのツリー */
function fakeView<T>(
  seen: T[],
  behaviour: "ok" | "throws" = "ok"
): vscode.TreeView<T> {
  return {
    reveal: async (node: T): Promise<void> => {
      seen.push(node);
      if (behaviour === "throws") throw new Error("親をたどれない");
    },
  } as unknown as vscode.TreeView<T>;
}

function providers(): {
  actions: ActionListProvider;
  steps: StepMenuProvider;
} {
  return {
    actions: new ActionListProvider(fakeRegistry(), noStore),
    steps: new StepMenuProvider(
      fakeRegistry(),
      { get: () => work.id, set: () => undefined },
      noStore
    ),
  };
}

/** 試験では待たない（間合いそのものは製品の既定値に任せる） */
const noWait = { blinkMs: 0, sleep: async (): Promise<void> => undefined };

class FakeMarker {
  readonly marked: (string | undefined)[] = [];
  setSpotlight(command: string | undefined): void {
    this.marked.push(command);
  }
  get last(): string | undefined {
    return this.marked[this.marked.length - 1];
  }
}

describe("瞬かせる（createActionSpotlight）", () => {
  test("同じ項目を2回 reveal する（1回では瞬かない）", async () => {
    const { actions, steps } = providers();
    const seen: StepNode[] = [];
    const marker = new FakeMarker();
    const spotlight = createActionSpotlight(
      {
        stepView: fakeView(seen),
        stepProvider: steps,
        actionView: fakeView<ActionNode>([]),
        actionProvider: actions,
        marker,
      },
      noWait
    );

    const result = await spotlight.show(GUIDED);

    expect(result).toEqual({ shown: true, view: "steps" });
    const target = seen.filter(
      (node) => node.type === "action" && node.item.command === GUIDED
    );
    expect(target, "1回しか光らせていない").toHaveLength(2);
    // **間に選択を外している。** 選び直すだけでは、すでに選ばれている行に
    // 同じ色が乗るだけで何も動かない
    expect(seen).toHaveLength(3);
    expect(seen[1]?.type, "間に親を選び直していない").not.toBe("action");
    expect(marker.last, "印が付いていない").toBe(GUIDED);
  });

  test("reveal が失敗しても投げない（案内は文でも伝えてある）", async () => {
    const { actions, steps } = providers();
    const marker = new FakeMarker();
    const spotlight = createActionSpotlight(
      {
        stepView: fakeView<StepNode>([], "throws"),
        stepProvider: steps,
        actionView: fakeView<ActionNode>([], "throws"),
        actionProvider: actions,
        marker,
      },
      noWait
    );

    await expect(spotlight.show(GUIDED)).resolves.toEqual({ shown: false });
    // **押す場所が無いのに印だけ残さない**（前の段を指したままになる）
    expect(marker.last).toBeUndefined();
  });

  test("簡単ステップメニューで光らせられなければ、詳細メニューへ回る", async () => {
    const { actions, steps } = providers();
    const actionSeen: ActionNode[] = [];
    const spotlight = createActionSpotlight(
      {
        stepView: fakeView<StepNode>([], "throws"),
        stepProvider: steps,
        actionView: fakeView(actionSeen),
        actionProvider: actions,
        marker: new FakeMarker(),
      },
      noWait
    );

    const result = await spotlight.show(GUIDED);

    expect(result).toEqual({ shown: true, view: "actions" });
    expect(
      actionSeen.filter(
        (node) => node.type === "action" && node.item.command === GUIDED
      ),
      "詳細メニューでも2回光らせる"
    ).toHaveLength(2);
  });

  test("印を付ける先が無くても動く（起動の途中で渡っていないとき）", async () => {
    const { actions, steps } = providers();
    const spotlight = createActionSpotlight(
      {
        stepView: fakeView<StepNode>([]),
        stepProvider: steps,
        actionView: fakeView<ActionNode>([]),
        actionProvider: actions,
      },
      noWait
    );
    await expect(spotlight.show(GUIDED)).resolves.toEqual({
      shown: true,
      view: "steps",
    });
    expect(() => spotlight.clear()).not.toThrow();
  });

  test("clear で印が外れる（案内が終わったとき）", async () => {
    const { actions, steps } = providers();
    const marker = new FakeMarker();
    const spotlight = createActionSpotlight(
      {
        stepView: fakeView<StepNode>([]),
        stepProvider: steps,
        actionView: fakeView<ActionNode>([]),
        actionProvider: actions,
        marker,
      },
      noWait
    );
    await spotlight.show(GUIDED);
    spotlight.clear();
    expect(marker.last).toBeUndefined();
  });
});
