import * as path from "path";
import { beforeEach, describe, expect, test, vi } from "vitest";

/**
 * 作品一覧を、作品のタイプに合わせて出す（設計書6.70・6.70.1）。
 *
 * ここで確かめるのは2つ。
 *
 * 1. **右クリックを絞るための印**——ノードの `contextValue` にタイプを
 *    織り込む。`package.json` の `when` はこの文字列しか見ない
 * 2. **創作メモ集の見え方**——題名だけのファイルが、不備のように
 *    見えないこと（「？」の印も「判定不能」も出さない）
 */

const scanWork = vi.fn();
vi.mock("../../src/core/scanner", () => ({
  scanWork: (...args: unknown[]) => scanWork(...args),
}));

const readWorkFormat = vi.fn();
vi.mock("../../src/core/workFormatStore", () => ({
  readWorkFormat: (...args: unknown[]) => readWorkFormat(...args),
}));

vi.mock("../../src/core/synopsisStore", () => ({
  SynopsisStore: class {
    async load() {
      return { episodes: [] };
    }
  },
}));
vi.mock("../../src/core/chapterStore", () => ({
  ChapterStore: class {
    async load() {
      return { schemaVersion: "1", chapters: [] };
    }
  },
  ChapterStoreError: class extends Error {},
}));

import { WorkTreeProvider, type TreeNode } from "../../src/views/workTree";
import type { EpisodeFile, WorkEntry } from "../../src/models/types";
import type { WorkRegistry } from "../../src/core/workRegistry";
import { MANUSCRIPT_EDITOR_VIEW_TYPE } from "../../src/core/manuscriptViewTypes";

/** ホバーの本文。スタブの `MarkdownString` は `value` に持つ */
function tooltipText(tooltip: unknown): string {
  if (tooltip && typeof tooltip === "object" && "value" in tooltip) {
    return String((tooltip as { value: unknown }).value);
  }
  return String(tooltip ?? "");
}

const work: WorkEntry = {
  id: "work_1",
  title: "書きかけの束",
  folderPath: path.join("C:", "novels", "work"),
  registeredAt: "2026-09-04T00:00:00.000Z",
};

function episode(fileName: string, chapter: number | null): EpisodeFile {
  return {
    filePath: path.join(work.folderPath, "本文", fileName),
    fileName,
    ext: path.extname(fileName),
    chapterStart: chapter,
    chapterEnd: chapter,
    subtitle: null,
    kind: chapter === null ? "不明" : "本編",
    isInitialName: false,
    counts: { net: 12, gross: 12, lines: 1, paragraphs: 1, manuscriptLines: 1 },
    hasMetadata: false,
    metaTitle: null,
    declaredCharCount: null,
    metaUpdatedAt: null,
    hasConflictMarkers: false,
    collectedCount: null,
  };
}

function makeProvider(): WorkTreeProvider {
  const registry = {
    list: () => [work],
    onDidChange: () => ({ dispose() {} }),
  } as unknown as WorkRegistry;
  return new WorkTreeProvider(registry);
}

/** 作品ノードとその子（話）を取り出す */
async function nodesOf(): Promise<{ work: TreeNode; episodes: TreeNode[] }> {
  const provider = makeProvider();
  const roots = await provider.getChildren();
  return { work: roots[0], episodes: await provider.getChildren(roots[0]) };
}

beforeEach(() => {
  scanWork.mockReset();
  readWorkFormat.mockReset();
  scanWork.mockResolvedValue({
    episodes: [episode("海辺の会話.md", null), episode("001.txt", 1)],
    stats: {
      fileCount: 2,
      totals: { net: 24, gross: 24, lines: 2, paragraphs: 2, manuscriptLines: 2 },
      conflictedCount: 0,
    },
    manuscriptDir: "本文",
  });
  readWorkFormat.mockResolvedValue(undefined);
});

describe("contextValue にタイプを織り込む", () => {
  test("創作メモ集の作品と話", async () => {
    readWorkFormat.mockResolvedValue("memo");
    const provider = makeProvider();
    const roots = await provider.getChildren();
    const episodes = await provider.getChildren(roots[0]);

    expect(provider.getTreeItem(roots[0]).contextValue).toBe("work-memo");
    expect(provider.getTreeItem(episodes[0]).contextValue).toBe("episode-memo");
  });

  test("小説の4つの形式は、まとめて novel", async () => {
    readWorkFormat.mockResolvedValue("epic");
    const provider = makeProvider();
    const roots = await provider.getChildren();

    expect(provider.getTreeItem(roots[0]).contextValue).toBe("work-novel");
  });

  test("タイプを決めていない作品は unset（絞り込まない）", async () => {
    const provider = makeProvider();
    const roots = await provider.getChildren();
    const episodes = await provider.getChildren(roots[0]);

    expect(provider.getTreeItem(roots[0]).contextValue).toBe("work-unset");
    expect(provider.getTreeItem(episodes[0]).contextValue).toBe("episode-unset");
  });
});

describe("創作メモ集の見え方", () => {
  test("題名だけのファイルは、題名がそのまま見出しになる", async () => {
    readWorkFormat.mockResolvedValue("memo");
    const provider = makeProvider();
    const roots = await provider.getChildren();
    const episodes = await provider.getChildren(roots[0]);

    expect(provider.getTreeItem(episodes[0]).label).toBe("海辺の会話");
  });

  test("番号が無いことを、不備として知らせない", async () => {
    readWorkFormat.mockResolvedValue("memo");
    const provider = makeProvider();
    const roots = await provider.getChildren();
    const episodes = await provider.getChildren(roots[0]);
    const item = provider.getTreeItem(episodes[0]);

    expect(tooltipText(item.tooltip)).not.toContain("判定不能");
  });

  test("小説では、これまでどおりファイル名と「判定不能」を出す", async () => {
    readWorkFormat.mockResolvedValue("long");
    const provider = makeProvider();
    const roots = await provider.getChildren();
    const episodes = await provider.getChildren(roots[0]);
    const item = provider.getTreeItem(episodes[0]);

    expect(item.label).toBe("海辺の会話.md");
    expect(tooltipText(item.tooltip)).toContain("判定不能");
  });
});

describe("脚本は縦書きで開く", () => {
  test("一覧から押したとき、縦書きの入口へ渡す", async () => {
    readWorkFormat.mockResolvedValue("script");
    const provider = makeProvider();
    const roots = await provider.getChildren();
    const episodes = await provider.getChildren(roots[0]);
    const command = provider.getTreeItem(episodes[1]).command;

    expect(command?.command).toBe("vscode.openWith");
    expect(command?.arguments?.[1]).toBe(MANUSCRIPT_EDITOR_VIEW_TYPE);
  });

  test("他のタイプは、これまでどおり横書きで開く", async () => {
    const { episodes } = await nodesOf();
    const provider = makeProvider();
    const command = provider.getTreeItem(episodes[1]).command;

    expect(command?.arguments?.[1]).toBe("novelai.manuscriptEditorHorizontal");
  });
});
