import { describe, expect, test, vi } from "vitest";
import * as vscode from "vscode";
import type { WorkEntry } from "../../../src/models/types";

/**
 * **相談パネルで選んだ作品を、次の起動でも覚えている**（残課題 R7、2026-10-01）。
 *
 * 以前は選んだ作品をパネルの中（`selectedWorkId`）にしか持っておらず、
 * VS Code を閉じると忘れていた。簡単ステップメニューは `globalState` に
 * 覚えているので、同じ置き場へ覚えるようにした。
 *
 * **見張りたいのは3つ。**
 *
 * 1. 覚えた作品が、次に開いたときの既定になる
 * 2. 登録から外れた作品は使わない（消えた作品を指したまま相談しない）
 * 3. 選び直したときだけ知らせる（窓の札の書き直しを増やしすぎない）
 */

vi.mock("../../../src/core/logger", () => ({
  logFailure: () => undefined,
  logStep: () => undefined,
  logLine: () => undefined,
  useLogFile: () => undefined,
}));

const { WorkChatPanel } = await import("../../../src/features/workChatPanel");

function work(id: string, title: string): WorkEntry {
  return { id, title, folderPath: `C:/works/${title}` } as WorkEntry;
}

const A = work("work-a", "灯台");
const B = work("work-b", "港町");

function memoryOf(initial?: string) {
  let value = initial;
  const set = vi.fn((id: string) => {
    value = id;
  });
  return { memory: { get: () => value, set }, set, current: () => value };
}

function panelWith(works: WorkEntry[]) {
  const registry = { list: () => works };
  const ai = {
    onDidChangeSelection: () => ({ dispose: () => undefined }),
  };
  const runner = { run: async () => undefined };
  return new WorkChatPanel(
    registry as unknown as ConstructorParameters<typeof WorkChatPanel>[0],
    ai as unknown as ConstructorParameters<typeof WorkChatPanel>[1],
    runner as unknown as ConstructorParameters<typeof WorkChatPanel>[2]
  );
}

describe("相談パネルが選んだ作品を覚える", () => {
  test("覚えた作品が、次に開いたときの既定になる", () => {
    const panel = panelWith([A, B]);
    panel.setSelectedWorkMemory(memoryOf(B.id).memory);

    expect(panel.selectedWork()?.id).toBe(B.id);
    expect(panel.currentWorkId()).toBe(B.id);
  });

  test("登録から外れた作品は使わない", () => {
    const panel = panelWith([A, B]);
    panel.setSelectedWorkMemory(memoryOf("removed-work").memory);

    expect(panel.selectedWork()).toBeUndefined();
    expect(panel.currentWorkId()).toBeUndefined();
  });

  test("選び直すと覚え直し、知らせる", async () => {
    const panel = panelWith([A, B]);
    const box = memoryOf(A.id);
    panel.setSelectedWorkMemory(box.memory);
    const changed = vi.fn();
    panel.onDidChangeSelectedWork(changed);

    const pick = vi
      .spyOn(vscode.window, "showQuickPick")
      .mockImplementation((async (items: readonly { work?: WorkEntry }[]) =>
        items.find((item) => item.work?.id === B.id)) as unknown as typeof vscode.window.showQuickPick);
    try {
      await panel.chooseWork();
    } finally {
      pick.mockRestore();
    }

    expect(box.current()).toBe(B.id);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(panel.selectedWork()?.id).toBe(B.id);
  });

  test("同じ作品を選び直しても、書き直さない", async () => {
    const panel = panelWith([A, B]);
    const box = memoryOf(A.id);
    panel.setSelectedWorkMemory(box.memory);
    const changed = vi.fn();
    panel.onDidChangeSelectedWork(changed);

    await panel.focusWork(A);

    expect(box.set).not.toHaveBeenCalled();
    expect(changed).not.toHaveBeenCalled();
  });

  test("新しく作った作品へ移したときも覚える", async () => {
    const panel = panelWith([A, B]);
    const box = memoryOf(undefined);
    panel.setSelectedWorkMemory(box.memory);
    const changed = vi.fn();
    panel.onDidChangeSelectedWork(changed);

    await panel.focusWork(B);

    expect(box.current()).toBe(B.id);
    expect(changed).toHaveBeenCalledTimes(1);
  });
});
