import { describe, expect, test, vi, beforeEach } from "vitest";

/**
 * 提案パネルの表示を切り替えたとき、前の中身が残らないこと。
 *
 * **実際に残っていた**（2026-08-21、作者が実機で発見）。設定資料の更新を
 * 表示したあとで誤字脱字を検知すると、見出しだけ「誤字脱字」に変わり、
 * 中身は前の更新のまま、件数も前のままだった。104件の指摘が1件も見えない。
 *
 * 描画は `recordUpdates` を最優先で出すのに、表示口5つのうち4つが
 * それを空にし忘れていた。**入れ物を増やしたときに書き忘れる形**なので、
 * 表示口ごとではなく「切り替えたら前のものが消える」ことを試す。
 */

const posted: Array<{ category: string; items: unknown[] }> = [];

vi.mock("vscode", () => {
  const noop = () => undefined;
  return {
    commands: { executeCommand: vi.fn() },
    window: {
      showWarningMessage: vi.fn(),
      showInformationMessage: vi.fn(),
      showErrorMessage: vi.fn(),
    },
    workspace: {
      getConfiguration: () => ({ get: (_k: string, d?: unknown) => d }),
      fs: { readFile: vi.fn(), writeFile: vi.fn(), createDirectory: vi.fn() },
    },
    Uri: { file: (p: string) => ({ fsPath: p }) },
    EventEmitter: class {
      event = () => ({ dispose: noop });
      fire = noop;
    },
    ThemeIcon: class {},
    ThemeColor: class {},
    MarkdownString: class {},
    Range: class {},
    Position: class {},
    ViewColumn: { One: 1 },
  };
});

import { ProposalPanel } from "../../src/features/proposalPanel";
import type { WorkEntry } from "../../src/models/types";

const work: WorkEntry = {
  id: "w1",
  title: "いじめられっ子",
  folderPath: "C:/小説/いじめられっ子",
  registeredAt: "2026-08-21T00:00:00.000Z",
};

/** `postMessage` を捕まえるだけの偽のビュー */
function fakeView() {
  return {
    webview: {
      options: {},
      html: "",
      cspSource: "vscode-webview:",
      onDidReceiveMessage: () => ({ dispose: () => undefined }),
      postMessage: (message: { category: string; items: unknown[] }) => {
        posted.push(message);
        return Promise.resolve(true);
      },
    },
    onDidDispose: () => ({ dispose: () => undefined }),
  };
}

function latest() {
  return posted[posted.length - 1];
}

function panelWithView() {
  const panel = new ProposalPanel();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  panel.resolveWebviewView(fakeView() as any);
  return panel;
}

const typo = {
  filePath: "C:/小説/いじめられっ子/本文/001.txt",
  chunkHash: "h1",
  line: 3,
  original: "彼は走つた",
  target: "走つた",
  suggestion: "走った",
  reason: "促音の誤り",
  confidence: "high" as const,
};

const recordUpdate = {
  id: "u1",
  name: "近所のおばあさん",
  changes: ["紹介", "　現在: 白髪の女性", "　更新案: 年配女性"],
  source: "紹介を変更",
  status: "pending" as const,
};

beforeEach(() => {
  posted.length = 0;
});

describe("表示を切り替えると、前の中身が消える", () => {
  test("設定資料の更新のあとに誤字脱字を出すと、誤字脱字が見える", () => {
    const panel = panelWithView();
    panel.showRecordUpdates(work, [recordUpdate], async () => ({ ok: true }));
    expect(latest().items).toHaveLength(1);

    panel.showResults(work, [typo]);

    // ここが壊れていた。見出しだけ変わって中身は更新のままだった
    expect(latest().category).toBe("誤字脱字");
    expect(latest().items).toHaveLength(1);
    expect(latest().items[0]).toMatchObject({ suggestion: "走った" });
  });

  test("誤字脱字のあとに設定資料の更新を出すと、更新が見える", () => {
    const panel = panelWithView();
    panel.showResults(work, [typo]);
    panel.showRecordUpdates(work, [recordUpdate], async () => ({ ok: true }));

    expect(latest().category).toBe("設定資料の更新");
    expect(latest().items).toHaveLength(1);
    expect(latest().items[0]).toMatchObject({ name: "近所のおばあさん" });
  });

  test("設定資料の更新のあとに矛盾を出すと、矛盾が見える", () => {
    const panel = panelWithView();
    panel.showRecordUpdates(work, [recordUpdate], async () => ({ ok: true }));
    panel.showContradictions(work, [
      {
        filePath: "C:/小説/いじめられっ子/本文/001.txt",
        chunkHash: "h1",
        line: 5,
        excerpt: "赤い髪",
        category: "人物",
        settingSays: "髪は黒",
        textSays: "赤い髪",
        note: "",
        confidence: "high",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
    ]);

    expect(latest().category).toBe("矛盾");
    expect(latest().items).toHaveLength(1);
    expect(latest().items[0]).toMatchObject({ settingSays: "髪は黒" });
  });

  test("結果が0件なら、前の中身を残さず0件と出す", () => {
    // 「前回の結果が残っている」と「今回0件だった」を取り違えさせない
    const panel = panelWithView();
    panel.showRecordUpdates(work, [recordUpdate], async () => ({ ok: true }));
    panel.showResults(work, []);

    expect(latest().category).toBe("誤字脱字");
    expect(latest().items).toEqual([]);
  });
});

describe("未処理が残っていることをタブに出す", () => {
  /**
   * **開いていないと残りに気づけない**（作者の指摘、2026-08-21）。
   * 提案パネルは下段にあり、他のタブへ切り替えると見えなくなる。
   *
   * **画面の件数とタブの印は、同じ数え方でなければならない。**
   * 別々に数えると、片方だけ直したときにずれる。
   */
  function badgeOf(panel: ProposalPanel): { value: number } | undefined {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (panel as any).view?.badge;
  }

  test("未処理があれば、その数が出る", () => {
    const panel = panelWithView();
    panel.showResults(work, [typo, { ...typo, line: 9 }]);
    expect(badgeOf(panel)?.value).toBe(2);
  });

  test("結果が0件なら、印を消す", () => {
    const panel = panelWithView();
    panel.showResults(work, [typo]);
    panel.showResults(work, []);
    expect(badgeOf(panel)).toBeUndefined();
  });

  test("設定資料の更新も数える", () => {
    const panel = panelWithView();
    panel.showRecordUpdates(work, [recordUpdate], async () => ({ ok: true }));
    expect(badgeOf(panel)?.value).toBe(1);
  });

  test("見出しの件数と、印の数が一致する", () => {
    // 別々に数えると、片方だけ直したときにずれる
    const panel = panelWithView();
    panel.showResults(work, [typo, { ...typo, line: 9 }, { ...typo, line: 12 }]);
    const items = latest().items as Array<{ status: string }>;
    const shown = items.filter(
      (i) => i.status === "pending" || i.status === "failed"
    ).length;
    expect(badgeOf(panel)?.value).toBe(shown);
  });
});
