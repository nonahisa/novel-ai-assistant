import * as path from "path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { FileSystemError, Uri, window, workspace } from "../support/vscodeStub";
import type { EpisodeFile, WorkEntry } from "../../../src/models/types";

/**
 * 投稿済みのメモを別の作品へ移すとき、**移す前に**「投稿の記録が N件残ります」と
 * 言う（設計書6.71。実機確認リスト F-70 の代わり）。
 *
 * 台帳は書き換えない（移管は戻せる操作で、戻せば記録はまた正しくなる）。
 * 黙って残すと作者は「記録が消えたのか」と探し、黙って消すと戻せなくなる。
 *
 * 移すこと自体（ファイルの移動）は `workMemos.test.ts` が見ている。ここでは
 * 移動を差し替え、**確認に何が書かれるか**だけを見る。記録が無いときに
 * 何も言わないことも見る——片方だけだと「いつも言う」実装でも通る。
 */

const moves = vi.hoisted(() => ({ transferMemoToWork: vi.fn() }));
vi.mock("../../../src/core/workMemos", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/core/workMemos")>()),
  transferMemoToWork: moves.transferMemoToWork,
}));
vi.mock("../../../src/core/logger", () => ({
  logFailure: vi.fn(),
  logStep: vi.fn(),
  logLine: vi.fn(),
  useLogFile: vi.fn(),
}));

const { transferMemo } = await import("../../../src/features/manageWorkMemos");

const memoWork: WorkEntry = {
  id: "work_memo",
  title: "創作メモ集",
  folderPath: path.join("C:", "novels", "memos"),
  registeredAt: "2026-09-04T00:00:00.000Z",
};

const novelWork: WorkEntry = {
  id: "work_novel",
  title: "氷の街",
  folderPath: path.join("C:", "novels", "ice"),
  registeredAt: "2026-09-04T00:00:00.000Z",
};

const episode = {
  filePath: path.join(memoWork.folderPath, "本文", "旅の途中.md"),
  fileName: "旅の途中.md",
} as EpisodeFile;

const disk = new Map<string, Uint8Array>();
const ledgerPath = Uri.file(
  path.join(memoWork.folderPath, "設定", "投稿状態.json")
).fsPath;

/** 確認に渡された本文（見出しと detail） */
let confirmations: Array<{ message: string; detail: string }> = [];
const originalQuickPick = window.showQuickPick;
const originalWarning = window.showWarningMessage;

beforeEach(() => {
  disk.clear();
  confirmations = [];
  moves.transferMemoToWork.mockReset();
  workspace.textDocuments = [];
  workspace.fs = {
    createDirectory: async () => undefined,
    readFile: async (uri: { fsPath: string }) => {
      const bytes = disk.get(uri.fsPath);
      if (!bytes) throw new FileSystemError("missing", "FileNotFound");
      return bytes;
    },
    stat: async (uri: { fsPath: string }) => {
      if (!disk.has(uri.fsPath)) {
        throw new FileSystemError("missing", "FileNotFound");
      }
      return { type: 1, ctime: 0, mtime: 0, size: 0 };
    },
  } as unknown as typeof workspace.fs;

  // 移す先には「氷の街」を選ぶ
  (window as unknown as Record<string, unknown>).showQuickPick = async (
    items: Array<Record<string, unknown>>
  ) => items.find((item) => (item.work as WorkEntry | undefined)?.id === novelWork.id);
  // 確認は読むだけで、「移す」は押さない（移動の結果はこの試験の外）
  window.showWarningMessage = (async (
    message: string,
    options?: { detail?: string }
  ) => {
    confirmations.push({ message, detail: options?.detail ?? "" });
    return undefined;
  }) as typeof window.showWarningMessage;
});

afterEach(() => {
  window.showQuickPick = originalQuickPick;
  window.showWarningMessage = originalWarning;
});

const registry = { list: () => [memoWork, novelWork] };

describe("メモを別の作品へ移す前の確認", () => {
  test("投稿の記録があれば、件数と残る場所を確認に書く", async () => {
    disk.set(
      ledgerPath,
      new TextEncoder().encode(
        JSON.stringify({
          posts: [
            {
              episodePath: "本文/旅の途中.md",
              site: "kakuyomu",
              postedAt: "2026-09-04T10:00:00.000Z",
            },
          ],
        })
      )
    );

    await transferMemo(memoWork, episode, registry as never);

    expect(confirmations).toHaveLength(1);
    expect(confirmations[0].detail).toContain(
      "投稿の記録が1件、創作メモ集 の投稿状態.json に残ります（消しません）。"
    );
    // 「移す」を押していないので、移していない
    expect(moves.transferMemoToWork).not.toHaveBeenCalled();
  });

  test("別の話の記録は数えない", async () => {
    disk.set(
      ledgerPath,
      new TextEncoder().encode(
        JSON.stringify({
          posts: [
            {
              episodePath: "本文/別の話.md",
              site: "kakuyomu",
              postedAt: "2026-09-04T10:00:00.000Z",
            },
          ],
        })
      )
    );

    await transferMemo(memoWork, episode, registry as never);

    expect(confirmations[0].detail).not.toContain("投稿の記録");
  });

  test("台帳が無ければ、投稿の記録には触れない", async () => {
    await transferMemo(memoWork, episode, registry as never);

    expect(confirmations).toHaveLength(1);
    expect(confirmations[0].detail).not.toContain("投稿の記録");
  });
});
