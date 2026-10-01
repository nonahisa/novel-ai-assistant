import { describe, expect, test, vi, beforeEach } from "vitest";

/**
 * **前回の一覧を先に出し、裏で読み直して差し替える**（引継ぎ書
 * 「ノートPCの作品一覧が遅い件」、設計書6.107）。
 *
 * 作品一覧は全作品（19作品・約590ファイル）を読み終えるまで1行も出ず、
 * ノートPCでは14〜105秒かかっていた。控えがあれば開いた瞬間にそれを出し、
 * 走査が終わったら差し替える。**控えの数字を最新だと思わせない**
 * （行に「前回の値」と出す）。
 */

const fired: number[] = [];

vi.mock("vscode", () => ({
  TreeItem: class {
    description?: string;
    tooltip?: unknown;
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
    fire() {
      fired.push(Date.now());
    }
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

import { WorkTreeProvider, WorkNode, type TreeNode } from "../../../src/views/workTree";
import {
  WORK_LIST_SNAPSHOT_KEY,
  buildWorkListSnapshot,
  parseWorkListSnapshot,
  type WorkListSnapshotEntry,
} from "../../../src/core/workListSnapshot";
import type { WorkEntry } from "../../../src/models/types";
import type { WorkRegistry } from "../../../src/core/workRegistry";

function manyWorks(count: number): WorkEntry[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `w${index}`,
    title: `作品${index}`,
    folderPath: `C:/novels/w${index}`,
    registeredAt: "2026-10-01T00:00:00.000Z",
  }));
}

function entryFor(work: WorkEntry, fileCount: number, net = 100): WorkListSnapshotEntry {
  return {
    id: work.id,
    folderPath: work.folderPath,
    fileCount,
    totals: { gross: net + 10, net, lines: 5, paragraphs: 2, manuscriptLines: 3 },
    conflictedCount: 0,
  };
}

/** 記憶の中の保管庫。書いた値を控えておく */
function memoryStore(initial?: unknown) {
  const data = new Map<string, unknown>();
  if (initial !== undefined) data.set(WORK_LIST_SNAPSHOT_KEY, initial);
  const writes: unknown[] = [];
  return {
    data,
    writes,
    get: (key: string) => data.get(key),
    update: async (key: string, value: unknown) => {
      data.set(key, value);
      writes.push(value);
    },
  };
}

/** 好きなときに終わらせられる走査。fileCount は作品番号×10 */
function gatedScan() {
  const release: Array<() => void> = [];
  scanWork.mockImplementation(
    (work: WorkEntry) =>
      new Promise((resolve, reject) => {
        release.push(() => {
          if (work.id === "broken") {
            reject(new Error("読めません"));
            return;
          }
          resolve({
            episodes: [],
            stats: {
              fileCount: Number(work.id.slice(1)) * 10 + 1,
              totals: { gross: 999, net: 900, lines: 1, paragraphs: 1, manuscriptLines: 1 },
              conflictedCount: 0,
            },
            manuscriptDir: "本文",
            // 初回描画の合図は計測のまとめを渡すので、計測も付ける
            timing: {
              files: 1,
              prepMs: 1,
              readMs: 1,
              countMs: 1,
              parseMs: 1,
              otherMs: 1,
              totalMs: 5,
              slowestFile: "001.txt",
              slowestMs: 1,
            },
          });
        });
      })
  );
  return {
    started: () => release.length,
    releaseAll: async () => {
      // 4並列なので、終わらせるたびに次が入ってくる。何周か回す
      for (let i = 0; i < 20; i += 1) {
        while (release.length > 0) release.shift()?.();
        await new Promise((r) => setTimeout(r, 0));
      }
    },
  };
}

function makeProvider(
  works: WorkEntry[],
  store: ReturnType<typeof memoryStore> | undefined,
  hooks: {
    onFirstRender?: () => void;
    onSnapshotRender?: (shown: number, total: number) => void;
    onLoadingChanged?: (loading: boolean, count: number) => void;
  } = {}
) {
  const registry = {
    list: () => works,
    onDidChange: () => ({ dispose() {} }),
  } as unknown as WorkRegistry;
  return new WorkTreeProvider(
    registry,
    undefined,
    undefined,
    hooks.onFirstRender,
    hooks.onLoadingChanged,
    { snapshot: store, onSnapshotRender: hooks.onSnapshotRender }
  );
}

function description(provider: WorkTreeProvider, node: TreeNode): string {
  return String(provider.getTreeItem(node).description ?? "");
}

beforeEach(() => {
  scanWork.mockReset();
  fired.length = 0;
});

describe("控えがあれば、走査より先に行が出る", () => {
  test("走査が終わる前に、控えの行が返る", async () => {
    const works = manyWorks(3);
    const gate = gatedScan();
    const store = memoryStore(
      buildWorkListSnapshot(works.map((w, i) => entryFor(w, i + 5)), "t")
    );
    const provider = makeProvider(works, store);

    const nodes = await provider.getChildren();

    expect(nodes).toHaveLength(3);
    expect(nodes.map((n) => (n as WorkNode).work.id)).toEqual(["w0", "w1", "w2"]);
    expect((nodes[1] as WorkNode).stats.fileCount).toBe(6);
    expect((nodes[1] as WorkNode).snapshot).toBe("stale");
    // 走査は裏で始まっている
    expect(gate.started()).toBeGreaterThan(0);
    await gate.releaseAll();
  });

  test("控えの行には「前回の値」と出す（最新だと思わせない）", async () => {
    const works = manyWorks(1);
    const gate = gatedScan();
    const store = memoryStore(buildWorkListSnapshot([entryFor(works[0], 7)], "t"));
    const provider = makeProvider(works, store);

    const nodes = await provider.getChildren();
    const text = description(provider, nodes[0]);

    expect(text).toContain("前回の値");
    expect(text).toContain("7ファイル");
    await gate.releaseAll();
  });

  test("控えで描いたことを知らせる。初回描画（走査）の合図はまだ来ない", async () => {
    const works = manyWorks(2);
    const gate = gatedScan();
    const store = memoryStore(buildWorkListSnapshot(works.map((w) => entryFor(w, 1)), "t"));
    const onFirstRender = vi.fn();
    const onSnapshotRender = vi.fn();
    const provider = makeProvider(works, store, { onFirstRender, onSnapshotRender });

    await provider.getChildren();

    expect(onSnapshotRender).toHaveBeenCalledTimes(1);
    expect(onSnapshotRender).toHaveBeenCalledWith(2, 2);
    expect(onFirstRender).not.toHaveBeenCalled();
    await gate.releaseAll();
    // 走査が終わった時点で初回描画の合図（整備の合図もここから起きる）
    expect(onFirstRender).toHaveBeenCalledTimes(1);
  });
});

describe("走査の結果で差し替わる", () => {
  test("走査が終わると描き直しを求め、次は走査の値を返す", async () => {
    const works = manyWorks(2);
    const gate = gatedScan();
    const store = memoryStore(buildWorkListSnapshot(works.map((w) => entryFor(w, 5)), "t"));
    const provider = makeProvider(works, store);

    await provider.getChildren();
    expect(fired).toHaveLength(0);
    await gate.releaseAll();
    expect(fired.length).toBeGreaterThan(0);

    const fresh = await provider.getChildren();
    expect((fresh[1] as WorkNode).stats.fileCount).toBe(11);
    expect((fresh[1] as WorkNode).snapshot).toBeUndefined();
    expect(description(provider, fresh[1])).not.toContain("前回の値");
    // 差し替えのために作品を読み直さない（裏の走査の結果をそのまま使う）
    expect(scanWork).toHaveBeenCalledTimes(2);
  });

  test("走査が終わったら控えを書き直す（読めなかった作品は控えない）", async () => {
    const works = [...manyWorks(2), { ...manyWorks(1)[0], id: "broken", folderPath: "C:/x" }];
    const gate = gatedScan();
    const store = memoryStore();
    const provider = makeProvider(works, store);

    const pending = provider.getChildren();
    await gate.releaseAll();
    await pending;

    const saved = parseWorkListSnapshot(store.data.get(WORK_LIST_SNAPSHOT_KEY));
    expect([...saved.keys()]).toEqual(["w0", "w1"]);
    expect(saved.get("w1")?.fileCount).toBe(11);
  });

  test("値が変わらなければ書き直さない", async () => {
    const works = manyWorks(1);
    scanWork.mockResolvedValue({
      episodes: [],
      stats: { fileCount: 3, totals: { gross: 1, net: 1, lines: 1, paragraphs: 1, manuscriptLines: 1 }, conflictedCount: 0 },
      manuscriptDir: "本文",
    });
    const store = memoryStore();
    const provider = makeProvider(works, store);

    await provider.getChildren();
    await provider.getChildren();
    provider.redraw();
    await provider.getChildren();

    expect(store.writes).toHaveLength(1);
  });

  test("走査中も「読み込み中」の合図を立て、終われば下ろす", async () => {
    const works = manyWorks(2);
    const gate = gatedScan();
    const store = memoryStore(buildWorkListSnapshot(works.map((w) => entryFor(w, 1)), "t"));
    const calls: boolean[] = [];
    const provider = makeProvider(works, store, {
      onLoadingChanged: (loading) => calls.push(loading),
    });

    await provider.getChildren();
    expect(calls).toEqual([true]);
    await gate.releaseAll();
    expect(calls).toEqual([true, false]);
  });
});

describe("控えと登録簿が食い違うとき", () => {
  test("控えに無い作品は「読み込み中」の行で出す", async () => {
    const works = manyWorks(2);
    const gate = gatedScan();
    const store = memoryStore(buildWorkListSnapshot([entryFor(works[0], 4)], "t"));
    const provider = makeProvider(works, store);

    const nodes = await provider.getChildren();

    expect(nodes).toHaveLength(2);
    expect((nodes[1] as WorkNode).snapshot).toBe("pending");
    expect(description(provider, nodes[1])).toContain("読み込み中");
    await gate.releaseAll();
  });

  test("解除された作品（控えにだけある）は出さない", async () => {
    const works = manyWorks(1);
    const gate = gatedScan();
    const removed: WorkEntry = { ...manyWorks(2)[1] };
    const store = memoryStore(
      buildWorkListSnapshot([entryFor(works[0], 4), entryFor(removed, 9)], "t")
    );
    const provider = makeProvider(works, store);

    const nodes = await provider.getChildren();

    expect(nodes.map((n) => (n as WorkNode).work.id)).toEqual(["w0"]);
    await gate.releaseAll();
  });

  test("場所が変わった作品は控えの数字を使わない", async () => {
    const works = manyWorks(1);
    const gate = gatedScan();
    const store = memoryStore(
      buildWorkListSnapshot([{ ...entryFor(works[0], 4), folderPath: "D:/前の場所" }], "t")
    );
    const provider = makeProvider(works, store);

    // 1件も合わなければ控えは使わず、これまでどおり走査を待つ
    const pending = provider.getChildren();
    await gate.releaseAll();
    const nodes = await pending;
    expect((nodes[0] as WorkNode).snapshot).toBeUndefined();
    expect((nodes[0] as WorkNode).stats.fileCount).toBe(1);
  });

  test("走査で作品が読めなければ、差し替えた行は理由を持つ", async () => {
    const works: WorkEntry[] = [{ ...manyWorks(1)[0], id: "broken", folderPath: "C:/x" }];
    const gate = gatedScan();
    const store = memoryStore(buildWorkListSnapshot([entryFor(works[0], 4)], "t"));
    const provider = makeProvider(works, store);

    await provider.getChildren();
    await gate.releaseAll();
    const nodes = await provider.getChildren();

    expect((nodes[0] as WorkNode).loadError).toContain("読めません");
    expect((nodes[0] as WorkNode).snapshot).toBeUndefined();
  });
});

describe("控えが壊れていても止まらない", () => {
  test.each([
    ["中身が壊れている", "壊れた文字列"],
    ["版が違う", { version: 99, works: [] }],
  ])("%s → これまでどおり走査を待って出す", async (_name, raw) => {
    const works = manyWorks(2);
    const gate = gatedScan();
    const store = memoryStore(raw);
    const provider = makeProvider(works, store);

    const pending = provider.getChildren();
    await gate.releaseAll();
    const nodes = await pending;

    expect(nodes).toHaveLength(2);
    expect((nodes[0] as WorkNode).snapshot).toBeUndefined();
  });

  test("保管庫の読み出しが投げても、一覧は出す", async () => {
    const works = manyWorks(1);
    const gate = gatedScan();
    const store = {
      ...memoryStore(),
      get: () => {
        throw new Error("読み出せません");
      },
    };
    const provider = makeProvider(works, store);

    const pending = provider.getChildren();
    await gate.releaseAll();
    expect(await pending).toHaveLength(1);
  });

  test("保管庫への書き込みが失敗しても、一覧は出す", async () => {
    const works = manyWorks(1);
    const gate = gatedScan();
    const store = {
      ...memoryStore(),
      update: async () => {
        throw new Error("書けません");
      },
    };
    const provider = makeProvider(works, store);

    const pending = provider.getChildren();
    await gate.releaseAll();
    expect(await pending).toHaveLength(1);
  });

  test("控えの保管庫が無ければ、これまでどおり", async () => {
    const works = manyWorks(1);
    const gate = gatedScan();
    const provider = makeProvider(works, undefined);

    const pending = provider.getChildren();
    await gate.releaseAll();
    const nodes = await pending;
    expect((nodes[0] as WorkNode).snapshot).toBeUndefined();
  });
});
