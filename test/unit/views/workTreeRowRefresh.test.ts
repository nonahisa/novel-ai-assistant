import { beforeEach, describe, expect, test, vi } from "vitest";

/**
 * 作品一覧の描き直しを、変わった行だけに絞る（0.105.2）。
 *
 * **起きていたこと**（2026-10-12、ノートPCの画面の自動テスト 1.141.0）：
 * 作品を2つ登録した直後や、本文を保存した直後に右クリックの品書きを押すと、
 * 命令に行が渡らない（作品の行の「プロットモード」で「作品を選択」が出る／
 * 話の行の「この話の前に挿入」で入力欄が出ない）ことがあった。
 *
 * **仕組み**（1.141.0 の拡張機能ホスト `ExtHostTreeView` を読んで確かめた）：
 * - `onDidChangeTreeData` を**引数なし**で撃つと、200ms まとめたあと
 *   「行の控え → 行の中身」の表を**全部**消し、画面が行を取り直すまで埋めない
 * - **行を渡して**撃つと、消えるのはその行の**子だけ**。行そのものは表に残る。
 *   ただし渡した行が表に無い（別のオブジェクト）と黙って捨てられる
 * - 隙間の長さは「撃ってから `getChildren` が返るまで」。これまでは
 *   捨てて撃ってから走査していたので、隙間＝走査の時間だった
 *
 * ここで確かめること（どの出来事で何を撃つか）：
 * - 1作品の読み直し（`refresh(id)`）は、**先に走査してから、画面に出ている
 *   その作品の行だけ**を撃つ。行には新しい字数が入る。ほかの作品は読み直さない
 * - 一覧をまだ描いていなければ、これまでどおり全部を描き直す
 * - 作品の登録・解除（登録簿の変化）は全部描き直すが、残っている作品の
 *   走査結果は捨てない（描き直しの `getChildren` がすぐ返る）
 * - 作品の外のファイルの保存では何も撃たない。作品の中なら、その作品だけ
 * - 同期の印は、印の変わった作品の行だけを撃つ
 */

const fired: unknown[] = [];

vi.mock("vscode", () => ({
  TreeItem: class {
    id?: string;
    description?: string;
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
    fire(value?: unknown) {
      fired.push(value);
    }
  },
  Uri: { file: (p: string) => ({ fsPath: p, toString: () => p }) },
  workspace: {
    getConfiguration: () => ({ get: (_key: string, fallback?: unknown) => fallback }),
  },
}));

const scanWork = vi.fn();
vi.mock("../../../src/core/scanner", () => ({
  scanWork: (...args: unknown[]) => scanWork(...args),
}));
vi.mock("../../../src/core/workFormatStore", () => ({
  readWorkFormat: async () => undefined,
}));
vi.mock("../../../src/core/chapterStore", () => ({
  ChapterStore: class {
    async load() {
      return { chapters: [] };
    }
  },
}));
vi.mock("../../../src/core/workMemos", () => ({
  listWorkMemos: async () => [],
}));
vi.mock("../../../src/core/postingStore", () => ({
  PostingStore: class {
    async load() {
      return { sites: [], records: [] };
    }
  },
}));
vi.mock("../../../src/core/synopsisStore", () => ({
  SynopsisStore: class {
    async load() {
      return { episodes: [] };
    }
  },
}));

import { WorkNode, WorkTreeProvider } from "../../../src/views/workTree";
import type { WorkEntry } from "../../../src/models/types";
import type { WorkRegistry } from "../../../src/core/workRegistry";

function workAt(id: string, title: string): WorkEntry {
  return {
    id,
    title,
    folderPath: `C:/小説/${title}`,
    registeredAt: "2026-10-12T00:00:00.000Z",
  };
}

const a = workAt("wa", "氷の街");
const b = workAt("wb", "港の朝");

/** 走査の回数ごとに字数を変える（同じ作品を読み直したことが字数で分かる） */
const scans = new Map<string, number>();
function scanned(work: WorkEntry) {
  const count = (scans.get(work.id) ?? 0) + 1;
  scans.set(work.id, count);
  return {
    episodes: [],
    stats: {
      fileCount: count,
      totals: { net: count * 100, gross: count * 100, lines: 0, paragraphs: 0, manuscriptLines: 0 },
      conflictedCount: 0,
    },
    manuscriptDir: work.folderPath,
    workInfoFiles: [],
    configuredKind: undefined,
    timing: { readMs: 0, countMs: 0, files: 0 },
  };
}

function setup(initial: WorkEntry[], badges: Map<string, string> = new Map()) {
  let works = [...initial];
  let changed: (() => void) | undefined;
  const registry = {
    list: () => works,
    onDidChange: (listener: () => void) => {
      changed = listener;
      return { dispose() {} };
    },
  } as unknown as WorkRegistry;
  const provider = new WorkTreeProvider(
    registry,
    (id) => badges.get(id),
    (id) => (badges.get(id) ? [`- ${badges.get(id)}`] : [])
  );
  return {
    provider,
    setWorks(next: WorkEntry[]) {
      works = next;
      changed?.();
    },
  };
}

function scanCount(work: WorkEntry): number {
  return scanWork.mock.calls.filter(([w]) => (w as WorkEntry).id === work.id).length;
}

beforeEach(() => {
  fired.length = 0;
  scans.clear();
  scanWork.mockReset();
  scanWork.mockImplementation(async (work: WorkEntry) => scanned(work));
});

describe("1作品の読み直し（refresh(id)）", () => {
  test("一覧を描いたあとなら、先に走査してから、その作品の行だけを撃つ（全部は消さない）", async () => {
    const { provider } = setup([a, b]);
    const root = (await provider.getChildren()) as WorkNode[];
    const rowA = root.find((node) => node.work.id === a.id)!;
    fired.length = 0;

    provider.refresh(a.id);
    await provider.settled();

    expect(treeFired()).toEqual([rowA]);
    // 行には読み直した字数が入る（同じ行のまま描き直されるので、古い字数を出さない）
    expect(rowA.stats.fileCount).toBe(2);
    // ほかの作品は読み直さない
    expect(scanCount(b)).toBe(1);
  });

  test("走査が終わる前には撃たない（撃ってから走査すると、そのあいだ行が引けない）", async () => {
    const { provider } = setup([a, b]);
    await provider.getChildren();
    fired.length = 0;
    let release: () => void = () => undefined;
    scanWork.mockImplementationOnce(
      (work: WorkEntry) =>
        new Promise((resolve) => {
          release = () => resolve(scanned(work));
        })
    );

    provider.refresh(a.id);
    await Promise.resolve();
    expect(treeFired()).toEqual([]);

    release();
    await provider.settled();
    expect(treeFired().length).toBe(1);
  });

  test("一覧をまだ描いていなければ、これまでどおり全部を描き直す", () => {
    const { provider } = setup([a, b]);

    provider.refresh(a.id);

    expect(treeFired()).toEqual([undefined]);
  });

  test("引数なしの refresh は、これまでどおり全部を描き直す", async () => {
    const { provider } = setup([a, b]);
    await provider.getChildren();
    fired.length = 0;

    provider.refresh();

    expect(treeFired()).toEqual([undefined]);
  });
});

describe("作品の登録・解除", () => {
  test("登録簿が変わったら全部描き直すが、残っている作品は読み直さない", async () => {
    const { provider, setWorks } = setup([a]);
    await provider.getChildren();
    fired.length = 0;

    setWorks([a, b]);
    expect(treeFired()).toEqual([undefined]);
    const root = (await provider.getChildren()) as WorkNode[];

    expect(root.map((node) => node.work.id)).toEqual([a.id, b.id]);
    expect(scanCount(a)).toBe(1);
    expect(scanCount(b)).toBe(1);
  });

  test("解除した作品の走査結果は捨てる（同じIDで登録し直したら読み直す）", async () => {
    const { provider, setWorks } = setup([a, b]);
    await provider.getChildren();

    setWorks([a]);
    await provider.getChildren();
    setWorks([a, b]);
    await provider.getChildren();

    expect(scanCount(b)).toBe(2);
    expect(scanCount(a)).toBe(1);
  });

  test("作品の場所が変わったら、その作品は読み直す", async () => {
    const { provider, setWorks } = setup([a, b]);
    await provider.getChildren();

    setWorks([{ ...a, folderPath: "D:/移した先/氷の街" }, b]);
    await provider.getChildren();

    expect(scanCount(a)).toBe(2);
    expect(scanCount(b)).toBe(1);
  });
});

describe("ファイルの保存", () => {
  test("作品の外のファイルを保存しても、何も撃たない", async () => {
    const { provider } = setup([a, b]);
    await provider.getChildren();
    fired.length = 0;

    provider.refreshForFile("C:/ほかの場所/メモ.txt");
    await provider.settled();

    expect(treeFired()).toEqual([]);
  });

  test("作品の中のファイルなら、その作品の行だけを撃つ", async () => {
    const { provider } = setup([a, b]);
    const root = (await provider.getChildren()) as WorkNode[];
    const rowB = root.find((node) => node.work.id === b.id)!;
    fired.length = 0;

    provider.refreshForFile(`${b.folderPath}/本文/第1話.txt`);
    await provider.settled();

    expect(treeFired()).toEqual([rowB]);
    expect(scanCount(a)).toBe(1);
  });
});

describe("同期の印", () => {
  test("一覧を描いたあとは、印の変わった作品の行だけを撃つ", async () => {
    const badges = new Map([[a.id, "記録待ち1"], [b.id, "記録待ち1"]]);
    const { provider } = setup([a, b], badges);
    const root = (await provider.getChildren()) as WorkNode[];
    provider.redrawIfChanged();
    fired.length = 0;

    badges.set(b.id, "記録待ち2");
    provider.redrawIfChanged();

    expect(treeFired()).toEqual([[root.find((node) => node.work.id === b.id)]]);
  });
});

/**
 * 作品一覧の描き直しの合図だけ（読み終えた合図 `onDidLoadWork` は作品IDの文字を
 * 撃つので除く。同じ偽の EventEmitter を通るため）
 */
function treeFired(): unknown[] {
  return fired.filter((value) => typeof value !== "string");
}
