import { describe, expect, test, vi } from "vitest";
import type * as vscode from "vscode";
import type { WorkEntry } from "../../../src/models/types";
import type { WorkRegistry } from "../../../src/core/workRegistry";
import type { EditorProgressFacts } from "../../../src/core/editorProgress";

/**
 * 編集者モードで、相談・案内・外部AIが**編集者メニューの行**を光らせる（設計書6.118 と 6.104）。
 *
 * 0.128.0 で編集者メニュー（横の枠の一番上）を足したが、光らせる仕組みは簡単ステップメニューと
 * 詳細メニューしか探していなかった。編集者モードでは簡単ステップメニューが空なので、
 * - 編集者メニューにしか無い操作（置いた提案の一覧など）は「見当たりません」になり、
 * - 両方にある操作（校閲を終えて返す）は、編集者が見ていない詳細メニューのほうが光った。
 */

let mode: "author" | "editor" = "editor";
vi.mock("../../../src/core/actorContext", () => ({
  currentMode: () => mode,
  isEditorMode: () => mode === "editor",
}));

const { EditorMenuProvider } = await import("../../../src/views/editorMenu");
type EditorMenuNode = import("../../../src/views/editorMenu").EditorMenuNode;
const { ActionListProvider } = await import("../../../src/views/actionList");
type ActionNode = import("../../../src/views/actionList").ActionNode;
const { StepMenuProvider } = await import("../../../src/views/stepMenu");
type StepNode = import("../../../src/views/stepMenu").StepNode;
const { createActionSpotlight, describeSpotlight } = await import(
  "../../../src/features/actionSpotlight"
);

const joined: WorkEntry = {
  id: "w1",
  title: "砂の塔",
  folderPath: "D:/預かり/suna",
  registeredAt: "2026-11-05T00:00:00.000Z",
  joinedAsEditor: true,
};
const registry = {
  list: () => [joined],
  onDidChange: () => ({ dispose() {} }),
} as unknown as WorkRegistry;
const facts: EditorProgressFacts = { myLocks: [], myProposals: [], seenDecisions: new Set() };
const noStore = { get: () => [], set: () => undefined };
const noWait = { blinkMs: 0, sleep: async (): Promise<void> => undefined };

function fakeView<T>(seen: T[]): vscode.TreeView<T> {
  return {
    reveal: async (node: T): Promise<void> => {
      seen.push(node);
    },
  } as unknown as vscode.TreeView<T>;
}

function setup(active: boolean) {
  const editorSeen: EditorMenuNode[] = [];
  const actionSeen: ActionNode[] = [];
  const editorProvider = new EditorMenuProvider(
    registry,
    { get: () => "w1", set: () => undefined },
    async () => ({ facts })
  );
  const spotlight = createActionSpotlight(
    {
      stepView: fakeView<StepNode>([]),
      stepProvider: new StepMenuProvider(registry, { get: () => "w1", set: () => undefined }, noStore),
      actionView: fakeView(actionSeen),
      actionProvider: new ActionListProvider(registry, noStore),
      editorMenu: { view: fakeView(editorSeen), provider: editorProvider, active: () => active },
    },
    noWait
  );
  return { spotlight, editorSeen, actionSeen, editorProvider };
}

describe("編集者モードでは、編集者メニューの行を光らせる", () => {
  test("編集者メニューにしか無い操作（置いた提案の一覧）も光る", async () => {
    mode = "editor";
    const { spotlight, editorSeen } = setup(true);
    const result = await spotlight.show("novelai.listPlacedProposals");
    expect(result).toEqual({ shown: true, view: "editorMenu" });
    const hits = editorSeen.filter(
      (node) => node.type === "action" && node.item.command === "novelai.listPlacedProposals"
    );
    expect(hits, "2回光らせる").toHaveLength(2);
    // 間に親（5. 置いた提案を見直す）を選び直して、瞬かせる
    expect(editorSeen[1]).toMatchObject({ type: "step", def: { key: "review" } });
  });

  test("押すとそのまま走る手順は、手順の行そのものを光らせる（詳細メニューへ回らない）", async () => {
    mode = "editor";
    const { spotlight, editorSeen, actionSeen } = setup(true);
    const result = await spotlight.show("novelai.finishReviewAndReturn");
    expect(result).toEqual({ shown: true, view: "editorMenu" });
    expect(editorSeen[0]).toMatchObject({ type: "step", def: { key: "return" } });
    expect(actionSeen).toEqual([]);
    expect(describeSpotlight(result)).toContain("編集者メニュー");
  });

  test("ヘルプの中と、作者モードへ戻る行も引ける", () => {
    mode = "editor";
    const { editorProvider } = setup(true);
    const log = editorProvider.findActionNode("novelai.showLog");
    expect(log).toMatchObject({ type: "action", parent: "help" });
    expect(editorProvider.getParent(log!)).toEqual({ type: "help" });
    expect(editorProvider.findActionNode("novelai.switchMode")).toEqual({ type: "back" });
    expect(editorProvider.findActionNode("novelai.存在しない操作")).toBeUndefined();
  });

  test("作者モードでは編集者メニューを探さない（ビューが出ていない）", async () => {
    mode = "author";
    const { spotlight, editorSeen } = setup(false);
    const result = await spotlight.show("novelai.listPlacedProposals");
    expect(result).toEqual({ shown: false });
    expect(editorSeen).toEqual([]);
  });
});
