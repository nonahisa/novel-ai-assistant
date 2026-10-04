import { describe, expect, test } from "vitest";
import {
  STEP_MENU,
  StepMenuProvider,
  filterSteps,
  type Step,
  type StepNode,
  type StepWorkStore,
} from "../../../src/views/stepMenu";
import type { ActionItem } from "../../../src/views/actionList";
import type { WorkEntry } from "../../../src/models/types";
import type { WorkRegistry } from "../../../src/core/workRegistry";
import type { WorkFormatKey } from "../../../src/core/workFormat";
import type { WorkKindKey } from "../../../src/core/workKind";

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
async function shownCommands(provider: StepMenuProvider): Promise<string[]> {
  const commands: string[] = [];
  for (const node of await provider.getChildren()) {
    if (node.type !== "step") continue;
    for (const child of await provider.getChildren(node)) {
      await collect(provider, child, commands);
    }
  }
  return commands;
}

async function collect(
  provider: StepMenuProvider,
  node: StepNode,
  into: string[]
): Promise<void> {
  if (node.type === "action") {
    into.push(node.item.command);
    return;
  }
  if (node.type === "section") {
    for (const child of await provider.getChildren(node)) {
      await collect(provider, child, into);
    }
  }
}

/** 段の名前だけを集める */
async function stepLabels(provider: StepMenuProvider): Promise<string[]> {
  return (await provider.getChildren())
    .filter((node) => node.type === "step")
    .map((node) => (node.type === "step" ? node.step.label : ""));
}

describe("選んだ作品のタイプで絞る", () => {
  test("小説では、いままでと同じものが並ぶ", async () => {
    const provider = await providerFor("long");

    expect(await shownCommands(provider)).toEqual(commandsIn(STEP_MENU));
    expect(await stepLabels(provider)).toEqual(STEP_MENU.map((step) => step.label));
  });

  test("タイプを決めていない作品でも、いままでと同じ", async () => {
    const provider = await providerFor(undefined);

    expect(await shownCommands(provider)).toEqual(commandsIn(STEP_MENU));
  });

  test("作品を選んでいなければ、すべて出す", async () => {
    // 作品は2つ登録済みで未選択。**この状態で絞ると、対象も決まって
    // いないのに項目が消える**
    const provider = await providerFor("memo", [
      work("w1", "作品A"),
      work("w2", "作品B"),
    ]);

    expect(provider.selectedWork()).toBeUndefined();
    expect(await shownCommands(provider)).toEqual(commandsIn(STEP_MENU));
  });

  test("創作メモ集では、物語向けの操作が消える", async () => {
    const provider = await providerFor("memo");
    const shown = await shownCommands(provider);

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
    const shown = await shownCommands(provider);

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

    expect(await shownCommands(provider)).toEqual(commandsIn(STEP_MENU));
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

/**
 * 描画の途中で「並べ直して」と知らせない（2026-10-04、作者の実機と
 * `test/e2e/panelFocusStability.test.ts`）。
 *
 * 形式を読み終えたことを木全体の作り直しで知らせていたころ、読み込みが速いと
 * （原稿エディターで話を開いたあと）知らせが VS Code 本体の描画の 1ms 後に届き、
 * 本体の木が止まって段を開いても中身が出なくなった。
 */
describe("形式の読み込みと描画の知らせ", () => {
  test("最上段を描いて形式を読み終えても、作り直しの知らせを出さない", async () => {
    const provider = new StepMenuProvider(
      fakeRegistry([work("w1", "作品A")]),
      memoryWorkStore(),
      undefined,
      undefined,
      async () => "memo"
    );
    let fired = 0;
    provider.onDidChangeTreeData(() => fired++);

    await provider.getChildren();
    // 背後の読み込みが終わるまで待つ（旧実装はここで知らせを出していた）
    await provider.loadSelectedFormat();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(fired).toBe(0);
  });

  test("最上段は、形式を読み終えてから絞った段を返す", async () => {
    // 先に loadSelectedFormat を呼ばなくても、最初の描画から絞れている
    const provider = new StepMenuProvider(
      fakeRegistry([work("w1", "作品A")]),
      memoryWorkStore(),
      undefined,
      undefined,
      async () => "memo"
    );

    const shown = await shownCommands(provider);

    expect(shown).not.toContain("novelai.checkForeshadows");
    expect(shown).toContain("novelai.checkTypos");
  });

  test("続けて描いても、同じ作品の形式は1度だけ読む", async () => {
    let reads = 0;
    const provider = new StepMenuProvider(
      fakeRegistry([work("w1", "作品A")]),
      memoryWorkStore(),
      undefined,
      undefined,
      async () => {
        reads++;
        return "long";
      }
    );

    await Promise.all([
      provider.getChildren(),
      provider.getChildren(),
      provider.loadSelectedFormat(),
    ]);

    expect(reads).toBe(1);
  });

  test("読み込みの途中でタイプを捨てたら、古い結果を置かない", async () => {
    let format: WorkFormatKey = "memo";
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let first = true;
    const provider = new StepMenuProvider(
      fakeRegistry([work("w1", "作品A")]),
      memoryWorkStore(),
      undefined,
      undefined,
      async () => {
        // 1回目だけ止めて、その間にタイプを変える
        if (first) {
          first = false;
          const seen = format;
          await gate;
          return seen;
        }
        return format;
      }
    );

    const stale = provider.loadSelectedFormat();
    format = "long";
    provider.invalidateFormats("w1");
    release();
    await stale;

    // 古い「memo」が置かれていれば、伏線が消える
    expect(await shownCommands(provider)).toContain("novelai.checkForeshadows");
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

/**
 * 種類の軸（設計書6.109.7）。エッセイ・歌詞では、人物・筋・伏線を扱う
 * 操作をステップから外す。台本・漫画の原作は物語なので何も減らさない。
 */
describe("選んだ作品の種類で絞る", () => {
  async function providerForKind(
    format: WorkFormatKey | undefined,
    kind: WorkKindKey | undefined
  ): Promise<StepMenuProvider> {
    const provider = new StepMenuProvider(
      fakeRegistry([work("w1", "作品A")]),
      memoryWorkStore(),
      undefined,
      undefined,
      async () => format,
      async () => kind
    );
    await provider.loadSelectedFormat();
    return provider;
  }

  test("エッセイでは、矛盾・伏線・人物抽出・単話プロットが消える", async () => {
    const shown = await shownCommands(await providerForKind("long", "essay"));

    for (const command of [
      "novelai.checkContradictions",
      "novelai.checkForeshadows",
      "novelai.checkDeviations",
      "novelai.extractSettings",
      "novelai.openSettingsPanel",
      "novelai.createEpisodePlot",
    ]) {
      expect(shown, command).not.toContain(command);
    }
  });

  test("エッセイでも、プロット・校正・書き出しは残る", async () => {
    const shown = await shownCommands(await providerForKind("long", "essay"));

    for (const command of [
      "novelai.createPlot",
      "novelai.checkTypos",
      "novelai.checkProofread",
      "novelai.showWritingStats",
      "novelai.openPlotMode",
      "novelai.generateSynopses",
      "novelai.openEpubEditor",
    ]) {
      expect(shown, command).toContain(command);
    }
  });

  test("漫画の原作・台本は物語なので、小説と同じものが並ぶ", async () => {
    for (const kind of ["manga", "script", "novel"] as const) {
      const shown = await shownCommands(await providerForKind("long", kind));
      expect(shown, kind).toEqual(commandsIn(STEP_MENU));
    }
  });

  test("形式を決めていなくても、種類が歌詞なら絞る", async () => {
    // 形式の「決めていない」は絞らない理由だが、種類は作者が決めた値である
    const shown = await shownCommands(await providerForKind(undefined, "lyrics"));
    expect(shown).not.toContain("novelai.checkForeshadows");
    expect(shown).toContain("novelai.checkTypos");
  });

  test("filterSteps は、形式と種類の両方が「見せる」ときだけ残す", () => {
    const step: Step = {
      kind: "step",
      label: "試験用",
      icon: "beaker",
      detail: "",
      entries: [action("novelai.checkForeshadows"), action("novelai.createPlot")],
    };
    const commands = (steps: Step[]): string[] => commandsIn(steps);

    expect(commands(filterSteps([step], "novel", "essay"))).toEqual([
      "novelai.createPlot",
    ]);
    expect(commands(filterSteps([step], undefined, "essay"))).toEqual([
      "novelai.createPlot",
    ]);
    expect(commands(filterSteps([step], "memo", "novel"))).toEqual([]);
    expect(commands(filterSteps([step], undefined, undefined))).toEqual([
      "novelai.checkForeshadows",
      "novelai.createPlot",
    ]);
  });
});
