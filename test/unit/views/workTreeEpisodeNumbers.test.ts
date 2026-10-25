import { beforeEach, describe, expect, test, vi } from "vitest";

/**
 * 作品一覧の作品の行に、話数の重複・欠番の印を出す（設計書5.4.5、
 * 作者の裁定 2026-10-25 夜）。
 *
 * **無ければ何も出さない。** 印は同期・競合と同じく題の前の［］に入り、
 * どの話数かはホバーで読む。走査が返した話の並びだけで決める
 * （本文を読み直さない）。
 */

vi.mock("vscode", () => ({
  TreeItem: class {
    id?: string;
    description?: string;
    constructor(
      public label: string,
      public collapsibleState?: number
    ) {}
  },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  ThemeIcon: class {
    constructor(public id: string) {}
  },
  ThemeColor: class {},
  MarkdownString: class {
    constructor(public value: string) {}
  },
  EventEmitter: class {
    event = () => ({ dispose() {} });
    fire() {}
  },
  Uri: { file: (p: string) => ({ fsPath: p, toString: () => p }) },
  workspace: {
    getConfiguration: () => ({ get: (_key: string, fallback?: unknown) => fallback }),
  },
}));

const scanWork = vi.fn();
vi.mock("../../../src/core/scanner", async () => {
  const actual =
    await vi.importActual<typeof import("../../../src/core/scanner")>(
      "../../../src/core/scanner"
    );
  return { ...actual, scanWork: (...args: unknown[]) => scanWork(...args) };
});

import { WorkTreeProvider, type WorkNode } from "../../../src/views/workTree";
import type { WorkEntry } from "../../../src/models/types";
import type { WorkRegistry } from "../../../src/core/workRegistry";

const work: WorkEntry = {
  id: "w1",
  title: "氷の街",
  folderPath: "C:/novels/ice",
  registeredAt: "2026-10-25T00:00:00.000Z",
};

function episode(n: number) {
  return {
    filePath: `C:/novels/ice/本文/${n}.txt`,
    fileName: `${n}.txt`,
    ext: ".txt",
    chapterStart: n,
    chapterEnd: n,
    subtitle: null,
    kind: "本編",
    isInitialName: true,
    counts: { gross: 10, net: 10, lines: 1, paragraphs: 1, manuscriptLines: 1 },
    hasMetadata: false,
    metaTitle: null,
    declaredCharCount: null,
    metaUpdatedAt: null,
    hasConflictMarkers: false,
    collectedCount: null,
  };
}

interface Item {
  label: string;
  description?: string;
  tooltip?: { value: string };
}

async function itemFor(numbers: number[]): Promise<Item> {
  scanWork.mockResolvedValue({
    episodes: numbers.map(episode),
    stats: {
      fileCount: numbers.length,
      totals: { net: 10, gross: 10, manuscriptLines: 1 },
      conflictedCount: 0,
    },
    manuscriptDir: "本文",
  });
  const registry = {
    list: () => [work],
    onDidChange: () => ({ dispose() {} }),
  } as unknown as WorkRegistry;
  const provider = new WorkTreeProvider(registry);
  const [node] = await provider.getChildren();
  return provider.getTreeItem(node as WorkNode) as unknown as Item;
}

beforeEach(() => {
  scanWork.mockReset();
});

describe("作品の行の話数の印（5.4.5）", () => {
  test("重複と欠番があれば、題の前に印を出し、ホバーで話数を言う", async () => {
    const item = await itemFor([1, 2, 2, 5]);

    expect(item.label).toBe("［話数の重複1件・話数の欠番2件］氷の街");
    expect(item.tooltip?.value).toContain("第2話");
    expect(item.tooltip?.value).toContain("第3話・第4話");
    // 字数の側には印を出さない（同じことを2か所で言わない）
    expect(item.description).not.toContain("話数");
  });

  test("連番なら印を出さない", async () => {
    const item = await itemFor([1, 2, 3]);

    expect(item.label).toBe("氷の街");
    expect(item.tooltip?.value).not.toContain("話数の重複");
    expect(item.tooltip?.value).not.toContain("話数の欠番");
  });
});
