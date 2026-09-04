import * as path from "path";
import { beforeEach, describe, expect, test, vi } from "vitest";

/**
 * 作品一覧の「メモ」の枝（設計書6.71）。
 *
 * **メモのある作品にだけ出す。** 無い作品の画面を汚さないためで、
 * 章の枝（6.66.3）と同じ考え方である。話の並びの後ろに置く——
 * メモは原稿ではないので、原稿より前に来てはいけない。
 */

const scanWork = vi.fn();
vi.mock("../../src/core/scanner", () => ({
  scanWork: (...args: unknown[]) => scanWork(...args),
}));

const listWorkMemos = vi.fn();
vi.mock("../../src/core/workMemos", () => ({
  listWorkMemos: (...args: unknown[]) => listWorkMemos(...args),
}));

// 章・あらすじ・形式は、この試験の対象ではない
vi.mock("../../src/core/chapterStore", () => ({
  ChapterStore: class {
    async load() {
      return { schemaVersion: "1", chapters: [] };
    }
  },
  ChapterStoreError: class extends Error {},
}));
vi.mock("../../src/core/synopsisStore", () => ({
  SynopsisStore: class {
    async load() {
      return { episodes: [] };
    }
  },
}));
const workFormat = vi.fn();
vi.mock("../../src/core/workFormatStore", () => ({
  readWorkFormat: (...args: unknown[]) => workFormat(...args),
}));

import {
  MemoFileNode,
  MemoFolderNode,
  WorkTreeProvider,
} from "../../src/views/workTree";
import type { EpisodeFile, WorkEntry } from "../../src/models/types";
import type { WorkRegistry } from "../../src/core/workRegistry";

const work: WorkEntry = {
  id: "work_1",
  title: "氷の街",
  folderPath: path.join("C:", "novels", "work"),
  registeredAt: "2026-09-04T00:00:00.000Z",
};

function episode(n: number): EpisodeFile {
  const fileName = `${String(n).padStart(3, "0")}.txt`;
  return {
    filePath: path.join(work.folderPath, "本文", fileName),
    fileName,
    ext: ".txt",
    chapterStart: n,
    chapterEnd: n,
    subtitle: null,
    kind: "本編",
    isInitialName: false,
    counts: { net: 0, gross: 0, lines: 0, paragraphs: 0, manuscriptLines: 0 },
    hasMetadata: false,
    metaTitle: null,
    declaredCharCount: null,
    metaUpdatedAt: null,
    hasConflictMarkers: false,
    collectedCount: null,
  };
}

function memo(title: string) {
  return {
    title,
    fileName: `${title}.md`,
    filePath: path.join(work.folderPath, "設定", "メモ", `${title}.md`),
  };
}

function makeProvider(): WorkTreeProvider {
  const registry = {
    list: () => [work],
    onDidChange: () => ({ dispose() {} }),
  } as unknown as WorkRegistry;
  return new WorkTreeProvider(registry);
}

beforeEach(() => {
  scanWork.mockReset();
  listWorkMemos.mockReset();
  workFormat.mockReset();
  scanWork.mockResolvedValue({
    episodes: [1, 2].map(episode),
    stats: {
      fileCount: 2,
      totals: { net: 0, gross: 0, lines: 0, paragraphs: 0, manuscriptLines: 0 },
      conflictedCount: 0,
    },
    manuscriptDir: "本文",
  });
  listWorkMemos.mockResolvedValue([]);
  workFormat.mockResolvedValue("long");
});

describe("メモの枝", () => {
  test("メモが1つも無ければ、枝は出ない", async () => {
    const provider = makeProvider();
    const works = await provider.getChildren();
    const children = await provider.getChildren(works[0]);

    expect(children.every((node) => node.type === "episode")).toBe(true);
  });

  test("メモがあれば、話の後ろに折りたたみの枝が出る", async () => {
    listWorkMemos.mockResolvedValue([memo("書き出しの案"), memo("設定の覚え")]);

    const provider = makeProvider();
    const works = await provider.getChildren();
    const children = await provider.getChildren(works[0]);

    expect(children.map((node) => node.type)).toEqual([
      "episode",
      "episode",
      "memoFolder",
    ]);
    const item = provider.getTreeItem(children[2]);
    expect(item.label).toBe("メモ（2件）");
  });

  test("枝の中に題名が並び、クリックで開ける", async () => {
    listWorkMemos.mockResolvedValue([memo("書き出しの案")]);

    const provider = makeProvider();
    const works = await provider.getChildren();
    const folder = (await provider.getChildren(works[0])).find(
      (node): node is MemoFolderNode => node.type === "memoFolder"
    );
    const inside = await provider.getChildren(folder!);

    expect(inside).toHaveLength(1);
    const item = provider.getTreeItem(inside[0]);
    expect(item.label).toBe("書き出しの案");
    expect((inside[0] as MemoFileNode).memo.fileName).toBe("書き出しの案.md");
    expect(item.command).toMatchObject({ command: "vscode.open" });
  });

  test("contextValue にタイプの列が入る（右クリックの絞り込み）", async () => {
    listWorkMemos.mockResolvedValue([memo("書き出しの案")]);

    const provider = makeProvider();
    const works = await provider.getChildren();
    const folder = (await provider.getChildren(works[0])).find(
      (node): node is MemoFolderNode => node.type === "memoFolder"
    );
    const inside = await provider.getChildren(folder!);

    expect(provider.getTreeItem(folder!).contextValue).toBe("memoFolder-novel");
    expect(provider.getTreeItem(inside[0]).contextValue).toBe("memoFile-novel");
  });

  test("本文が1つも無い作品でも、メモがあれば出す", async () => {
    scanWork.mockResolvedValue({
      episodes: [],
      stats: {
        fileCount: 0,
        totals: { net: 0, gross: 0, lines: 0, paragraphs: 0, manuscriptLines: 0 },
        conflictedCount: 0,
      },
      manuscriptDir: "本文",
    });
    listWorkMemos.mockResolvedValue([memo("最初の思いつき")]);

    const provider = makeProvider();
    const works = await provider.getChildren();
    const children = await provider.getChildren(works[0]);

    expect(children.map((node) => node.type)).toEqual([
      "message",
      "memoFolder",
    ]);
  });

  test("メモを読めなくても、話は出す（枝が出ないだけ）", async () => {
    listWorkMemos.mockRejectedValue(new Error("読めません"));

    const provider = makeProvider();
    const works = await provider.getChildren();
    const children = await provider.getChildren(works[0]);

    expect(children.map((node) => node.type)).toEqual(["episode", "episode"]);
  });
});
