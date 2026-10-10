import { beforeEach, describe, expect, test, vi } from "vitest";

/**
 * 作品一覧の描き直しと、右クリックの命令に行が渡らない件（0.102.8）。
 *
 * **起きていたこと**（2026-10-11、ノートPCの画面の自動テスト 1.141.0）：
 * 話の行を右クリックして「この話の前に挿入」「ここから章を始める」を押しても、
 * 入力欄が出ずに黙って終わることがあった。
 *
 * **仕組み**（VS Code 1.138.0 の拡張機能ホストの `ExtHostTreeView` を読んで確かめた）：
 * `onDidChangeTreeData` を引数なしで撃つと、拡張機能ホストは**その場で**
 * 「行の控え（handle）→ 行の中身」の対応表をぜんぶ消す。表が埋め直されるのは、
 * 画面側が `getChildren` を呼び直してから。その隙間に品書きが押されると、
 * 命令には行の代わりに `undefined` が渡る。
 *
 * 同期の印の見張り（`gitSync`）は、**状態が変わっていなくても**描き直しを求めていた
 * （ファイルが1つ書かれるたび）。行の見た目は変わらないので、画面の自動テストの
 * `waitTreeSettled`（行の名前の並びを見る）では待てず、作者にも見えない。
 * それでも対応表は毎回消えていた。
 *
 * ここで確かめること：
 * - 同期の印が変わらない描き直しの求めでは、一覧を描き直さない（対応表を消さない）
 * - 印が変われば描き直す。作品一覧を読み直した（`refresh`）あとの最初の求めも描き直す
 * - 話の行・メモの行に、描き直しで変わらない id が付く
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

vi.mock("../../../src/core/scanner", () => ({ scanWork: vi.fn() }));

import {
  EpisodeNode,
  MemoFileNode,
  WorkTreeProvider,
} from "../../../src/views/workTree";
import type { EpisodeFile, WorkEntry } from "../../../src/models/types";
import type { WorkRegistry } from "../../../src/core/workRegistry";

const work: WorkEntry = {
  id: "w1",
  title: "氷の街",
  folderPath: "C:/小説/氷の街",
  registeredAt: "2026-10-11T00:00:00.000Z",
};

function episodeAt(fileName: string, chapter: number): EpisodeFile {
  return {
    filePath: `C:/小説/氷の街/本文/${fileName}`,
    fileName,
    ext: ".txt",
    chapterStart: chapter,
    chapterEnd: chapter,
    subtitle: null,
    kind: "本編",
    isInitialName: false,
    counts: {
      net: 100,
      gross: 110,
      lines: 3,
      paragraphs: 3,
      manuscriptLines: 5,
    },
    hasMetadata: false,
    declaredCharCount: null,
    metaTitle: null,
    metaUpdatedAt: null,
    hasConflictMarkers: false,
    collectedCount: 1,
  } as unknown as EpisodeFile;
}

function providerWith(badge: { value: string | undefined }) {
  const registry = {
    list: () => [work],
    onDidChange: () => ({ dispose() {} }),
  } as unknown as WorkRegistry;
  return new WorkTreeProvider(
    registry,
    () => badge.value,
    () => (badge.value ? [`- ${badge.value}`] : [])
  );
}

beforeEach(() => {
  fired.length = 0;
});

describe("同期の印の見張りからの描き直し", () => {
  test("印が変わらなければ、2回目からは描き直さない（行の対応表を消さない）", () => {
    const badge = { value: "記録待ち1" as string | undefined };
    const provider = providerWith(badge);

    provider.redrawIfChanged();
    const afterFirst = fired.length;
    provider.redrawIfChanged();
    provider.redrawIfChanged();

    expect(afterFirst).toBe(1);
    expect(fired.length).toBe(1);
  });

  test("印が変われば描き直す", () => {
    const badge = { value: "記録待ち1" as string | undefined };
    const provider = providerWith(badge);

    provider.redrawIfChanged();
    badge.value = "記録待ち2";
    provider.redrawIfChanged();
    badge.value = undefined;
    provider.redrawIfChanged();

    expect(fired.length).toBe(3);
  });

  test("作品一覧を読み直したあとの最初の求めは、印が同じでも描き直す", () => {
    const badge = { value: "記録待ち1" as string | undefined };
    const provider = providerWith(badge);

    provider.redrawIfChanged();
    provider.refresh(work.id);
    const afterRefresh = fired.length;
    provider.redrawIfChanged();

    expect(fired.length).toBe(afterRefresh + 1);
  });

  test("数え方の設定などで呼ぶ `redraw` は、これまでどおり必ず描き直す", () => {
    const provider = providerWith({ value: undefined });

    provider.redraw();
    provider.redraw();

    expect(fired.length).toBe(2);
  });
});

describe("話の行・メモの行の id", () => {
  test("話の行の id は作品と話のファイルで決まり、同じ話なら作り直しても変わらない", () => {
    const provider = providerWith({ value: undefined });
    const ep = episodeAt("第2話_つづき.txt", 2);

    const first = provider.getTreeItem(new EpisodeNode(work, ep)) as { id?: string };
    const again = provider.getTreeItem(new EpisodeNode(work, { ...ep })) as { id?: string };
    const other = provider.getTreeItem(
      new EpisodeNode(work, episodeAt("第3話_山場.txt", 3))
    ) as { id?: string };

    expect(first.id).toBeDefined();
    expect(first.id).toBe(again.id);
    expect(first.id).not.toBe(other.id);
    // 作品・章・メモの枝の id と重ならない頭を持つ
    expect(first.id?.startsWith("episode:")).toBe(true);
  });

  test("メモの行にも、作品とファイルで決まる id が付く", () => {
    const provider = providerWith({ value: undefined });
    const memo = { title: "取材メモ", filePath: "C:/小説/氷の街/メモ/取材メモ.md" };

    const item = provider.getTreeItem(
      new MemoFileNode(work, memo as never)
    ) as { id?: string };

    expect(item.id?.startsWith("memoFile:")).toBe(true);
    expect(item.id).toContain(memo.filePath);
  });
});
