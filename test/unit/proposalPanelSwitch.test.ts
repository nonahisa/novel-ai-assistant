import { describe, expect, test, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";

/**
 * 提案パネルの中身の入れ替え。**逆向きの2つの決まりを、同時に守る。**
 *
 * ## 画面には、いま選んでいる分類のものだけを出す
 *
 * **混ざっていた**（2026-08-21、作者が実機で発見）。設定資料の更新を
 * 表示したあとで誤字脱字を検知すると、見出しだけ「誤字脱字」に変わり、
 * 中身は前の更新のまま、件数も前のままだった。104件の指摘が1件も見えない。
 * 描画は `recordUpdates` を最優先で出すのに、表示口5つのうち4つが
 * それを空にし忘れていた。
 *
 * ## それでも、他の分類の作業は消さない
 *
 * **消えていた**（2026-08-22、作者の指摘）。誤字脱字を1件ずつ見ている
 * 途中で推敲を実行すると、適用済み・見送り済みの判断も、まだ見ていない
 * 指摘も、すべて失われた。
 *
 * **「表示を差し替える」と「持っているものを捨てる」は別である。**
 * 分類ごとに置き場を持ち、出すのは1つだけにする（設計書6.11.3）。
 */

const posted: Array<{ category: string; items: unknown[] }> = [];
/** 通知に出た文言。**画面を奪わない代わりに、ここで届いたことを伝える** */
const notified: string[] = [];
/** その通知に作者が何と答えるか。既定は「答えない」（×で閉じたのと同じ） */
let notificationAnswer: string | undefined;
/** 警告に出た文言。再チェックがAI未設定を伝えているかを見る */
const warned: string[] = [];

vi.mock("vscode", () => {
  const noop = () => undefined;
  return {
    commands: { executeCommand: vi.fn() },
    window: {
      showWarningMessage: vi.fn((message: string) => {
        warned.push(message);
        return Promise.resolve(undefined);
      }),
      showInformationMessage: vi.fn((message: string) => {
        notified.push(message);
        return Promise.resolve(notificationAnswer);
      }),
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

/** もう1つの作品。**2作品で同時に検知を走らせられる**（2026-08-27） */
const other: WorkEntry = {
  ...work,
  id: "w2",
  title: "別の作品",
  folderPath: "C:/小説/別の作品",
};

const otherTypo = {
  ...typo,
  filePath: "C:/小説/別の作品/本文/001.txt",
  chunkHash: "h2",
  line: 4,
  original: "彼は歩つた",
  target: "歩つた",
  suggestion: "歩いた",
};

/** 作品の切り替え口を押したのと同じ（webviewからのメッセージ） */
function switchWork(panel: ProposalPanel, workId: string): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (panel as any).handleMessage({ type: "switchWork", workId });
}

beforeEach(() => {
  posted.length = 0;
  notified.length = 0;
  warned.length = 0;
  notificationAnswer = undefined;
});

describe("表示を切り替えると、前の中身が消える", () => {
  test("設定資料の更新のあとに誤字脱字を出すと、誤字脱字が見える", () => {
    const panel = panelWithView();
    panel.showRecordUpdates(work, [recordUpdate], async () => ({ ok: true }), async () => ({ ok: true }));
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
    panel.showRecordUpdates(work, [recordUpdate], async () => ({ ok: true }), async () => ({ ok: true }));

    expect(latest().category).toBe("設定資料の更新");
    expect(latest().items).toHaveLength(1);
    expect(latest().items[0]).toMatchObject({ name: "近所のおばあさん" });
  });

  test("設定資料の更新のあとに矛盾を出すと、矛盾が見える", () => {
    const panel = panelWithView();
    panel.showRecordUpdates(work, [recordUpdate], async () => ({ ok: true }), async () => ({ ok: true }));
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
    panel.showRecordUpdates(work, [recordUpdate], async () => ({ ok: true }), async () => ({ ok: true }));
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
  function badgeOf(
    panel: ProposalPanel
  ): { value: number; tooltip?: string } | undefined {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (panel as any).view?.badge;
  }

  test("未処理があれば、その数が出る", () => {
    const panel = panelWithView();
    panel.showResults(work, [typo, { ...typo, line: 9 }]);
    expect(badgeOf(panel)?.value).toBe(2);
  });

  test("何も無ければ、印は出さない", () => {
    const panel = panelWithView();
    panel.showResults(work, []);
    expect(badgeOf(panel)).toBeUndefined();
  });

  /**
   * **0件だったからといって、前の結果を消さない**（設計書6.11.3）。
   *
   * 話を絞って2回に分けて実行することがある。2回目が0件でも、
   * 1回目の指摘はまだ作者の手元にある。
   */
  test("同じ分類で0件が返っても、前の指摘は残る", () => {
    const panel = panelWithView();
    panel.showResults(work, [typo]);
    panel.showResults(work, []);
    expect(badgeOf(panel)?.value).toBe(1);
    expect(latest().items).toHaveLength(1);
  });

  /** 印には、どの分類に何件残っているかを書く（開くまで中身が見えないため） */
  test("印の説明に、分類ごとの内訳を出す", () => {
    const panel = panelWithView();
    panel.showResults(work, [typo]);
    panel.showResults(work, [{ ...typo, line: 9 }], "推敲");

    expect(badgeOf(panel)?.value).toBe(2);
    expect(badgeOf(panel)?.tooltip).toContain("誤字脱字 1件");
    expect(badgeOf(panel)?.tooltip).toContain("推敲 1件");
  });

  test("設定資料の更新も数える", () => {
    const panel = panelWithView();
    panel.showRecordUpdates(work, [recordUpdate], async () => ({ ok: true }), async () => ({ ok: true }));
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

/**
 * **他の検知を走らせても、それまでの作業が消えないこと**（設計書6.11.3）。
 *
 * 誤字脱字を1件ずつ見ている途中で推敲を実行すると、パネルの中身が丸ごと
 * 入れ替わり、**適用済み・見送り済みの判断も、まだ見ていない指摘も、
 * すべて失われていた**（2026-08-22、作者の指摘）。
 */
describe("分類ごとに分けて持つ", () => {
  /** 画面の中身を触らずに、分類を切り替える（作者がタブを押したのと同じ） */
  function selectCategory(panel: ProposalPanel, category: string): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (panel as any).handleMessage({ type: "selectCategory", category });
  }

  test("推敲を出しても、誤字脱字は残っている", () => {
    const panel = panelWithView();
    panel.showResults(work, [typo]);
    panel.showResults(work, [{ ...typo, line: 20, reason: "冗長" }], "推敲");

    expect(latest().category).toBe("推敲");
    expect(latest().items).toHaveLength(1);

    selectCategory(panel, "誤字脱字");
    expect(latest().category).toBe("誤字脱字");
    expect(latest().items).toHaveLength(1);
    expect(latest().items[0]).toMatchObject({ suggestion: "走った" });
  });

  test("分類のタブに、残りの件数を添えて並べる", () => {
    const panel = panelWithView();
    panel.showResults(work, [typo]);
    panel.showResults(work, [{ ...typo, line: 20 }, { ...typo, line: 21 }], "推敲");

    const tabs = (latest() as unknown as { categories: Array<{ name: string; remaining: number; active: boolean }> })
      .categories;
    expect(tabs.map((t) => t.name)).toEqual(["誤字脱字", "推敲"]);
    expect(tabs.find((t) => t.name === "誤字脱字")?.remaining).toBe(1);
    expect(tabs.find((t) => t.name === "推敲")?.active).toBe(true);
  });

  test("分類が1つだけなら、タブは出さない", () => {
    // 選ぶものが無いのに場所だけ取ると、下段の狭い画面がさらに狭くなる
    const panel = panelWithView();
    panel.showResults(work, [typo]);
    expect(
      (latest() as unknown as { categories: unknown[] }).categories
    ).toEqual([]);
  });

  /**
   * **作者が決めたものを、`pending` へ戻さない。**
   * 戻すと、同じ直しをもう一度当てにいくことになる。
   */
  test("同じ分類をもう一度走らせても、済んだ判断は残る", () => {
    const panel = panelWithView();
    panel.showResults(work, [typo]);
    // 1件目を見送った状態にする
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (panel as any).items[0].status = "dismissed";

    panel.showResults(work, [typo, { ...typo, line: 9 }]);

    const items = latest().items as Array<{ status: string; line: number }>;
    expect(items).toHaveLength(2);
    expect(items.find((i) => i.line === 3)?.status).toBe("dismissed");
    expect(items.find((i) => i.line === 9)?.status).toBe("pending");
  });

  test("別の作品の結果が来ても、タブは表示中の作品のものだけ", () => {
    // **分類の段は作品ごとに分かれている。** 別の作品で推敲を走らせても、
    // いま見ている作品のタブに「推敲」が現れてはいけない（中身は別の作品）
    const panel = panelWithView();
    panel.showResults(work, [typo]);
    panel.showResults(other, [otherTypo], "推敲");

    expect(latest().category).toBe("誤字脱字");
    expect(
      (latest() as unknown as { categories: unknown[] }).categories
    ).toEqual([]);

    switchWork(panel, "w2");
    expect(latest().category).toBe("推敲");
    expect(latest().items).toHaveLength(1);
  });
});

/**
 * **2つの作品で同時に検知を走らせられる**（設計書6.11.3）。
 *
 * 誤字脱字を2作品で走らせると、**提案を1件ずつ確認している最中に、
 * あとから届いたほうへ画面が切り替わった**（2026-08-27、作者の指摘）。
 * そのとき、見ていた作品の指摘は判断ごと捨てられていた。
 *
 * 捨てていた理由は「作品が変われば前の指摘は開けない」だったが、誤りだった。
 * 指摘はファイルの絶対パスを持っているので、前の作品のファイルも開ける。
 *
 * **届いた結果は、その作品の段へ入れるだけにする。** 画面を移すかどうかは
 * 作者が決める（通知の「表示する」か、画面の切り替え口）。
 */
describe("作品ごとに分けて持つ", () => {
  /** 通知の返事を待つ（`offerToShow` は答えを待たずに戻るため） */
  async function settle(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  test("別の作品の結果が届いても、見ている作品の指摘は消えない", () => {
    const panel = panelWithView();
    panel.showResults(work, [typo, { ...typo, line: 9 }]);
    // 1件目を見送った状態にする（**判断済みのものも失われないこと**）
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (panel as any).items[0].status = "dismissed";

    panel.showResults(other, [otherTypo]);

    // 画面は奪われない
    expect(latest().workTitle).toBe("いじめられっ子");
    expect(latest().category).toBe("誤字脱字");

    const items = latest().items as Array<{ status: string; line: number }>;
    expect(items).toHaveLength(2);
    expect(items.find((i) => i.line === 3)?.status).toBe("dismissed");
    expect(items.find((i) => i.line === 9)?.status).toBe("pending");
  });

  test("届いたことは、通知で伝える", () => {
    // 黙って溜めると、走らせたことを作者が忘れる
    const panel = panelWithView();
    panel.showResults(work, [typo]);
    panel.showResults(other, [otherTypo]);

    expect(notified).toHaveLength(1);
    expect(notified[0]).toContain("別の作品");
    expect(notified[0]).toContain("誤字脱字");
    expect(notified[0]).toContain("1件");
  });

  test("表示を切り替えると、届いていた別の作品の指摘が出る", () => {
    const panel = panelWithView();
    panel.showResults(work, [typo]);
    panel.showResults(other, [otherTypo]);

    switchWork(panel, "w2");

    expect(latest().workTitle).toBe("別の作品");
    expect(latest().items).toHaveLength(1);
    expect(latest().items[0]).toMatchObject({ suggestion: "歩いた" });
  });

  test("切り替えて戻ると、判断の途中経過が残っている", () => {
    const panel = panelWithView();
    panel.showResults(work, [typo, { ...typo, line: 9 }]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (panel as any).items[0].status = "applied";
    panel.showResults(other, [otherTypo]);

    switchWork(panel, "w2");
    switchWork(panel, "w1");

    expect(latest().workTitle).toBe("いじめられっ子");
    const items = latest().items as Array<{ status: string; line: number }>;
    expect(items.find((i) => i.line === 3)?.status).toBe("applied");
    expect(items.find((i) => i.line === 9)?.status).toBe("pending");
  });

  test("戻ったとき、直近に見ていた分類から見せる", () => {
    const panel = panelWithView();
    panel.showResults(work, [typo]);
    panel.showResults(work, [{ ...typo, line: 20 }], "推敲");
    // 誤字脱字へ戻してから、別の作品を見に行く
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (panel as any).handleMessage({
      type: "selectCategory",
      category: "誤字脱字",
    });
    panel.showResults(other, [otherTypo]);

    switchWork(panel, "w2");
    switchWork(panel, "w1");

    expect(latest().category).toBe("誤字脱字");
  });

  test("通知で「表示する」を選ぶと、その作品へ移る", async () => {
    notificationAnswer = "表示する";
    const panel = panelWithView();
    panel.showResults(work, [typo]);
    panel.showResults(other, [otherTypo]);

    // 押されるまでは、画面は元の作品のまま
    expect(latest().workTitle).toBe("いじめられっ子");
    await settle();

    expect(latest().workTitle).toBe("別の作品");
    expect(latest().items).toHaveLength(1);
  });

  test("切り替え口は、作品が2つ以上のときだけ出す", () => {
    const panel = panelWithView();
    panel.showResults(work, [typo]);
    expect((latest() as unknown as { works: unknown[] }).works).toEqual([]);

    panel.showResults(other, [otherTypo, { ...otherTypo, line: 9 }]);

    const works = (
      latest() as unknown as {
        works: Array<{
          id: string;
          title: string;
          remaining: number;
          active: boolean;
        }>;
      }
    ).works;
    expect(works.map((entry) => entry.id)).toEqual(["w1", "w2"]);
    expect(works.find((entry) => entry.id === "w1")?.active).toBe(true);
    expect(works.find((entry) => entry.id === "w2")?.remaining).toBe(2);
  });

  /** 同じ作品での「消さずに足す」は、これまでどおり */
  test("同じ作品の別分類は、これまでどおり足していく", () => {
    const panel = panelWithView();
    panel.showResults(work, [typo]);
    panel.showResults(other, [otherTypo]);
    panel.showResults(work, [{ ...typo, line: 20 }], "推敲");

    const tabs = (
      latest() as unknown as { categories: Array<{ name: string }> }
    ).categories;
    expect(tabs.map((tab) => tab.name)).toEqual(["誤字脱字", "推敲"]);
    expect(latest().workTitle).toBe("いじめられっ子");
  });
});

/**
 * 画面側の切り替え口（WebViewを要するので、その道が残っているかを見る）。
 */
describe("作品の切り替え口", () => {
  const html = () => readFileSync("src/views/proposalPanelHtml.ts", "utf-8");

  test("選ぶと、切り替えを送る道がある", () => {
    expect(html()).toContain("switchWork");
  });

  test("1作品のときは出さない", () => {
    expect(html()).toContain("works.length < 2");
  });
});

/**
 * 指摘の再チェック（P-23）。
 *
 * 作者の依頼（2026-08-27）：「なおし方を作者が決める系のものは『再チェック』
 * ボタンを追加してください」「誤字脱字の提案パネルでも、違うそうじゃないと
 * いう提案がきます。手書きで書き直して解消したか確認したいです」。
 *
 * **どこに出して、どこに出さないか**だけをここで押さえる。中身の判定は
 * `recheckProposal.test.ts` にある。
 */
describe("再チェックの出し分け", () => {
  test("誤字脱字の指摘には出す", () => {
    const panel = panelWithView();
    panel.showResults(work, [typo]);
    expect(latest().items[0]).toMatchObject({ canRecheck: true });
  });

  /** **修正案が無い指摘こそ、この機能の出発点。** 直し方は作者が決める */
  test("推敲の指摘には、修正案が無くても出す", () => {
    const panel = panelWithView();
    panel.showResults(work, [{ ...typo, suggestion: "", reason: "長文" }], "推敲");
    expect(latest().items[0]).toMatchObject({ canRecheck: true });
  });

  /**
   * **編集部からの提案には出さない**（設計書5.6）。
   * あちらは承認・却下という別の片付け方を持っており、結果を提案の側へ
   * 書き戻す必要もある。
   */
  test("編集部からの提案には出さない", () => {
    const panel = panelWithView();
    panel.showProposals(work, [
      {
        id: "e1",
        filePath: "本文/001.txt",
        fileName: "001.txt",
        chunkHash: "",
        line: 3,
        original: "彼は走つた",
        target: "走つた",
        suggestion: "走った",
        reason: "促音の誤り",
        confidence: "high",
        status: "pending",
        proposalId: "p1",
      },
    ]);
    expect(latest().items[0]).toMatchObject({ canRecheck: false });
  });

  /**
   * **AIが無ければ、黙って何もしないをやめる。**
   * 押したのに無反応だと「壊れている」としか見えない。
   */
  test("AIが設定されていなければ、その旨を伝える", async () => {
    const panel = panelWithView();
    panel.showResults(work, [typo]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const id = (panel as any).items[0].id as string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (panel as any).handleMessage({ type: "recheck", id });

    expect(warned[0]).toContain("AIが設定されていません");
    // 指摘には手を付けない
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((panel as any).items[0].status).toBe("pending");
  });
});

/**
 * 推敲の指摘に添える説明（設計書6.11.4）。
 *
 * **適用ボタンの上の文が、その上の差分と同じ文だった**（2026-08-22、
 * 作者の指摘）。誤字脱字は直す語が行の一部なので、行まるごとを添えると
 * 前後が分かって役に立つ。**推敲は一文まるごとが対象**なので、同じ文が
 * 2度並ぶだけだった。
 *
 * 出す言葉も「冗長」の一語しか無く、何と何の話なのか分からなかった。
 */
describe("推敲の説明", () => {
  const proofread = {
    filePath: "C:/小説/いじめられっ子/本文/001.txt",
    chunkHash: "h1",
    line: 12,
    // 推敲は一文まるごとが対象。original と target が同じになる
    original: "彼はまず最初に扉を開けた。",
    target: "彼はまず最初に扉を開けた。",
    suggestion: "彼はまず扉を開けた。",
    reason: "冗長",
    confidence: "medium" as const,
  };

  function detailOf(): string | undefined {
    return (latest().items[0] as { detail?: string }).detail;
  }

  test("AIの説明があれば、それを出す", () => {
    const panel = panelWithView();
    panel.showResults(
      work,
      [{ ...proofread, explanation: "「まず」と「最初に」が同じ意味です" }],
      "推敲"
    );
    expect(detailOf()).toBe("「まず」と「最初に」が同じ意味です");
  });

  /** **AIが説明を返さなかったから何も出ない、を作らない** */
  test("説明が無ければ、種類ごとの決まり文句を出す", () => {
    const panel = panelWithView();
    panel.showResults(work, [proofread], "推敲");
    expect(detailOf()).toBe("同じ意味の言葉が重なっています");
  });

  test("種類の名前をなぞっただけの説明は使わない", () => {
    const panel = panelWithView();
    panel.showResults(work, [{ ...proofread, explanation: "冗長" }], "推敲");
    expect(detailOf()).toBe("同じ意味の言葉が重なっています");
  });

  test("中身の無い言い方も使わない", () => {
    // 指示の言葉がそのまま返ってくる形は、この作品で繰り返し起きている
    const panel = panelWithView();
    panel.showResults(work, [{ ...proofread, explanation: "なし" }], "推敲");
    expect(detailOf()).toBe("同じ意味の言葉が重なっています");
  });

  test("残りの種類にも言葉がある", () => {
    // 1.5で漢字ひらき・語尾単調を足して6種類になった（設計書6.30）。
    // **札が増えたのに決まり文句を足し忘れると、その種類だけ説明が消える**
    const panel = panelWithView();
    for (const [reason, expected] of [
      ["係り受け", "どこに掛かるかが2通りに読めます"],
      ["同語反復", "近いところで同じ語が繰り返され、単調になっています"],
      ["長文", "一文が長く、意味を取りにくくなっています"],
      [
        "漢字ひらき",
        "読みに詰まる漢字表記です。ひらがなにすると読みやすくなります" +
          "（ひらくかどうかは作者の判断が優先です）",
      ],
      [
        "語尾単調",
        "同じ語尾が続いてリズムが単調です。どう散らすかは作者の判断です",
      ],
    ]) {
      panel.showResults(work, [{ ...proofread, reason }], "推敲");
      expect(detailOf(), reason).toBe(expected);
    }
  });

  /** 誤字脱字の `reason` は説明そのものなので、足すものは無い */
  test("誤字脱字には、余計な説明を足さない", () => {
    const panel = panelWithView();
    panel.showResults(work, [typo]);
    expect(detailOf()).toBeUndefined();
  });
});

/**
 * 設定資料の更新の「見送る」（作者の報告、2026-08-28「押せません」）。
 *
 * dismissIssue が矛盾→誤字脱字の順にしか探さず、設定資料の更新は
 * **素通りして黙って何もしなかった**。見送り＝承認待ちから片付ける、を
 * 反映と同じ形（呼び出し側の処理）で通す。
 */
describe("設定資料の更新の「見送る」", () => {
  test("見送ると、片付け処理が呼ばれて「見送り」の印が付く", async () => {
    const panel = panelWithView();
    const discarded: string[] = [];
    // 定数を共有すると、印の書き換えが次のテストへ漏れる。コピーを渡す
    panel.showRecordUpdates(
      work,
      [{ ...recordUpdate }],
      async () => ({ ok: true }),
      async (id) => {
        discarded.push(id);
        return { ok: true };
      }
    );

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (panel as any).handleMessage({ type: "dismiss", id: "u1" });

    expect(discarded).toEqual(["u1"]);
    const items = latest().items as Array<{ id: string; status: string }>;
    expect(items.find((item) => item.id === "u1")?.status).toBe("dismissed");
  });

  test("片付けに失敗したら、指摘は消えずに理由が出る", async () => {
    const panel = panelWithView();
    panel.showRecordUpdates(
      work,
      [{ ...recordUpdate }],
      async () => ({ ok: true }),
      async () => ({ ok: false, reason: "書き込めませんでした。" })
    );

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (panel as any).handleMessage({ type: "dismiss", id: "u1" });

    const items = latest().items as Array<{
      id: string;
      status: string;
      statusDetail?: string;
    }>;
    const item = items.find((entry) => entry.id === "u1");
    expect(item?.status).toBe("failed");
    expect(item?.statusDetail).toBe("書き込めませんでした。");
  });

  test("反映は従来どおり動く（見送りを足しても壊れていない）", async () => {
    const panel = panelWithView();
    const applied: string[] = [];
    panel.showRecordUpdates(
      work,
      [{ ...recordUpdate }],
      async (id) => {
        applied.push(id);
        return { ok: true };
      },
      async () => ({ ok: true })
    );

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (panel as any).handleMessage({ type: "apply", id: "u1" });

    expect(applied).toEqual(["u1"]);
    const items = latest().items as Array<{ id: string; status: string }>;
    expect(items.find((item) => item.id === "u1")?.status).toBe("applied");
  });
});
