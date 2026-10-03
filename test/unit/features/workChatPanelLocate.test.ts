import { beforeEach, describe, expect, test, vi } from "vitest";
import * as vscode from "vscode";
import type { WorkEntry } from "../../../src/models/types";

/**
 * 相談の「そこを見せて」が、本文へ飛ぶ1本の道（`revealLocation.ts`）を通る（0.97.8）。
 *
 * 以前は列を決めずに `showTextDocument` で素のエディターを開いていたため、
 * 原稿エディターで開いている話を指すと、原稿の列に素のタブが重なった
 * （0.97.7 の提案パネルの［適用］と同じ形）。
 *
 * 確かめること：
 * - 引用の見つかった行で `revealTextLocation` を呼び、原稿エディターの口を渡す
 * - 自分では `showTextDocument` を呼ばない
 * - 引用が見つからなければ、ファイルの先頭で開いて「見つからない」と伝える
 */

vi.mock("../../../src/core/chatLog", () => ({
  appendChatLog: () => undefined,
  summarizeMaterials: () => [],
}));
vi.mock("../../../src/core/logger", () => ({
  logFailure: () => undefined,
  logStep: () => undefined,
  logLine: () => undefined,
  useLogFile: () => undefined,
}));

const revealed: Array<{ filePath: string; line: number; hasManuscript: boolean }> = [];
vi.mock("../../../src/features/revealLocation", () => ({
  revealTextLocation: vi.fn(
    async (filePath: string, line: number, revealInManuscript?: unknown) => {
      revealed.push({ filePath, line, hasManuscript: revealInManuscript !== undefined });
    }
  ),
}));

const { WorkChatPanel } = await import("../../../src/features/workChatPanel");

const WORK: WorkEntry = {
  id: "w1",
  title: "春の庭",
  folderPath: "C:\\novels\\春の庭",
  registeredAt: "2026-10-03T00:00:00.000Z",
};
const EPISODE = "C:\\novels\\春の庭\\第1話.txt";
const TEXT = "　朝の廊下は静かだった。\n　彼は走つた。\n　窓の外で鐘が鳴る。\n";

const showTextDocument = vi.fn();

function makePanel() {
  const registry = { list: () => [WORK] };
  const ai = {
    onDidChangeSelection: () => ({ dispose: () => undefined }),
    resolve: () => undefined,
  };
  const runner = {
    run: async () => undefined,
    reload: async () => undefined,
    revealInManuscript: async () => true,
  };
  return new WorkChatPanel(
    registry as unknown as ConstructorParameters<typeof WorkChatPanel>[0],
    ai as unknown as ConstructorParameters<typeof WorkChatPanel>[1],
    runner as unknown as ConstructorParameters<typeof WorkChatPanel>[2]
  );
}

/** 押されるのを待つ提案を置き、［そこを見せて］を押す */
async function pressLocate(text: string): Promise<Array<Record<string, unknown>>> {
  const panel = makePanel();
  const sent: Array<Record<string, unknown>> = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const internal = panel as any;
  internal.postAll = (message: Record<string, unknown>) => sent.push(message);
  internal.pendingLocates.set("locate-1", {
    locate: { label: "そこ", text },
    work: WORK,
    fallbackPath: EPISODE,
  });
  await internal.showLocation("locate-1");
  return sent;
}

beforeEach(() => {
  revealed.length = 0;
  showTextDocument.mockClear();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const workspace = vscode.workspace as any;
  workspace.openTextDocument = vi.fn(async () => ({
    uri: { toString: () => "file:///novels/1" },
    getText: () => TEXT,
  }));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (vscode.window as any).showTextDocument = showTextDocument;
});

describe("「そこを見せて」は、本文へ飛ぶ1本の道を通る", () => {
  test("引用の行で原稿エディターの口へ渡し、素のエディターを自分で開かない", async () => {
    const sent = await pressLocate("彼は走つた。");

    expect(revealed).toEqual([{ filePath: EPISODE, line: 2, hasManuscript: true }]);
    expect(showTextDocument).not.toHaveBeenCalled();
    expect(sent).toEqual([
      expect.objectContaining({ type: "locateDone", id: "locate-1" }),
    ]);
  });

  test("引用が見つからなければ、先頭で開いて「見つからない」と伝える", async () => {
    const sent = await pressLocate("どこにも無い文。");

    expect(revealed).toEqual([{ filePath: EPISODE, line: 1, hasManuscript: true }]);
    expect(showTextDocument).not.toHaveBeenCalled();
    expect(sent).toEqual([
      expect.objectContaining({ type: "locateFailed", id: "locate-1" }),
    ]);
  });
});
