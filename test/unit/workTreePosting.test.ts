import * as path from "path";
import { beforeEach, describe, expect, test, vi } from "vitest";

/**
 * 作品一覧の「未投稿のサイト数」の印（設計書6.68.2）。
 *
 * **対象サイトを1つも登録していない作品では、何も出さない。**
 * 投稿キットを使わない作者の画面に、全話ぶんの「未投稿」が並んでも
 * 邪魔になるだけである（無いものの印は出さない、という一覧の流儀）。
 */

const scanWork = vi.fn();
vi.mock("../../src/core/scanner", () => ({
  scanWork: (...args: unknown[]) => scanWork(...args),
}));

// 章は、この試験の対象ではない（章が無ければ作品の直下に話が並ぶ）
vi.mock("../../src/core/chapterStore", () => ({
  ChapterStore: class {
    async load() {
      return { schemaVersion: "1", chapters: [] };
    }
  },
  ChapterStoreError: class extends Error {},
}));

const loadPosting = vi.fn();
vi.mock("../../src/core/postingStore", () => ({
  PostingStore: class {
    load() {
      return loadPosting();
    }
  },
  PostingStoreError: class extends Error {},
}));

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

import { WorkTreeProvider } from "../../src/views/workTree";
import { emptyPostingLedger, withPost, withSites } from "../../src/models/posting";
import type { EpisodeFile, WorkEntry } from "../../src/models/types";
import type { WorkRegistry } from "../../src/core/workRegistry";

const work: WorkEntry = {
  id: "work_1",
  title: "氷の街",
  folderPath: path.join("C:", "novels", "work"),
  registeredAt: "2026-09-04T00:00:00.000Z",
};

const registered = withSites(emptyPostingLedger(), [
  {
    site: "narou",
    newEpisodeUrl: "https://syosetu.com/usernovelmanage/top/ncode/n1234ab/",
  },
  {
    site: "kakuyomu",
    newEpisodeUrl: "https://kakuyomu.jp/my/works/1177354054892/episodes/new",
  },
]);

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

/** 第1話の行を描く */
async function firstEpisodeItem(): Promise<{
  description: string;
  tooltip: string;
}> {
  const provider = makeProvider();
  const works = await provider.getChildren();
  const children = await provider.getChildren(works[0]);
  const item = provider.getTreeItem(children[0]);
  return {
    description: String(item.description ?? ""),
    tooltip:
      typeof item.tooltip === "object" && item.tooltip !== null
        ? String((item.tooltip as { value?: string }).value ?? "")
        : String(item.tooltip ?? ""),
  };
}

beforeEach(() => {
  scanWork.mockReset();
  loadPosting.mockReset();
  scanWork.mockResolvedValue({
    episodes: [1, 2].map(episode),
    stats: {
      fileCount: 2,
      totals: { net: 0, gross: 0, lines: 0, paragraphs: 0, manuscriptLines: 0 },
      conflictedCount: 0,
    },
    manuscriptDir: "本文",
  });
  loadPosting.mockResolvedValue(emptyPostingLedger());
});

describe("未投稿のサイト数の印", () => {
  test("対象サイトを登録していない作品には、何も出さない", async () => {
    const item = await firstEpisodeItem();

    expect(item.description).not.toContain("未投稿");
    expect(item.tooltip).not.toContain("未投稿");
  });

  test("登録したサイトのうち、まだ出していない数を出す", async () => {
    loadPosting.mockResolvedValue(registered);

    const item = await firstEpisodeItem();

    expect(item.description).toContain("未投稿2");
  });

  /** **どのサイトが遅れているかはツールチップで読む**（印は短くしか書けない） */
  test("遅れているサイトの名前は、ホバーで読める", async () => {
    loadPosting.mockResolvedValue(
      withPost(registered, "本文/001.txt", "narou", "2026-09-04T00:00:00.000Z")
    );

    const item = await firstEpisodeItem();

    expect(item.description).toContain("未投稿1");
    expect(item.tooltip).toContain("カクヨム");
    expect(item.tooltip).not.toContain("小説家になろう");
  });

  test("全部のサイトへ出した話には、印を出さない", async () => {
    let ledger = registered;
    for (const site of ["narou", "kakuyomu"] as const) {
      ledger = withPost(ledger, "本文/001.txt", site, "2026-09-04T00:00:00.000Z");
    }
    loadPosting.mockResolvedValue(ledger);

    const item = await firstEpisodeItem();

    expect(item.description).not.toContain("未投稿");
  });

  test("台帳が壊れていても、一覧は出す（印が出ないだけ）", async () => {
    loadPosting.mockRejectedValue(new Error("投稿状態.json を読めませんでした"));

    const provider = makeProvider();
    const works = await provider.getChildren();
    const children = await provider.getChildren(works[0]);

    expect(children).toHaveLength(2);
    expect(children.every((node) => node.type === "episode")).toBe(true);
    expect(String(provider.getTreeItem(children[0]).description)).not.toContain(
      "未投稿"
    );
  });
});
