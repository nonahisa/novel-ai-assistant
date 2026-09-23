import { describe, expect, test, vi } from "vitest";

/**
 * 作品一覧から話を開くときの画面（作者の指示、2026-08-29）。
 *
 * 「本文ファイルを開くときは、原稿エディター横書きで開くようにしてください」。
 *
 * これまでは `vscode.open` で素のエディタへ渡していた。VS Code 1.131 の
 * Markdown編集画面では用語の色分けもルビも右クリックの設定資料も効かない
 * （設計書6.25）ので、書くための画面を持っているのに毎回
 * 「エディターを再度開く」を通ることになっていた。
 *
 * **決め打つのは話（本文）だけ。** プロット・あらすじ・設定資料は
 * 素のエディタのままである（一覧でコマンドを持つのは話の行だけ）。
 */

vi.mock("vscode", () => ({
  TreeItem: class {
    description?: string;
    tooltip?: unknown;
    contextValue?: string;
    resourceUri?: unknown;
    iconPath?: unknown;
    command?: unknown;
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
    getConfiguration: () => ({
      get: (_key: string, fallback?: unknown) => fallback,
    }),
  },
}));

vi.mock("../../src/core/scanner", () => ({ scanWork: vi.fn() }));

import { WorkTreeProvider, EpisodeNode } from "../../src/views/workTree";
import { MANUSCRIPT_EDITOR_HORIZONTAL_VIEW_TYPE } from "../../src/core/manuscriptViewTypes";
import type { WorkEntry, EpisodeFile } from "../../src/models/types";
import type { WorkRegistry } from "../../src/core/workRegistry";

const work: WorkEntry = {
  id: "w1",
  title: "いじめられっ子",
  folderPath: "C:/小説/いじめられっ子",
  registeredAt: "2026-08-29T00:00:00.000Z",
};

const episode: EpisodeFile = {
  filePath: "C:/小説/いじめられっ子/本文/002.txt",
  fileName: "002.txt",
  ext: ".txt",
  chapterStart: 2,
  chapterEnd: 2,
  subtitle: null,
  // 置き場所のフォルダー名は「本文」だが、`EpisodeKind` の値は「本編」である
  // （プロローグ・エピローグ・幕間と並ぶ区分）。ここは取り違えていた
  kind: "本編",
  isInitialName: true,
  // このテストが見るのは「どの画面でどのファイルを開くか」だけなので、
  // 字数は辻褄の合う埋め草でよい。ただし `CharCounts` の項目は欠かさない
  counts: {
    net: 2000,
    gross: 2100,
    lines: 60,
    paragraphs: 30,
    manuscriptLines: 50,
  },
  hasMetadata: false,
  metaTitle: null,
  declaredCharCount: null,
  metaUpdatedAt: null,
  hasConflictMarkers: false,
  collectedCount: 1,
};

function treeItemForEpisode() {
  const registry = {
    list: () => [work],
    onDidChange: () => ({ dispose() {} }),
  } as unknown as WorkRegistry;
  const provider = new WorkTreeProvider(registry);
  return provider.getTreeItem(new EpisodeNode(work, episode));
}

describe("一覧から話を開く", () => {
  test("原稿エディタ（横書き）で開く", () => {
    const command = treeItemForEpisode().command as {
      command: string;
      arguments: unknown[];
    };

    expect(command.command).toBe("vscode.openWith");
    expect(command.arguments[1]).toBe(MANUSCRIPT_EDITOR_HORIZONTAL_VIEW_TYPE);
  });

  test("開く先は、その話のファイル", () => {
    const command = treeItemForEpisode().command as {
      arguments: Array<{ fsPath: string }>;
    };

    expect(command.arguments[0].fsPath).toBe(
      "C:/小説/いじめられっ子/本文/002.txt"
    );
  });
});
