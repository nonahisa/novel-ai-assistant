import { describe, expect, test } from "vitest";
import {
  STEP_MENU,
  StepMenuProvider,
  filterSteps,
  type Step,
  type StepNode,
  type StepWorkStore,
} from "../../src/views/stepMenu";
import type { ActionItem } from "../../src/views/actionList";
import type { WorkEntry } from "../../src/models/types";
import type { WorkRegistry } from "../../src/core/workRegistry";
import type { WorkFormatKey } from "../../src/core/workFormat";

/**
 * 簡単ステップメニューを、選んだ作品のタイプで絞る（設計書6.70.1）。
 *
 * **絞るのはステップと右クリックだけ。** 詳細メニューには全機能を残す
 * （「全部はここにある」受け皿を1か所残さないと、隠れた機能を
 * 探せなくなる）。
 *
 * **作品を選んでいなければ絞らない。** 何に効くか決まっていないのに
 * 項目を消すと、初めての人には「入れたのに機能が足りない」に見える。
 */

function work(id: string, title: string): WorkEntry {
  return {
    id,
    title,
    folderPath: `C:/works/${id}`,
    registeredAt: "2026-09-04T00:00:00.000Z",
  };
}

function fakeRegistry(works: WorkEntry[]): WorkRegistry {
  return {
    list: () => works,
    onDidChange: () => ({ dispose() {} }),
  } as unknown as WorkRegistry;
}

function memoryWorkStore(initial?: string): StepWorkStore {
  const state = { saved: initial };
  return {
    get: () => state.saved,
    set: (id) => {
      state.saved = id;
    },
  };
}

/** 段に並ぶコマンドIDをすべて挙げる（小分類の中も含む） */
function commandsIn(steps: readonly Step[]): string[] {
  return steps.flatMap((step) =>
    step.entries.flatMap((entry) =>
      entry.kind === "section"
        ? entry.items.map((item) => item.command)
        : entry.kind === "action"
          ? [entry.command]
          : []
    )
  );
}

/** タイプを決め打ちしたプロバイダ。形式の読み込みは差し替える */
async function providerFor(
  format: WorkFormatKey | undefined,
  works: WorkEntry[] = [work("w1", "作品A")],
  savedId?: string
): Promise<StepMenuProvider> {
  const provider = new StepMenuProvider(
    fakeRegistry(works),
    memoryWorkStore(savedId),
    undefined,
    undefined,
    async () => format
  );
  await provider.loadSelectedFormat();
  return provider;
}

/** ツリーをたどって、いま画面に並ぶコマンドIDを集める */
function shownCommands(provider: StepMenuProvider): string[] {
  const commands: string[] = [];
  for (const node of provider.getChildren()) {
    if (node.type !== "step") continue;
    for (const child of provider.getChildren(node)) {
      collect(provider, child, commands);
    }
  }
  return commands;
}

function collect(
  provider: StepMenuProvider,
  node: StepNode,
  into: string[]
): void {
  if (node.type === "action") {
    into.push(node.item.command);
    return;
  }
  if (node.type === "section") {
    for (const child of provider.getChildren(node)) collect(provider, child, into);
  }
}

/** 段の名前だけを集める */
function stepLabels(provider: StepMenuProvider): string[] {
  return provider
    .getChildren()
    .filter((node) => node.type === "step")
    .map((node) => (node.type === "step" ? node.step.label : ""));
}

describe("選んだ作品のタイプで絞る", () => {
  test("小説では、いままでと同じものが並ぶ", async () => {
    const provider = await providerFor("long");

    expect(shownCommands(provider)).toEqual(commandsIn(STEP_MENU));
    expect(stepLabels(provider)).toEqual(STEP_MENU.map((step) => step.label));
  });

  test("タイプを決めていない作品でも、いままでと同じ", async () => {
    const provider = await providerFor(undefined);

    expect(shownCommands(provider)).toEqual(commandsIn(STEP_MENU));
  });

  test("作品を選んでいなければ、すべて出す", async () => {
    // 作品は2つ登録済みで未選択。**この状態で絞ると、対象も決まって
    // いないのに項目が消える**
    const provider = await providerFor("memo", [
      work("w1", "作品A"),
      work("w2", "作品B"),
    ]);

    expect(provider.selectedWork()).toBeUndefined();
    expect(shownCommands(provider)).toEqual(commandsIn(STEP_MENU));
  });

  test("創作メモ集では、物語向けの操作が消える", async () => {
    const provider = await providerFor("memo");
    const shown = shownCommands(provider);

    for (const command of [
      "novelai.createPlot",
      "novelai.generatePlot",
      "novelai.generateSynopses",
      "novelai.checkContradictions",
      "novelai.checkForeshadows",
      "novelai.checkDeviations",
      "novelai.extractSettings",
      "novelai.openSettingsPanel",
      "novelai.exportEpub",
    ]) {
      expect(shown, command).not.toContain(command);
    }
  });

  test("創作メモ集でも、書く・直す・同期する操作は残る", async () => {
    const provider = await providerFor("memo");
    const shown = shownCommands(provider);

    for (const command of [
      "novelai.checkTypos",
      "novelai.checkNotation",
      "novelai.checkProofread",
      "novelai.showWritingStats",
      "novelai.copyForPosting",
      "novelai.openManual",
    ]) {
      expect(shown, command).toContain(command);
    }
  });

  test("脚本では、物語向けの操作がそのまま残る", async () => {
    const provider = await providerFor("script");

    expect(shownCommands(provider)).toEqual(commandsIn(STEP_MENU));
  });

  test("中身が全部消えた小分類は、見出しごと畳む", async () => {
    // 開いても何も無い行を残すと、片づけたはずのメニューが
    // かえって分かりにくくなる（詳細メニューの `shownEntries` と同じ考え）
    const step: Step = {
      kind: "step",
      label: "試験用",
      icon: "beaker",
      detail: "",
      entries: [
        {
          kind: "section",
          label: "物語だけ",
          icon: "book",
          items: [action("novelai.checkForeshadows")],
        },
        {
          kind: "section",
          label: "どのタイプでも",
          icon: "check",
          items: [action("novelai.checkTypos")],
        },
      ],
    };

    const filtered = filterSteps([step], "memo");

    expect(filtered).toHaveLength(1);
    expect(
      filtered[0].entries.map((entry) =>
        entry.kind === "section" ? entry.label : entry.kind
      )
    ).toEqual(["どのタイプでも"]);
  });

  test("中身が全部消えた段は、段ごと出さない", async () => {
    const step: Step = {
      kind: "step",
      label: "物語だけの段",
      icon: "beaker",
      detail: "",
      entries: [action("novelai.checkForeshadows")],
    };

    expect(filterSteps([step], "memo")).toEqual([]);
    // 小説では残る（消える条件がタイプであることを、両側から確かめる）
    expect(filterSteps([step], "novel")).toHaveLength(1);
  });
});

/** 表を引くだけの、最小の操作項目 */
function action(command: string): ActionItem {
  return {
    kind: "action",
    command,
    label: command,
    icon: "circle-outline",
    requiresWork: true,
    detail: "",
  };
}
