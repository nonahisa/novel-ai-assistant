import { describe, expect, test, vi, beforeEach } from "vitest";

/**
 * **1件の作品が読めなくても、一覧は出す。**
 *
 * ブラウザ版で作品を5件登録したあと、作品一覧が空のまま
 * 「まだ作品が登録されていません」と出た（2026-08-22、作者の環境）。
 * 登録簿には入っていたが、`getChildren` が作品ごとの走査を
 * そのまま `await` していたため、**1件でも失敗すると一覧全体が
 * 失敗し、VS Codeは空のツリーと見なして歓迎画面を出していた。**
 *
 * 登録できていないのか、登録できたのに出せないのかが、作者からは
 * まったく区別が付かない見え方になる。
 */

vi.mock("vscode", () => ({
  TreeItem: class {
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
vi.mock("../../src/core/scanner", () => ({
  scanWork: (...args: unknown[]) => scanWork(...args),
}));

import { WorkTreeProvider, WorkNode } from "../../src/views/workTree";
import type { WorkEntry } from "../../src/models/types";
import type { WorkRegistry } from "../../src/core/workRegistry";

const works: WorkEntry[] = [
  {
    id: "a",
    title: "読めない作品",
    folderPath: "vscode-vfs://github/nonahisa/HisasNovels/壊れ",
    registeredAt: "2026-08-22T00:00:00.000Z",
  },
  {
    id: "b",
    title: "読める作品",
    folderPath: "vscode-vfs://github/nonahisa/HisasNovels/ふつう",
    registeredAt: "2026-08-22T00:00:00.000Z",
  },
];

function makeProvider(): WorkTreeProvider {
  const registry = {
    list: () => works,
    onDidChange: () => ({ dispose() {} }),
  } as unknown as WorkRegistry;
  return new WorkTreeProvider(registry);
}

beforeEach(() => {
  scanWork.mockReset();
});

describe("作品一覧の作り", () => {
  test("走査に失敗した作品があっても、登録済みの作品はすべて出す", async () => {
    scanWork.mockImplementation(async (work: WorkEntry) => {
      if (work.id === "a") throw new Error("作品設定を読み込めません: 中断されました");
      return {
        episodes: [],
        stats: { fileCount: 3, totals: { net: 100, gross: 120, manuscriptLines: 5 }, conflictedCount: 0 },
        manuscriptDir: "本文",
      };
    });

    const nodes = await makeProvider().getChildren();

    expect(nodes).toHaveLength(2);
    expect(nodes.map((n) => (n as WorkNode).work.title)).toEqual([
      "読めない作品",
      "読める作品",
    ]);
  });

  test("失敗した作品には理由を持たせる", async () => {
    scanWork.mockImplementation(async (work: WorkEntry) => {
      if (work.id === "a") throw new Error("中断されました");
      return {
        episodes: [],
        stats: { fileCount: 0, totals: { net: 0, gross: 0, manuscriptLines: 0 }, conflictedCount: 0 },
        manuscriptDir: "本文",
      };
    });

    const nodes = await makeProvider().getChildren();
    const broken = nodes[0] as WorkNode;
    const fine = nodes[1] as WorkNode;

    expect(broken.loadError).toContain("中断されました");
    expect(fine.loadError).toBeUndefined();
  });

  test("失敗した作品を開くと、理由を出す（本文が無いとは言わない）", async () => {
    scanWork.mockRejectedValue(new Error("読み込めませんでした"));
    const provider = makeProvider();
    const nodes = await provider.getChildren();
    const children = await provider.getChildren(nodes[0]);

    expect(children).toHaveLength(1);
    const message = children[0];
    if (message.type !== "message") throw new Error("案内が出るはず");
    expect(message.text).toContain("読み込めませんでした");
    expect(message.text).not.toContain("本文ファイルがありません");
  });

  test("すべて読めれば、これまでどおり字数が入る", async () => {
    scanWork.mockResolvedValue({
      episodes: [],
      stats: { fileCount: 19, totals: { net: 41000, gross: 42000, manuscriptLines: 1000 }, conflictedCount: 0 },
      manuscriptDir: "本文",
    });

    const nodes = await makeProvider().getChildren();
    expect(nodes.every((n) => (n as WorkNode).loadError === undefined)).toBe(true);
    expect((nodes[0] as WorkNode).stats.fileCount).toBe(19);
  });
});
