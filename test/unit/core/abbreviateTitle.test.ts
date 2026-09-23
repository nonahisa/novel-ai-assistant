import * as path from "path";
import { beforeEach, describe, expect, test, vi } from "vitest";

/**
 * 長い作品名は省略して、右側の補足・印を必ず見えるようにする（作者の裁定、2026-09-06）。
 *
 * 確かめるのは2つ。
 *
 * 1. **省略の境界**——20字までは触らず、21字から末尾を「…」にする
 * 2. **全文は必ずどこかに出す**——作品一覧ではホバー（tooltip）
 */

vi.mock("vscode", () => ({
  TreeItem: class {
    constructor(
      public label: unknown,
      public collapsibleState?: unknown
    ) {}
  },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  ThemeIcon: class {},
  ThemeColor: class {},
  MarkdownString: class {
    constructor(public value: string) {}
  },
  EventEmitter: class {
    event = () => ({ dispose() {} });
    fire() {}
  },
  Uri: { file: (p: string) => ({ fsPath: p }) },
  workspace: {
    getConfiguration: () => ({ get: () => undefined }),
  },
}));

const scanWork = vi.fn();
vi.mock("../../src/core/scanner", () => ({
  scanWork: (...args: unknown[]) => scanWork(...args),
}));

vi.mock("../../src/core/workFormatStore", () => ({
  readWorkFormat: async () => undefined,
}));
vi.mock("../../src/core/synopsisStore", () => ({
  SynopsisStore: class {
    async load() {
      return { episodes: [] };
    }
  },
}));
vi.mock("../../src/core/chapterStore", () => ({
  ChapterStore: class {
    async load() {
      return { schemaVersion: "1", chapters: [] };
    }
  },
  ChapterStoreError: class extends Error {},
}));

import { abbreviateTitle, isAbbreviated } from "../../src/core/abbreviateTitle";
import { WorkTreeProvider } from "../../src/views/workTree";
import type { WorkEntry } from "../../src/models/types";
import type { WorkRegistry } from "../../src/core/workRegistry";

describe("作品名の省略", () => {
  test("20字ちょうどは省略しない", () => {
    const title = "あ".repeat(20);
    expect(abbreviateTitle(title)).toBe(title);
    expect(isAbbreviated(title)).toBe(false);
  });

  test("21字から、先頭20字＋「…」になる", () => {
    const title = "あ".repeat(21);
    expect(abbreviateTitle(title)).toBe(`${"あ".repeat(20)}…`);
    expect(isAbbreviated(title)).toBe(true);
  });

  test("実際に困っていた題は、先頭20字だけになる", () => {
    expect(
      abbreviateTitle(
        "ハイエルフ未亡人のお気楽資産運用～食っちゃ寝しているだけなのに、金融の女王と呼ばれてます～"
      )
    ).toBe("ハイエルフ未亡人のお気楽資産運用～食っち…");
  });

  test("上限は呼び出し側で変えられる", () => {
    expect(abbreviateTitle("あいうえおかきくけこ", 5)).toBe("あいうえお…");
  });

  test("空文字は空文字のまま（例外にしない）", () => {
    expect(abbreviateTitle("")).toBe("");
  });

  test("絵文字を半分に割らない", () => {
    // サロゲートペアの片割れだけ残ると、文字化けした題に見える
    const title = "🍎".repeat(21);
    expect(abbreviateTitle(title)).toBe(`${"🍎".repeat(20)}…`);
  });
});

const longTitle =
  "ハイエルフ未亡人のお気楽資産運用～食っちゃ寝しているだけなのに、金融の女王と呼ばれてます～";

const work: WorkEntry = {
  id: "work_1",
  title: longTitle,
  folderPath: path.join("C:", "novels", "work"),
  registeredAt: "2026-09-06T00:00:00.000Z",
};

function makeProvider(): WorkTreeProvider {
  const registry = {
    list: () => [work],
    onDidChange: () => ({ dispose() {} }),
  } as unknown as WorkRegistry;
  return new WorkTreeProvider(registry);
}

/** ホバーの本文。スタブの `MarkdownString` は `value` に持つ */
function tooltipText(tooltip: unknown): string {
  if (tooltip && typeof tooltip === "object" && "value" in tooltip) {
    return String((tooltip as { value: unknown }).value);
  }
  return String(tooltip ?? "");
}

describe("作品一覧の行", () => {
  beforeEach(() => {
    scanWork.mockReset();
    scanWork.mockResolvedValue({
      episodes: [],
      stats: {
        fileCount: 2,
        totals: {
          net: 24,
          gross: 24,
          lines: 2,
          paragraphs: 2,
          manuscriptLines: 2,
        },
        conflictedCount: 0,
      },
      manuscriptDir: "本文",
    });
  });

  test("長い作品名は省略して、右の補足（字数）を押し出さない", async () => {
    const provider = makeProvider();
    const roots = await provider.getChildren();
    const item = provider.getTreeItem(roots[0]);

    expect(item.label).toBe(abbreviateTitle(longTitle));
    expect(String(item.description)).toContain("2ファイル");
  });

  test("ホバーには全文を出す", async () => {
    const provider = makeProvider();
    const roots = await provider.getChildren();
    const item = provider.getTreeItem(roots[0]);

    expect(tooltipText(item.tooltip)).toContain(longTitle);
  });

  test("読み込めない作品でも、ホバーには全文を出す", async () => {
    scanWork.mockRejectedValue(new Error("フォルダーがありません"));
    const provider = makeProvider();
    const roots = await provider.getChildren();
    const item = provider.getTreeItem(roots[0]);

    expect(item.label).toBe(abbreviateTitle(longTitle));
    expect(tooltipText(item.tooltip)).toContain(longTitle);
  });
});
