import * as path from "path";
import { beforeEach, describe, expect, test, vi } from "vitest";

/**
 * 作品一覧の「ほかの機械の作品」（設計書5.5.11.1）。
 *
 * - この機械に無い作品があるときだけ、作品の行の後ろに見出しが1つ出る
 * - 行は作品名だけ（説明の副ラベルは置かない。設計書6.82.1）。中身は無い
 * - 作品が0件の機械でも、登録の案内を上に残す
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

import {
  WorkTreeProvider,
  type OtherMachineWorksSource,
  type TreeNode,
} from "../../../src/views/workTree";
import { emptyPostingLedger } from "../../../src/models/posting";
import type { SyncedWork } from "../../../src/core/syncedWorkList";
import type { WorkEntry } from "../../../src/models/types";
import type { WorkRegistry } from "../../../src/core/workRegistry";
import { EventEmitter } from "vscode";

const work: WorkEntry = {
  id: "work_1",
  title: "登録した作品",
  folderPath: path.join("C:", "novels", "work"),
  registeredAt: "2026-09-04T00:00:00.000Z",
};

const betsu: SyncedWork = {
  title: "別の機械の作品",
  remoteUrl: "https://github.com/nonahisa/betsu",
  addedAt: "2026-11-02T00:00:00.000Z",
};

function source(list: () => SyncedWork[]): OtherMachineWorksSource & { emitter: EventEmitter<void> } {
  const emitter = new EventEmitter<void>();
  return { list, onDidChange: emitter.event, emitter };
}

async function root(
  works: WorkEntry[],
  others: OtherMachineWorksSource | undefined
): Promise<{ provider: WorkTreeProvider; nodes: TreeNode[] }> {
  const registry = {
    list: () => works,
    onDidChange: () => ({ dispose() {} }),
  } as unknown as WorkRegistry;
  const provider = new WorkTreeProvider(registry);
  if (others) provider.setOtherMachineWorksSource(others);
  return { provider, nodes: await provider.getChildren() };
}

beforeEach(() => {
  scanWork.mockReset();
  loadPosting.mockReset();
  scanWork.mockResolvedValue({
    episodes: [],
    stats: {
      fileCount: 1,
      totals: { net: 0, gross: 0, lines: 0, paragraphs: 0, manuscriptLines: 0 },
      conflictedCount: 0,
    },
    manuscriptDir: "本文",
  });
  loadPosting.mockResolvedValue(emptyPostingLedger());
});

describe("ほかの機械の作品", () => {
  test("作品の行の後ろに見出しが付き、その下に作品名だけの行が並ぶ", async () => {
    const { provider, nodes } = await root([work], source(() => [betsu]));
    expect(nodes.map((node) => node.type)).toEqual(["work", "otherMachineWorksHeader"]);
    const header = provider.getTreeItem(nodes[1]);
    expect(header.label).toBe("ほかの機械の作品");
    expect(header.description).toBeUndefined();

    const children = await provider.getChildren(nodes[1]);
    const item = provider.getTreeItem(children[0]);
    expect(item.label).toBe("別の機械の作品");
    expect(item.contextValue).toBe("otherMachineWork");
    expect(item.description).toBeUndefined();
    expect(item.collapsibleState).toBe(0);
    expect(await provider.getChildren(children[0])).toEqual([]);
  });

  test("この機械に無い作品が無ければ、見出しも出さない", async () => {
    expect((await root([work], source(() => []))).nodes.map((node) => node.type)).toEqual(["work"]);
    expect((await root([work], undefined)).nodes.map((node) => node.type)).toEqual(["work"]);
  });

  test("作品が0件の機械でも、登録の案内と入口を上に残す", async () => {
    const { provider, nodes } = await root([], source(() => [betsu]));
    expect(provider.getTreeItem(nodes[0]).label).toBe("まだ作品が登録されていません。");
    expect(nodes.at(-1)?.type).toBe("otherMachineWorksHeader");
  });

  test("取り寄せて行が無くなったら、一覧を描き直して見出しを消す", async () => {
    let rows = [betsu];
    const others = source(() => rows);
    const { provider } = await root([work], others);
    const fired: unknown[] = [];
    provider.onDidChangeTreeData((value) => fired.push(value));
    rows = [];
    others.emitter.fire();
    // 見出しごと消えるので、丸ごと描き直す（undefined）
    expect(fired).toEqual([undefined]);
    expect((await provider.getChildren()).map((node) => node.type)).toEqual(["work"]);
  });
});
