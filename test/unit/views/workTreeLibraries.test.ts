import { beforeEach, describe, expect, test, vi } from "vitest";

/**
 * 作品一覧を書庫ごとに分けて出す（設計書6.97.7）。
 * 書庫の段は書庫が2つ以上あるときだけ。控えから先に出す回も同じ分け方になる。
 */

/** `.git` が在るフォルダー（スラッシュ区切りの末尾）。stat が成功する道 */
let gitPaths: string[] = [];

vi.mock("vscode", () => ({
  TreeItem: class {
    description?: string;
    tooltip?: unknown;
    id?: string;
    contextValue?: string;
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
  Uri: { file: (p: string) => ({ fsPath: p, path: p, toString: () => p }) },
  workspace: {
    getConfiguration: () => ({ get: (_key: string, fallback?: unknown) => fallback }),
    fs: {
      stat: async (uri: { fsPath: string }) => {
        const target = uri.fsPath.replace(/\\/g, "/").toLowerCase();
        if (gitPaths.some((p) => target === p.toLowerCase())) return {};
        throw new Error("無い");
      },
    },
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

import {
  WorkTreeProvider,
  WorkNode,
  LibraryNode,
  type TreeNode,
} from "../../../src/views/workTree";
import {
  WORK_LIST_SNAPSHOT_KEY,
  buildWorkListSnapshot,
} from "../../../src/core/workListSnapshot";
import type { WorkEntry } from "../../../src/models/types";
import type { WorkRegistry } from "../../../src/core/workRegistry";

function work(id: string, folderPath: string): WorkEntry {
  return { id, title: id, folderPath, registeredAt: "2026-10-19T00:00:00.000Z" };
}

const WORKS = [
  work("solo", "C:/solo/S"),
  work("b1", "C:/lib/B/b1"),
  work("a1", "C:/lib/A/a1"),
  work("a2", "C:/lib/A/a2"),
  work("b2", "C:/lib/B/b2"),
];

function makeProvider(works: WorkEntry[], withSnapshot = false) {
  const registry = {
    list: () => works,
    onDidChange: () => ({ dispose() {} }),
  } as unknown as WorkRegistry;
  const data = new Map<string, unknown>();
  if (withSnapshot) {
    data.set(
      WORK_LIST_SNAPSHOT_KEY,
      buildWorkListSnapshot(
        works.map((w) => ({
          id: w.id,
          folderPath: w.folderPath,
          fileCount: 1,
          totals: { gross: 10, net: 9, lines: 1, paragraphs: 1, manuscriptLines: 1 },
          conflictedCount: 0,
        })),
        "t"
      )
    );
  }
  const store = {
    get: (key: string) => data.get(key),
    update: async (key: string, value: unknown) => void data.set(key, value),
  };
  return new WorkTreeProvider(registry, undefined, undefined, undefined, undefined, {
    snapshot: withSnapshot ? store : undefined,
  });
}

function describeTop(nodes: TreeNode[]): string[] {
  return nodes.map((n) =>
    n instanceof LibraryNode
      ? `[${n.library.name}] ${n.works.map((w) => w.work.id).join(",")}`
      : (n as WorkNode).work.id
  );
}

beforeEach(() => {
  gitPaths = [];
  scanWork.mockReset();
  scanWork.mockImplementation(async () => ({
    episodes: [],
    stats: {
      fileCount: 1,
      totals: { gross: 10, net: 9, lines: 1, paragraphs: 1, manuscriptLines: 1 },
      conflictedCount: 0,
    },
    manuscriptDir: "本文",
    timing: {
      files: 1, prepMs: 1, readMs: 1, countMs: 1, parseMs: 1, otherMs: 1,
      totalMs: 5, slowestFile: "001.txt", slowestMs: 1,
    },
  }));
});

describe("書庫の段", () => {
  test("書庫が2つあれば、書庫の段が名前順に並び、単独の作品はその後ろに並ぶ", async () => {
    const provider = makeProvider(WORKS);
    const top = await provider.getChildren();
    expect(describeTop(top)).toEqual(["[A] a1,a2", "[B] b1,b2", "solo"]);

    const item = provider.getTreeItem(top[0]);
    expect(item.contextValue).toBe("library");
    expect(item.collapsibleState).toBe(2);
    expect(String((item.tooltip as { value: string }).value)).toContain("2作品");
    // 段の子は作品の行そのもの
    const children = await provider.getChildren(top[0]);
    expect(children.every((c) => c.type === "work")).toBe(true);
  });

  test("書庫が1つなら段を出さず、いまと同じ並び", async () => {
    const provider = makeProvider([WORKS[0], WORKS[2], WORKS[3]]);
    const top = await provider.getChildren();
    expect(describeTop(top)).toEqual(["solo", "a1", "a2"]);
  });

  test("控えから先に出す回も、同じ分け方になる", async () => {
    const provider = makeProvider(WORKS, true);
    const top = await provider.getChildren();
    expect(describeTop(top)).toEqual(["[A] a1,a2", "[B] b1,b2", "solo"]);
    const inside = (top[0] as LibraryNode).works[0];
    expect(inside.snapshot).toBe("stale");
  });

  test("作品フォルダー自身に .git が在る作品は単独に並ぶ", async () => {
    gitPaths = ["C:/lib/A/a1/.git", "C:/lib/B/.git"];
    const provider = makeProvider(WORKS);
    const top = await provider.getChildren();
    // A は a2 だけが残り、.git も無いので書庫でない。B だけが書庫＝書庫は1つなので段は出ない
    expect(describeTop(top)).toEqual(["solo", "b1", "a1", "a2", "b2"]);
  });

  test("書庫の中の作品の行も、1作品だけ読み直す相手として覚えている", async () => {
    const provider = makeProvider(WORKS);
    await provider.getChildren();
    provider.refresh("a2");
    await provider.settled();
    // 段の外へ追い出されず、同じ段の中に残る
    const top = await provider.getChildren();
    expect(describeTop(top)[0]).toBe("[A] a1,a2");
  });
});
