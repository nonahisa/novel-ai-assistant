import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { PROCEDURE_REFERENCED_COMMANDS } from "../../src/core/procedures";
import {
  ActionListProvider,
  type ActionNode,
  type GroupStateStore,
} from "../../src/views/actionList";
import { StepMenuProvider, type StepNode } from "../../src/views/stepMenu";
import { describeSpotlight } from "../../src/features/actionSpotlight";
import type { WorkEntry } from "../../src/models/types";
import type { WorkRegistry } from "../../src/core/workRegistry";

/**
 * 画面で指しながらの案内——**繋ぎ目**（設計書6.104。第1段）。
 *
 * 判断そのものは `guidedTour.test.ts` で見る。ここで守るのは、
 * 判断が画面へ届くまでの道である。
 *
 * 1. 手順書きが指すすべての操作を、**どちらかのツリーで引ける**
 *    （引けないと、押す場所を光らせられない）
 * 2. `TreeView.reveal()` に要る**親をたどれる**
 * 3. 押されたことを拾う口が、**成功して返ったときだけ**呼ばれる
 * 4. 相談パネルの画面に、案内の札のやり取りが**揃っている**
 */

const work: WorkEntry = {
  id: "w1",
  title: "ためし",
  folderPath: "C:/works/w1",
  registeredAt: "2026-09-21T00:00:00.000Z",
};

function fakeRegistry(): WorkRegistry {
  return {
    list: () => [work],
    onDidChange: () => ({ dispose() {} }),
  } as unknown as WorkRegistry;
}

const noStore: GroupStateStore = { get: () => [], set: () => undefined };

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

describe("押す場所を引けること", () => {
  test("手順書きの全段が、どちらかのツリーで見つかる", () => {
    const { actions, steps } = providers();
    const missing = [...new Set(PROCEDURE_REFERENCED_COMMANDS)].filter(
      (command) =>
        !steps.findActionNode(command) && !actions.findActionNode(command)
    );
    expect(missing, "光らせる場所が画面に無い操作").toEqual([]);
  });

  test("知らないコマンドは引けない（黙って当てない）", () => {
    const { actions, steps } = providers();
    expect(steps.findActionNode("novelai.存在しない操作")).toBeUndefined();
    expect(actions.findActionNode("novelai.存在しない操作")).toBeUndefined();
  });

  test("簡単ステップメニューに無い操作は、詳細メニューのほうで引ける", () => {
    /*
      「投稿の準備をする」の最後の段（新話を投稿する）は、**簡単ステップ
      メニューには置いていない**（設計書6.104）。片方に無いことを知らずに
      片方だけ探すと、**光らせる場所が無いまま案内が進む**——作者から見ると
      「案内しますと言ったのに、どこも光らない」になる。

      上の総当たりは「どちらかで引ける」しか見ていないので、**どちらで
      引けるのか**をここで名指しにしておく。
    */
    const { actions, steps } = providers();
    expect(
      steps.findActionNode("novelai.postNewEpisode"),
      "簡単ステップメニューに入った（この前提が変わった）"
    ).toBeUndefined();
    expect(
      actions.findActionNode("novelai.postNewEpisode"),
      "詳細メニューからも引けない（案内が行き止まる）"
    ).toBeDefined();
  });
});

describe("親をたどれること（reveal の前提）", () => {
  test("詳細メニュー：操作 → 小分類か分類 → 最上位", () => {
    const { actions } = providers();
    for (const command of new Set(PROCEDURE_REFERENCED_COMMANDS)) {
      const node = actions.findActionNode(command);
      if (!node) continue;
      // 最上位（分類）へ着くまでたどれること。無限に回らないよう上限を置く
      let cursor: ActionNode | undefined = node;
      let hops = 0;
      while (cursor && cursor.type !== "group" && hops < 5) {
        cursor = actions.getParent(cursor);
        hops += 1;
      }
      expect(cursor?.type, `${command} の親をたどれない`).toBe("group");
    }
    // 最上位の親は無い
    const top = actions.getChildren()[0];
    expect(actions.getParent(top)).toBeUndefined();
  });

  test("簡単ステップメニュー：操作 → 小分類か段階 → 最上位", () => {
    const { steps } = providers();
    for (const command of new Set(PROCEDURE_REFERENCED_COMMANDS)) {
      const node = steps.findActionNode(command);
      if (!node) continue;
      let cursor: StepNode | undefined = node;
      let hops = 0;
      while (cursor && cursor.type !== "step" && hops < 5) {
        cursor = steps.getParent(cursor);
        hops += 1;
      }
      expect(cursor?.type, `${command} の親をたどれない`).toBe("step");
    }
    // 最上段の作品選択に親は無い
    expect(steps.getParent({ type: "selector" })).toBeUndefined();
  });
});

describe("光らせた場所の言い方", () => {
  test("見つからなかったことを隠さない", () => {
    // **光ったことにして案内を続けない。** 画面のどこにも無いものを
    // 探させることになる
    expect(describeSpotlight({ shown: false })).toContain("見当たりません");
    expect(describeSpotlight({ shown: true, view: "steps" })).toContain(
      "簡単ステップメニュー"
    );
    expect(describeSpotlight({ shown: true, view: "actions" })).toContain(
      "詳細メニュー"
    );
  });
});

/**
 * `extension.ts` の `activate` は単体では動かせないので、
 * **書いてあるコードの形**で見る（`chatRunEntry.test.ts` と同じやり方）。
 */
describe("押されたことを拾う口", () => {
  const source = readFileSync("src/extension.ts", "utf8");

  test("コマンド登録の包みの中で、callback を待ってから呼んでいる", () => {
    const start = source.indexOf(
      "const registerCommand: typeof vscode.commands.registerCommand"
    );
    expect(start, "登録の包みが見つからない").toBeGreaterThan(-1);
    const body = source.slice(start, start + 2_500);

    const awaited = body.indexOf("await callback.apply(thisArg, args)");
    const notified = body.indexOf("onCommandFinished?.(command)");
    expect(awaited, "callback の呼び出しが見つからない").toBeGreaterThan(-1);
    expect(notified, "通知が見つからない").toBeGreaterThan(-1);
    // **成功して返ったあと**であること。前で呼ぶと、前提の関門で
    // 止まった回まで「済んだ」ことになる
    expect(notified).toBeGreaterThan(awaited);
  });

  test("相談パネルへ繋いであり、光らせる先も渡してある", () => {
    expect(source).toContain(
      "onCommandFinished = (command) => workChatPanel.notifyCommandRun(command)"
    );
    expect(source).toContain("workChatPanel.setTourSpotlight(");
    // 3つのツリーのうち、押す場所になる2つを渡している
    expect(source).toContain("createActionSpotlight({");
  });
});

describe("相談パネルの画面", () => {
  const html = readFileSync("src/views/workChatPanelHtml.ts", "utf8");

  test("案内の札の、出す口と押す口が揃っている", () => {
    // 拡張機能 → 画面
    for (const kind of ["tourStep", "tourEnded", "tourNote"]) {
      expect(html, `${kind} を受け取っていない`).toContain(
        `message.type === '${kind}'`
      );
    }
    // 画面 → 拡張機能
    for (const kind of ["startTour", "tourRun", "tourStop"]) {
      expect(html, `${kind} を送っていない`).toContain(`type: '${kind}'`);
    }
  });

  test("1段につき出すものが揃っている", () => {
    // いま何番目か・何をするか・次に何を見るか・代わりに押して・やめる
    expect(html).toContain("step.position");
    expect(html).toContain("step.label");
    expect(html).toContain("step.why");
    expect(html).toContain("step.check");
    expect(html).toContain("代わりに押して");
    expect(html).toContain("やめる");
  });
});
