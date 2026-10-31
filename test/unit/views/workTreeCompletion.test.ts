import * as path from "path";
import { beforeEach, describe, expect, test, vi } from "vitest";

/**
 * 作品一覧の作品の行の「完結」の印（作者の指示 2026-11-01）。
 *
 * - **完結の作品だけ**、説明の後ろに小さく「完結」と添える。連載中は何も付けない
 * - 見るのは**作者が決めた印だけ**。サイトから届いた印（提案）では付けない
 * - 作品の行は畳んだまま描かれるので、一覧を出すとき（全部の走査）に台帳を読む
 */

const scanWork = vi.fn();
vi.mock("../../../src/core/scanner", () => ({
  scanWork: (...args: unknown[]) => scanWork(...args),
}));

vi.mock("../../../src/core/chapterStore", () => ({
  ChapterStore: class {
    async load() {
      return { schemaVersion: "1", chapters: [] };
    }
  },
  ChapterStoreError: class extends Error {},
}));

const loadPosting = vi.fn();
vi.mock("../../../src/core/postingStore", () => ({
  PostingStore: class {
    load() {
      return loadPosting();
    }
  },
  PostingStoreError: class extends Error {},
}));

vi.mock("../../../src/core/synopsisStore", () => ({
  SynopsisStore: class {
    async load() {
      return { episodes: [] };
    }
  },
}));
vi.mock("../../../src/core/workFormatStore", () => ({
  readWorkFormat: async () => undefined,
}));

import { WorkTreeProvider } from "../../../src/views/workTree";
import {
  emptyPostingLedger,
  withSiteFacts,
  withWorkCompletion,
  type PostingLedger,
} from "../../../src/models/posting";
import type { WorkEntry } from "../../../src/models/types";
import type { WorkRegistry } from "../../../src/core/workRegistry";

const work: WorkEntry = {
  id: "work_1",
  title: "氷の街",
  folderPath: path.join("C:", "novels", "work"),
  registeredAt: "2026-09-04T00:00:00.000Z",
};

async function workRow(): Promise<{ description: string; tooltip: string }> {
  const registry = {
    list: () => [work],
    onDidChange: () => ({ dispose() {} }),
  } as unknown as WorkRegistry;
  const provider = new WorkTreeProvider(registry);
  const works = await provider.getChildren();
  const item = provider.getTreeItem(works[0]);
  return {
    description: String(item.description ?? ""),
    tooltip:
      typeof item.tooltip === "object" && item.tooltip !== null
        ? String((item.tooltip as { value?: string }).value ?? "")
        : String(item.tooltip ?? ""),
  };
}

function ledgerWith(change: (ledger: PostingLedger) => PostingLedger): PostingLedger {
  return change(emptyPostingLedger());
}

beforeEach(() => {
  scanWork.mockReset();
  loadPosting.mockReset();
  scanWork.mockResolvedValue({
    episodes: [],
    stats: {
      fileCount: 2,
      totals: { net: 0, gross: 0, lines: 0, paragraphs: 0, manuscriptLines: 0 },
      conflictedCount: 0,
    },
    manuscriptDir: "本文",
  });
  loadPosting.mockResolvedValue(emptyPostingLedger());
});

describe("作品の行の完結の印", () => {
  test("作者が完結にした作品は、説明の後ろに「完結」が付く", async () => {
    loadPosting.mockResolvedValue(
      ledgerWith((ledger) => withWorkCompletion(ledger, "completed", "2026-11-01T00:00:00.000Z"))
    );
    const row = await workRow();
    expect(row.description).toMatch(/・完結$/);
    expect(row.tooltip).toContain("連載の状態: 完結");
  });

  test("連載中の作品・決めていない作品には何も付けない", async () => {
    loadPosting.mockResolvedValue(
      ledgerWith((ledger) => withWorkCompletion(ledger, "ongoing", "2026-11-01T00:00:00.000Z"))
    );
    expect((await workRow()).description).not.toContain("完結");
    expect((await workRow()).description).not.toContain("連載");
    loadPosting.mockResolvedValue(emptyPostingLedger());
    expect((await workRow()).description).not.toContain("完結");
  });

  test("サイトから届いた完結の印だけでは付けない（作者が決めるまで提案のまま）", async () => {
    loadPosting.mockResolvedValue(
      ledgerWith(
        (ledger) =>
          withSiteFacts(ledger, {
            site: "kakuyomu",
            readAt: "2026-11-01T00:00:00.000Z",
            completion: "completed",
          }).ledger
      )
    );
    expect((await workRow()).description).not.toContain("完結");
  });

  test("台帳が読めなくても行は出る（印が無いだけ）", async () => {
    loadPosting.mockRejectedValue(new Error("壊れています"));
    const row = await workRow();
    expect(row.description).toContain("ファイル");
    expect(row.description).not.toContain("完結");
  });
});
