import * as path from "path";
import { beforeEach, describe, expect, test, vi } from "vitest";

/**
 * 作品一覧の章の階層（設計書6.66.3）。
 *
 * 章のある作品：作品 → **章ノード（折りたたみ可）** → 話。
 * 章のない作品は、いままでどおり 作品 → 話 のまま。
 *
 * **章ノードのIDには名前を入れない。** 折りたたみの開閉はVS Codeが
 * IDで覚えているので、名前から作ると改名のたびに開閉が失われる。
 */

const scanWork = vi.fn();
vi.mock("../../src/core/scanner", () => ({
  scanWork: (...args: unknown[]) => scanWork(...args),
}));

const loadChapters = vi.fn();
vi.mock("../../src/core/chapterStore", () => ({
  ChapterStore: class {
    load() {
      return loadChapters();
    }
  },
  ChapterStoreError: class extends Error {},
}));

// あらすじと形式は、この試験の対象ではない（読めなくても一覧は出る）
vi.mock("../../src/core/synopsisStore", () => ({
  SynopsisStore: class {
    async load() {
      return { episodes: [] };
    }
  },
}));
vi.mock("../../src/core/workFormatStore", () => ({
  readWorkFormat: async () => undefined,
}));

import {
  ChapterNode,
  EpisodeNode,
  WorkTreeProvider,
} from "../../src/views/workTree";
import type { EpisodeFile, WorkEntry } from "../../src/models/types";
import type { WorkRegistry } from "../../src/core/workRegistry";

const work: WorkEntry = {
  id: "work_1",
  title: "氷の街",
  folderPath: path.join("C:", "novels", "work"),
  registeredAt: "2026-09-03T00:00:00.000Z",
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

function makeProvider(): WorkTreeProvider {
  const registry = {
    list: () => [work],
    onDidChange: () => ({ dispose() {} }),
  } as unknown as WorkRegistry;
  return new WorkTreeProvider(registry);
}

beforeEach(() => {
  scanWork.mockReset();
  loadChapters.mockReset();
  scanWork.mockResolvedValue({
    episodes: [1, 2, 3, 4, 5].map(episode),
    stats: {
      fileCount: 5,
      totals: { net: 0, gross: 0, lines: 0, paragraphs: 0, manuscriptLines: 0 },
      conflictedCount: 0,
    },
    manuscriptDir: "本文",
  });
  loadChapters.mockResolvedValue({ schemaVersion: "1", chapters: [] });
});

describe("章のある作品の一覧", () => {
  test("章が無ければ、作品の下は話のまま（2階層）", async () => {
    const provider = makeProvider();
    const works = await provider.getChildren();
    const children = await provider.getChildren(works[0]);

    expect(children).toHaveLength(5);
    expect(children.every((node) => node.type === "episode")).toBe(true);
  });

  test("章があれば、作品 → 章 → 話 の3階層になる", async () => {
    loadChapters.mockResolvedValue({
      schemaVersion: "1",
      chapters: [
        { name: "第一章", startEpisodePath: "本文/001.txt" },
        { name: "第二章", startEpisodePath: "本文/004.txt" },
      ],
    });

    const provider = makeProvider();
    const works = await provider.getChildren();
    const children = await provider.getChildren(works[0]);

    expect(children.map((node) => node.type)).toEqual(["chapter", "chapter"]);
    const first = children[0] as ChapterNode;
    const inside = await provider.getChildren(first);
    expect(inside).toHaveLength(3);
    expect((inside[0] as EpisodeNode).episode.fileName).toBe("001.txt");
  });

  test("最初の章より前の話は、章ノードより前に作品の直下へ並ぶ", async () => {
    loadChapters.mockResolvedValue({
      schemaVersion: "1",
      chapters: [{ name: "第一章", startEpisodePath: "本文/003.txt" }],
    });

    const provider = makeProvider();
    const works = await provider.getChildren();
    const children = await provider.getChildren(works[0]);

    expect(children.map((node) => node.type)).toEqual([
      "episode",
      "episode",
      "chapter",
    ]);
  });

  test("章ノードのIDに名前が入っていない（改名しても変わらない）", async () => {
    loadChapters.mockResolvedValue({
      schemaVersion: "1",
      chapters: [{ name: "第一章　出立", startEpisodePath: "本文/001.txt" }],
    });
    const provider = makeProvider();
    const works = await provider.getChildren();
    const before = provider.getTreeItem(
      (await provider.getChildren(works[0]))[0]
    );

    loadChapters.mockResolvedValue({
      schemaVersion: "1",
      chapters: [{ name: "第一章　旅立ち", startEpisodePath: "本文/001.txt" }],
    });
    const renamed = makeProvider();
    const worksAgain = await renamed.getChildren();
    const after = renamed.getTreeItem(
      (await renamed.getChildren(worksAgain[0]))[0]
    );

    expect(before.id).toBe(after.id);
    expect(before.id).not.toContain("出立");
    expect(before.label).toBe("第一章　出立");
    expect(after.label).toBe("第一章　旅立ち");
  });

  test("章ノードには話数の範囲と件数を添える", async () => {
    loadChapters.mockResolvedValue({
      schemaVersion: "1",
      chapters: [{ name: "第一章", startEpisodePath: "本文/001.txt" }],
    });
    const provider = makeProvider();
    const works = await provider.getChildren();
    const item = provider.getTreeItem((await provider.getChildren(works[0]))[0]);

    expect(item.description).toBe("第1話〜第5話・5話");
  });

  test("開始の話が見つからない章は、そう書いて出す（黙って消さない）", async () => {
    loadChapters.mockResolvedValue({
      schemaVersion: "1",
      chapters: [
        { name: "第一章", startEpisodePath: "本文/001.txt" },
        { name: "幻の章", startEpisodePath: "本文/999.txt" },
      ],
    });
    const provider = makeProvider();
    const works = await provider.getChildren();
    const children = await provider.getChildren(works[0]);
    const item = provider.getTreeItem(children[1]);

    expect(item.label).toBe("幻の章（開始の話が見つかりません）");
  });

  test("台帳が壊れていても、話は出す（理由を添える）", async () => {
    loadChapters.mockRejectedValue(new Error("章立て.json を読めませんでした"));

    const provider = makeProvider();
    const works = await provider.getChildren();
    const children = await provider.getChildren(works[0]);

    expect(children[0].type).toBe("message");
    expect(children.filter((node) => node.type === "episode")).toHaveLength(5);
  });
});
