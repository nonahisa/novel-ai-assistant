import { describe, expect, test, vi } from "vitest";
import type { WorkEntry } from "../../../src/models/types";
import type { WorkRegistry } from "../../../src/core/workRegistry";
import type { EditorProgressFacts } from "../../../src/core/editorProgress";

/**
 * 編集者モードでは、自分の作品を出さない（作者の指示 2026-11-05 夜。設計書5.6.6）。
 * 作者モードで作品を登録したあと「作者／編集者切替」で編集者モードにした環境でも、
 * 編集者メニューの作品の切り替えと手順の対象には、参加した作品だけが出る。
 */

vi.mock("../../../src/core/actorContext", () => ({
  currentMode: () => "editor",
  isEditorMode: () => true,
}));

const { EditorMenuProvider } = await import("../../../src/views/editorMenu");
const { isJoinedWork } = await import("../../../src/core/editorWorks");

const own: WorkEntry = { id: "own", title: "氷の街", folderPath: "C:\\小説\\氷の街", registeredAt: "2026-10-01T00:00:00.000Z" };
const joined: WorkEntry = { id: "new", title: "砂の塔", folderPath: "D:\\預かり\\suna", registeredAt: "2026-11-05T00:00:00.000Z", joinedAsEditor: true };
const legacy: WorkEntry = { id: "old", title: "たゆたう鉛", folderPath: "C:\\Users\\kmizu\\Documents\\編集部\\tayutau", registeredAt: "2026-11-01T00:00:00.000Z" };

const facts: EditorProgressFacts = { myLocks: [], myProposals: [], seenDecisions: new Set() };

function menu(works: WorkEntry[], selected?: string) {
  const registry = { list: () => works, onDidChange: () => ({ dispose() {} }) } as unknown as WorkRegistry;
  return new EditorMenuProvider(
    registry,
    { get: () => selected, set: () => undefined },
    async () => ({ facts }),
    // 写しの印は、どの作品にも無いとして見る（印と置き場だけで見分ける）
    async (list) => list.filter((work) => isJoinedWork(work, "absent"))
  );
}

function labelOf(item: { label?: unknown }): string {
  return typeof item.label === "string" ? item.label : "";
}

describe("編集者メニューに出す作品", () => {
  test("自分の作品と参加した作品が両方あっても、切り替えに出るのは参加した作品だけ（印の無い既存の作品も出る）", async () => {
    const provider = menu([own, joined, legacy]);
    await provider.getChildren();
    expect((await provider.editorWorks()).map((work) => work.id)).toEqual(["new", "old"]);
    // 2つあるので選ぶまでは「作品を選ぶ」。自分の作品が選ばれていても対象にしない
    expect(labelOf(provider.getTreeItem({ type: "work" }))).toBe("作品を選ぶ");
  });

  test("参加した作品が1つだけなら、それが対象になる（自分の作品を選んでいても）", async () => {
    const provider = menu([own, legacy], "own");
    await provider.getChildren();
    expect(provider.selectedWork()?.id).toBe("old");
    expect(labelOf(provider.getTreeItem({ type: "work" }))).toBe("作品：たゆたう鉛");
  });

  test("参加した作品が1つも無いと見なされたら、「参加のリンクを貼る」を出す", async () => {
    const provider = menu([own]);
    const nodes = await provider.getChildren();
    expect(labelOf(provider.getTreeItem(nodes[0]))).toBe("参加のリンクを貼る");
  });
});
