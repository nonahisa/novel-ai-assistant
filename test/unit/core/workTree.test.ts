import { describe, expect, test, vi } from "vitest";

// TreeItem等は使わないので、読み込みを通すための最小限だけ差し替える
vi.mock("vscode", () => ({
  TreeItem: class {},
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  ThemeIcon: class {},
  ThemeColor: class {},
  MarkdownString: class {},
  EventEmitter: class {
    event = () => ({ dispose() {} });
    fire() {}
  },
  Uri: { file: (p: string) => ({ fsPath: p }) },
}));

import { episodeTitle } from "../../src/core/episodeLabel";

describe("一覧に出すタイトル", () => {
  test("投稿サイトのヘッダーに入った話数の重複を落とす", () => {
    // 「第1話　第1話 気がついたら幽霊に」と二重に出ていた
    expect(
      episodeTitle(
        { metaTitle: "第1話 気がついたら幽霊に", subtitle: null },
        "第1話"
      )
    ).toBe("気がついたら幽霊に");
  });

  test("話数のあとの区切り記号も一緒に落とす", () => {
    expect(
      episodeTitle({ metaTitle: "第3話：転生", subtitle: null }, "第3話")
    ).toBe("転生");
  });

  test("話数しか書かれていないタイトルは出さない", () => {
    // labelに「第16話」と出ているので、右へ同じ文字を並べても情報が増えない
    expect(
      episodeTitle({ metaTitle: "第16話", subtitle: null }, "第16話")
    ).toBeNull();
  });

  test("タイトルが無ければ何も返さない", () => {
    expect(episodeTitle({ metaTitle: null, subtitle: null }, "第16話")).toBeNull();
  });

  test("話数で始まらないタイトルはそのまま使う", () => {
    expect(
      episodeTitle({ metaTitle: "湖畔の誓い", subtitle: null }, "第7話")
    ).toBe("湖畔の誓い");
  });

  test("話数が判定できないファイルもタイトルはそのまま使う", () => {
    expect(episodeTitle({ metaTitle: null, subtitle: "序章" }, "")).toBe("序章");
  });

  test("別の話数で始まるタイトルは削らない", () => {
    // 合本（第3〜5話）のタイトルに「第3話」が含まれていても、
    // labelは「第3〜5話」なので前方一致せず、そのまま残る
    expect(
      episodeTitle(
        { metaTitle: "第3話 出発／第4話 到着", subtitle: null },
        "第3〜5話"
      )
    ).toBe("第3話 出発／第4話 到着");
  });
});
