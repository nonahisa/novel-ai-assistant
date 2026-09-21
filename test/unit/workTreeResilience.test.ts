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

/**
 * 好きな作品一覧と、読み込み中の合図の受け口を付けた provider。
 *
 * 並列の確かめには作品が4件より多く要る（同時に4つまでなので、
 * 4件では「全部いっぺんに走った」と区別が付かない）。
 */
function makeProviderWith(
  entries: WorkEntry[],
  onLoadingChanged?: (loading: boolean, count: number) => void
): WorkTreeProvider {
  const registry = {
    list: () => entries,
    onDidChange: () => ({ dispose() {} }),
  } as unknown as WorkRegistry;
  return new WorkTreeProvider(
    registry,
    undefined,
    undefined,
    undefined,
    onLoadingChanged
  );
}

/** 連番の作品をn件作る */
function manyWorks(count: number): WorkEntry[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `w${index}`,
    title: `作品${String(index).padStart(2, "0")}`,
    folderPath: `C:/novels/w${index}`,
    registeredAt: "2026-09-21T00:00:00.000Z",
  }));
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

/**
 * **作品一覧の走査は同時に4つまで**（設計書6.1.2）。
 *
 * 1件ずつ順に `await` していたため、作者のノートPC（16作品・573ファイル）では
 * 一覧が出るまで **17秒** かかっていた（2026-09-21の計測）。`scanWork` は
 * ファイルを1つずつ読むので、待ち時間が作品の数だけ積み上がる。
 */
describe("作品一覧の走査を並列にする", () => {
  /** 好きなタイミングで解決できる走査。同時にいくつ走ったかを数える */
  function gatedScan() {
    const release: Array<() => void> = [];
    let running = 0;
    let peak = 0;
    scanWork.mockImplementation(
      (work: WorkEntry) =>
        new Promise((resolve) => {
          running += 1;
          peak = Math.max(peak, running);
          release.push(() => {
            running -= 1;
            resolve({
              episodes: [],
              stats: {
                fileCount: Number(work.id.slice(1)),
                totals: { net: 0, gross: 0, manuscriptLines: 0 },
                conflictedCount: 0,
              },
              manuscriptDir: "本文",
            });
          });
        })
    );
    return {
      /** いま待っている走査を全部終わらせる */
      releaseAll: () => {
        while (release.length > 0) release.shift()?.();
      },
      started: () => release.length,
      peak: () => peak,
    };
  }

  test("同時に走るのは4件まで（10作品でも5件目は待たされる）", async () => {
    const gate = gatedScan();
    const pending = makeProviderWith(manyWorks(10)).getChildren();

    // まだ1件も終わっていないので、走り出せるのは4件だけ
    await Promise.resolve();
    await Promise.resolve();
    expect(gate.started()).toBe(4);

    // 終わらせていくと、残りが順に入ってくる
    for (let i = 0; i < 12; i += 1) {
      gate.releaseAll();
      await Promise.resolve();
    }
    await pending;
    expect(gate.peak()).toBeLessThanOrEqual(4);
  });

  test("並列でも、並びは登録簿の順のまま", async () => {
    /*
      先に終わった作品から詰めると、**起動のたびに一覧の並びが変わる**。
      遅い作品（先頭）をわざと最後に終わらせても、順番は動かないこと
    */
    const order = ["w0", "w1", "w2", "w3", "w4", "w5"];
    scanWork.mockImplementation(async (work: WorkEntry) => {
      // 先頭ほど遅く返す（終わった順に詰めていれば逆順になる）
      const delay = order.length - order.indexOf(work.id);
      await new Promise((resolve) => setTimeout(resolve, delay));
      return {
        episodes: [],
        stats: {
          fileCount: 1,
          totals: { net: 0, gross: 0, manuscriptLines: 0 },
          conflictedCount: 0,
        },
        manuscriptDir: "本文",
      };
    });

    const nodes = await makeProviderWith(manyWorks(6)).getChildren();

    expect(nodes.map((n) => (n as WorkNode).work.id)).toEqual(order);
  });

  test("並列にしても、1件の失敗で一覧が消えない", async () => {
    // `Promise.all` は1件の拒否で全体を捨てる。受け止め損ねていないこと
    scanWork.mockImplementation(async (work: WorkEntry) => {
      if (work.id === "w2") throw new Error("読めません");
      return {
        episodes: [],
        stats: {
          fileCount: 1,
          totals: { net: 0, gross: 0, manuscriptLines: 0 },
          conflictedCount: 0,
        },
        manuscriptDir: "本文",
      };
    });

    const nodes = await makeProviderWith(manyWorks(6)).getChildren();

    expect(nodes).toHaveLength(6);
    expect((nodes[2] as WorkNode).loadError).toContain("読めません");
    expect((nodes[0] as WorkNode).loadError).toBeUndefined();
  });
});

/**
 * **走査中は「まだ作品が登録されていません」を出さない**（設計書6.1.2）。
 *
 * `getChildren` が返るまでツリーは空で、VS Code は空のツリーに
 * `viewsWelcome`（登録ボタン4つ）を出す。**登録済みの作品があるのに
 * 「登録されていません」と出るのは、作者から見れば作品が消えたのと同じ。**
 */
describe("読み込み中の合図", () => {
  function okScan(): void {
    scanWork.mockResolvedValue({
      episodes: [],
      stats: {
        fileCount: 1,
        totals: { net: 0, gross: 0, manuscriptLines: 0 },
        conflictedCount: 0,
      },
      manuscriptDir: "本文",
    });
  }

  test("走査の前後に true → false と1回ずつ来る", async () => {
    okScan();
    const calls: Array<[boolean, number]> = [];
    const provider = makeProviderWith(manyWorks(3), (loading, count) =>
      calls.push([loading, count])
    );

    await provider.getChildren();

    expect(calls).toEqual([
      [true, 3],
      [false, 3],
    ]);
  });

  test("作品が0件なら、合図は来ない（従来の案内がそのまま正しい）", async () => {
    okScan();
    const calls: Array<[boolean, number]> = [];
    const provider = makeProviderWith([], (loading, count) =>
      calls.push([loading, count])
    );

    await provider.getChildren();

    expect(calls).toEqual([]);
  });

  test("走査が途中で失敗しても、合図は false まで来る", async () => {
    // 落とし忘れると「読み込んでいます」が出たままになる
    scanWork.mockRejectedValue(new Error("読めません"));
    const calls: Array<[boolean, number]> = [];
    const provider = makeProviderWith(manyWorks(2), (loading, count) =>
      calls.push([loading, count])
    );

    await provider.getChildren();

    expect(calls.map(([loading]) => loading)).toEqual([true, false]);
  });

  test("描き直しが重なっても、あとから始まったほうの終わりで落ちない", async () => {
    /*
      VS Code は前の `getChildren` が返る前にもう一度呼ぶことがある。
      数えずに付け外しすると、まだ走っているのに印が落ちる
    */
    okScan();
    const calls: Array<[boolean, number]> = [];
    const provider = makeProviderWith(manyWorks(2), (loading, count) =>
      calls.push([loading, count])
    );

    await Promise.all([provider.getChildren(), provider.getChildren()]);

    expect(calls.map(([loading]) => loading)).toEqual([true, false]);
  });

  test("合図の受け口が落ちても、一覧は出す", async () => {
    okScan();
    const provider = makeProviderWith(manyWorks(2), () => {
      throw new Error("setContext に失敗");
    });

    const nodes = await provider.getChildren();

    expect(nodes).toHaveLength(2);
  });
});
