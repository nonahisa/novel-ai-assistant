import { describe, expect, test } from "vitest";
import {
  ActionListProvider,
  type ActionNode,
} from "../../../src/views/actionList";
import { isDetailMenuArgs } from "../../../src/core/workTarget";
import type { WorkRegistry } from "../../../src/core/workRegistry";

/**
 * 詳細メニューの、作品が要る項目は「詳細メニューから押した」印を渡す
 * （作者の判断 2026-11-02）。
 *
 * **印が無いと、コマンドの側は作品パレットから呼ばれたのと見分けられない。**
 * 作品一覧の選択や相談の作品で黙って走らせると、作者から見ると
 * どの作品で走ったのかが押す前に分からない。印を受けた側は毎回作品を訊く
 * （`extension.ts` の `resolveWork`）。
 */

function registryWith(count: number): WorkRegistry {
  return {
    list: () =>
      Array.from({ length: count }, (_, i) => ({
        id: `w-${i}`,
        title: `作品${i}`,
        folderPath: `C:/works/${i}`,
      })),
    onDidChange: () => ({ dispose: () => undefined }),
  } as unknown as WorkRegistry;
}

function allActionNodes(provider: ActionListProvider): ActionNode[] {
  const out: ActionNode[] = [];
  const walk = (node?: ActionNode): void => {
    for (const child of provider.getChildren(node)) {
      if (child.type === "action") out.push(child);
      else walk(child);
    }
  };
  walk();
  return out;
}

describe("詳細メニューから押した印", () => {
  const provider = new ActionListProvider(registryWith(3));
  const nodes = allActionNodes(provider);

  test("作品が要る項目は、印を渡す", () => {
    const requiring = nodes.filter(
      (node) =>
        node.type === "action" &&
        node.item.requiresWork &&
        node.item.command.startsWith("novelai.")
    );
    expect(requiring.length).toBeGreaterThan(0);
    for (const node of requiring) {
      const command = provider.getTreeItem(node).command;
      expect(
        isDetailMenuArgs(command?.arguments?.[0]),
        node.type === "action" ? node.item.command : ""
      ).toBe(true);
    }
  });

  test("作品の要らない項目には、印を渡さない", () => {
    for (const node of nodes) {
      if (node.type !== "action" || node.item.requiresWork) continue;
      const command = provider.getTreeItem(node).command;
      expect(command?.arguments ?? [], node.item.command).toEqual([]);
    }
  });
});
