import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";

/**
 * 提案パネルの名前と、提案の窓口が1つであること（設計書5.6）。
 *
 * **旧名は「AI指摘」だった。** 編集部からの提案も同じパネルへ流すように
 * なった時点で、その名前は中身と合わなくなった。
 *
 * **作者への提案の窓口は1つにする。** 本文の直しは提案パネル、設定資料の
 * 更新は別のダイアログ、では**片方を見落とす。**
 */
describe("パネルの名前", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf-8")) as {
    contributes: {
      viewsContainers: { panel: Array<{ id: string; title: string }> };
      views: Record<string, Array<{ id: string; name: string }>>;
    };
  };

  test("画面に出る名前が「提案」になっている", () => {
    const container = pkg.contributes.viewsContainers.panel.find(
      (entry) => entry.id === "novelaiIssues"
    );

    expect(container?.title).toBe("提案");
  });

  test("ビューのIDも旧名を引きずっていない", () => {
    // **中身と合わない名前を残すと、後から読む人が混乱する**
    const ids = Object.values(pkg.contributes.views)
      .flat()
      .map((view) => view.id);

    expect(ids).toContain("novelai.proposalsView");
    expect(ids).not.toContain("novelai.aiIssuesView");
  });

  test("ソースに旧名が残っていない", () => {
    for (const file of [
      "src/features/proposalPanel.ts",
      "src/views/proposalPanelHtml.ts",
      "src/extension.ts",
      "src/views/actionList.ts",
    ]) {
      expect(readFileSync(file, "utf-8"), file).not.toContain("AI指摘");
    }
  });
});

describe("提案の窓口は1つ", () => {
  test("設定資料の更新も提案パネルへ出す", () => {
    // **本文の直しと設定資料の更新で窓口が分かれていた。**
    // 片方しか見ないと、もう片方が溜まったままになる
    const source = readFileSync("src/features/applyPendingUpdates.ts", "utf-8");

    expect(source).toContain("panel.showRecordUpdates");
  });

  test("パネルは3つの形を扱える", () => {
    // 本文の置き換え・食い違い・設定資料の更新
    const source = readFileSync("src/features/proposalPanel.ts", "utf-8");

    expect(source).toContain("ProposalViewItem");
    expect(source).toContain("ContradictionViewItem");
    expect(source).toContain("RecordUpdateViewItem");
  });

  test("形の違うものを同じ配列へ混ぜていない", () => {
    // **混ぜると、本文の適用処理が設定資料の更新を掴んで壊れる**
    const source = readFileSync("src/features/proposalPanel.ts", "utf-8");

    expect(source).toContain("private items:");
    expect(source).toContain("private contradictions:");
    expect(source).toContain("private recordUpdates:");
  });
});

describe("サイドバーの見出し", () => {
  const raw = JSON.parse(readFileSync("package.json", "utf-8")) as {
    displayName: string;
    contributes: {
      viewsContainers: { activitybar: Array<{ id: string; title: string }> };
    };
  };

  /**
   * **拡張機能の名前と、サイドバーの見出しを揃える。**
   *
   * 通知には `displayName`（「ソース: 統合小説執筆環境」）が出るのに、
   * サイドバーは「小説執筆」だった。同じものを指しているのに名前が
   * 2つあると、作者は別の機能だと思う（2026-08-21、作者の指摘）。
   */
  test("拡張機能の名前と同じ", () => {
    const container = raw.contributes.viewsContainers.activitybar[0];
    expect(container.title).toBe(raw.displayName);
    expect(container.title).toBe("統合小説執筆環境");
  });
});
