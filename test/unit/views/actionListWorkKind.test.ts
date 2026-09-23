import { describe, expect, test } from "vitest";
import {
  ActionListProvider,
  type ActionNode,
  type GroupStateStore,
} from "../../../src/views/actionList";
import type { WorkEntry, WorkKindKey } from "../../../src/models/types";
import type { WorkRegistry } from "../../../src/core/workRegistry";

/**
 * 詳細メニューを、作品の種類で絞る（設計書6.109.7）。
 *
 * 詳細メニューは作品を選ばない画面で、形式では絞らない（「全部はここに
 * ある」受け皿、6.70.1）。種類だけは、**登録した作品が全部物語でない**
 * と分かっているときに限って、人物・筋・伏線の操作を外す。歌詞だけを
 * 書いている作者に、伏線の操作を並べ続けないため。
 */

function work(id: string): WorkEntry {
  return {
    id,
    title: id,
    folderPath: `C:/works/${id}`,
    registeredAt: "2026-09-24T00:00:00.000Z",
  };
}

function fakeRegistry(works: WorkEntry[]): WorkRegistry {
  return {
    list: () => works,
    onDidChange: () => ({ dispose() {} }),
  } as unknown as WorkRegistry;
}

const noStore: GroupStateStore = { get: () => [], set: () => undefined };

function provider(kinds: readonly (WorkKindKey | undefined)[]): ActionListProvider {
  const works = kinds.map((_, index) => work(`w${index}`));
  return new ActionListProvider(
    fakeRegistry(works),
    noStore,
    undefined,
    () => kinds
  );
}

/** 画面に並ぶコマンドIDを、ツリーをたどって集める */
function shownCommands(actions: ActionListProvider): string[] {
  const commands: string[] = [];
  const walk = (node?: ActionNode): void => {
    for (const child of actions.getChildren(node)) {
      if (child.type === "action") commands.push(child.item.command);
      else walk(child);
    }
  };
  walk();
  return commands;
}

describe("詳細メニューを種類で絞る", () => {
  test("小説の作品があれば、いままでと同じものが並ぶ", () => {
    const withNovel = shownCommands(provider(["essay", "novel"]));
    const unknown = shownCommands(provider([undefined]));
    expect(withNovel).toEqual(unknown);
    expect(withNovel).toContain("novelai.checkForeshadows");
  });

  test("全部がエッセイ・歌詞なら、伏線・矛盾・人物抽出が並ばない", () => {
    const shown = shownCommands(provider(["essay", "lyrics"]));
    for (const command of [
      "novelai.checkForeshadows",
      "novelai.checkContradictions",
      "novelai.extractSettings",
      "novelai.openSettingsPanel",
    ]) {
      expect(shown, command).not.toContain(command);
    }
    // 校正と種類を変える入口は残る
    expect(shown).toContain("novelai.checkTypos");
    expect(shown).toContain("novelai.setWorkKind");
  });

  test("隠した操作は、案内で光らせる先としても引けない（画面に無い行を開かない）", () => {
    const actions = provider(["lyrics"]);
    expect(actions.findActionNode("novelai.checkForeshadows")).toBeUndefined();
    expect(actions.findActionNode("novelai.checkTypos")).toBeDefined();
  });

  test("中身が全部隠れた分類は、見出しごと出さない", () => {
    const actions = provider(["essay"]);
    for (const node of actions.getChildren()) {
      if (node.type === "action") continue;
      expect(actions.getChildren(node).length, JSON.stringify(node).slice(0, 80)).toBeGreaterThan(0);
    }
  });
});
