import { describe, expect, test, vi } from "vitest";

/**
 * 見張りの知らせから、2つのパネルの指摘を追いつかせる配線（作者の知らせ
 * 2026-11-27。設計書6.96.5）。
 *
 * 提案パネルが照らし直したあとに、校正・メモパネルが読み直す。片方が落ちても
 * もう片方は動く。
 */

vi.mock("vscode", () => ({
  workspace: { getConfiguration: () => ({ get: (_k: string, d?: unknown) => d }) },
  window: {
    createOutputChannel: () => ({
      appendLine: () => undefined,
      show: () => undefined,
      dispose: () => undefined,
    }),
  },
  Uri: { file: (p: string) => ({ fsPath: p }) },
}));

import { followManuscriptEdit } from "../../../src/features/manuscriptEditFollow";
import type { WorkEntry } from "../../../src/models/types";

const work: WorkEntry = {
  id: "w1",
  title: "いじめられっ子",
  folderPath: "C:/小説/いじめられっ子",
  registeredAt: "2026-09-19T00:00:00.000Z",
};

describe("followManuscriptEdit", () => {
  test("提案パネルの照らし直しのあとに、校正・メモパネルを読み直す", async () => {
    const order: string[] = [];
    await followManuscriptEdit(work, {
      noteManuscriptEdited: async (w) => {
        order.push(`照らす:${w.id}`);
      },
      refreshFindings: async (id) => {
        order.push(`読み直す:${id}`);
      },
    });
    expect(order).toEqual(["照らす:w1", "読み直す:w1"]);
  });

  test("照らし直しが落ちても、校正・メモパネルは読み直す", async () => {
    const refreshFindings = vi.fn(async () => undefined);
    await expect(
      followManuscriptEdit(work, {
        noteManuscriptEdited: async () => {
          throw new Error("落ちた");
        },
        refreshFindings,
      })
    ).resolves.toBeUndefined();
    expect(refreshFindings).toHaveBeenCalledWith("w1");
  });

  test("見張りが受けた道を、提案パネルの照らし直しへそのまま渡す", async () => {
    const noteManuscriptEdited = vi.fn(async () => undefined);
    const files = ["C:/小説/いじめられっ子/本文/001.txt"];
    await followManuscriptEdit(work, { noteManuscriptEdited, refreshFindings: async () => undefined }, files);
    expect(noteManuscriptEdited).toHaveBeenCalledWith(work, files);
  });

  test("読み直しが落ちても、知らせの側へ投げ返さない", async () => {
    await expect(
      followManuscriptEdit(work, {
        noteManuscriptEdited: async () => undefined,
        refreshFindings: async () => {
          throw new Error("落ちた");
        },
      })
    ).resolves.toBeUndefined();
  });
});
