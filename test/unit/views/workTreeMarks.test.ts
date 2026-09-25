import { beforeEach, describe, expect, test, vi } from "vitest";

/**
 * 作品一覧の印を題の前に出す（精査 R14、作者の裁定 2026-09-26）。
 *
 * **長い題が、右に添えた字数と同期の印を行の外へ押し出していた。**
 * VS Code の木の行は「名前（label）→ 説明（description）」の順に並び、
 * 幅が足りないと**後ろから切れる**。印を説明の後ろに置いていたので、
 * 「ハイエルフ未亡人のお気楽資産運用～食っち…」のような題では
 * 「記録待ち1」が読めなかった（実機確認 F-11、2026-09-21）。
 *
 * 印（同期・競合・読み込めない）は名前の頭に置き、字数は後ろのまま残す。
 * 見た目は画面でしか確かめられないので、ここでは**どこに何が入るか**だけを見る。
 */

vi.mock("vscode", () => ({
  TreeItem: class {
    id?: string;
    description?: string;
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
vi.mock("../../../src/core/scanner", async () => {
  const actual =
    await vi.importActual<typeof import("../../../src/core/scanner")>(
      "../../../src/core/scanner"
    );
  return { ...actual, scanWork: (...args: unknown[]) => scanWork(...args) };
});

import { WorkTreeProvider, type WorkNode } from "../../../src/views/workTree";
import { workRowLabel } from "../../../src/core/workRowLabel";
import type { WorkEntry } from "../../../src/models/types";
import type { WorkRegistry } from "../../../src/core/workRegistry";

const LONG_TITLE =
  "ハイエルフ未亡人のお気楽資産運用～食っちゃ寝しているだけなのに、金融の女王と呼ばれてます～";

const work: WorkEntry = {
  id: "w1",
  title: LONG_TITLE,
  folderPath: "C:/novels/haielf",
  registeredAt: "2026-09-26T00:00:00.000Z",
};

function stats(conflictedCount = 0) {
  return {
    episodes: [],
    stats: {
      fileCount: 17,
      totals: { net: 85431, gross: 90000, manuscriptLines: 100 },
      conflictedCount,
    },
    manuscriptDir: "本文",
  };
}

interface Item {
  label: string;
  description?: string;
  id?: string;
  tooltip?: { value: string };
}

async function itemFor(
  badge: string | undefined,
  conflictedCount = 0
): Promise<Item> {
  scanWork.mockResolvedValue(stats(conflictedCount));
  const registry = {
    list: () => [work],
    onDidChange: () => ({ dispose() {} }),
  } as unknown as WorkRegistry;
  const provider = new WorkTreeProvider(
    registry,
    () => badge,
    () => (badge ? ["- 記録待ち: 1件（書いたまま、まだ履歴に残していない）"] : [])
  );
  const [node] = await provider.getChildren();
  return provider.getTreeItem(node as WorkNode) as unknown as Item;
}

beforeEach(() => {
  scanWork.mockReset();
});

describe("作品一覧の行（精査 R14）", () => {
  test("同期の印は題の前に出し、字数は説明（後ろ）に残す", async () => {
    const item = await itemFor("記録待ち1・送信待ち6");

    expect(item.label.startsWith("［記録待ち1・送信待ち6］")).toBe(true);
    // 題は印のあとに、いままでどおり省略して続く
    expect(item.label).toContain("ハイエルフ未亡人のお気楽資産運用");
    expect(item.label.endsWith("…")).toBe(true);
    // 説明には字数だけ。**印を2か所に出さない**
    expect(item.description).toContain("17ファイル");
    expect(item.description).toContain("字");
    expect(item.description).not.toContain("記録待ち");
  });

  test("競合の印も前に出す（同期の印より先）", async () => {
    const item = await itemFor("記録待ち1", 2);

    expect(item.label.startsWith("［⚠競合2件・記録待ち1］")).toBe(true);
    expect(item.description).not.toContain("競合");
  });

  test("印が無ければ、題だけ（括弧を付けない）", async () => {
    const item = await itemFor(undefined);

    expect(item.label).toBe(workRowLabel(LONG_TITLE, []));
    expect(item.label.startsWith("［")).toBe(false);
  });

  test("題の全文と印の意味は、指を載せたときに読める", async () => {
    const item = await itemFor("記録待ち1");

    expect(item.tooltip?.value).toContain(LONG_TITLE);
    expect(item.tooltip?.value).toContain("記録待ち: 1件");
  });

  /**
   * **名前が変わっても、開いた作品を畳まない。** VS Code は id の無い行を
   * 名前で覚えるので、印が増減するたびに別の行と見なして閉じてしまう。
   */
  test("行の id は作品で決まり、印が変わっても変わらない", async () => {
    const before = await itemFor("記録待ち1");
    const after = await itemFor(undefined);

    expect(before.id).toBeDefined();
    expect(before.id).toBe(after.id);
  });

  test("読み込めない作品は、その印を前に出す", async () => {
    scanWork.mockRejectedValue(new Error("中断されました"));
    const registry = {
      list: () => [work],
      onDidChange: () => ({ dispose() {} }),
    } as unknown as WorkRegistry;
    const provider = new WorkTreeProvider(registry);
    const [node] = await provider.getChildren();
    const item = provider.getTreeItem(node as WorkNode) as unknown as Item;

    expect(item.label.startsWith("［⚠読み込めません］")).toBe(true);
    expect(item.tooltip?.value).toContain("中断されました");
  });
});

describe("行の名前の組み立て（workRowLabel）", () => {
  test("印は全角の中黒でつなぎ、［］で題と分ける", () => {
    expect(workRowLabel("氷の街", ["⚠競合1件", "記録待ち2"])).toBe(
      "［⚠競合1件・記録待ち2］氷の街"
    );
  });

  test("空の印は数えない", () => {
    expect(workRowLabel("氷の街", [undefined, "", "未送信"])).toBe(
      "［未送信］氷の街"
    );
    expect(workRowLabel("氷の街", [undefined])).toBe("氷の街");
  });

  test("題は20字で省略する（印の長さで題の上限を変えない）", () => {
    const label = workRowLabel(LONG_TITLE, ["記録待ち1"]);
    expect(label).toBe(`［記録待ち1］${Array.from(LONG_TITLE).slice(0, 20).join("")}…`);
  });
});
