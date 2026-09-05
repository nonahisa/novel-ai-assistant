import { describe, expect, test, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";

/**
 * 検知の進み具合を、提案パネルに出す（作者の報告、2026-08-29）。
 *
 * 「下に動いているときのチャンク数がでないですね」——相談から誤字脱字を
 * 実行し、結果が出る下段の提案パネルを見て待っていたが、そこには
 * 何も出なかった。進み具合は右下の通知（ステータスバー）にしか無く、
 * **作者が見ているのは結果が出る場所である。**
 *
 * ## いちばん困る形
 *
 * **取り消したあとに「3/12」が残ること。** まだ走っているように見えて、
 * いつまで待てばよいのか分からなくなる。結果（`issues`）が届けば画面側が
 * 消すが、中止・失敗のときは結果が来ない。そこで `runningDone` を
 * 呼び出し側の `finally` から必ず通す。
 */

/** 画面へ送られたもの（issues も running も同じ口を通る） */
const posted: Array<Record<string, unknown>> = [];

vi.mock("vscode", () => {
  const noop = () => undefined;
  return {
    commands: { executeCommand: vi.fn() },
    window: {
      showWarningMessage: vi.fn(() => Promise.resolve(undefined)),
      showInformationMessage: vi.fn(() => Promise.resolve(undefined)),
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
  registeredAt: "2026-08-29T00:00:00.000Z",
};

const other: WorkEntry = {
  ...work,
  id: "w2",
  title: "別の作品",
  folderPath: "C:/小説/別の作品",
};

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

function fakeView() {
  return {
    webview: {
      options: {},
      html: "",
      cspSource: "vscode-webview:",
      onDidReceiveMessage: () => ({ dispose: () => undefined }),
      postMessage: (message: Record<string, unknown>) => {
        posted.push(message);
        return Promise.resolve(true);
      },
    },
    onDidDispose: () => ({ dispose: () => undefined }),
  };
}

function panelWithView(): ProposalPanel {
  const panel = new ProposalPanel();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  panel.resolveWebviewView(fakeView() as any);
  return panel;
}

/** 送られたもののうち、進み具合に関するものだけ */
function runningPosts(): Array<Record<string, unknown>> {
  return posted.filter(
    (message) => message.type === "running" || message.type === "runningDone"
  );
}

beforeEach(() => {
  posted.length = 0;
});

describe("進み具合を送る", () => {
  test("走っている間、チャンク数を送る", () => {
    const panel = panelWithView();
    panel.showRunning(work, "誤字脱字を検知", 3, 12);

    expect(runningPosts()).toEqual([
      {
        type: "running",
        label: "誤字脱字を検知",
        done: 3,
        total: 12,
        unit: "チャンク",
        // いま見ている作品の検知なので、題名は要らない
        workTitle: "",
      },
    ]);
  });

  /** 話ごとに送る検知（プロット逸脱）は、チャンクではなく話を数えている */
  test("数えている単位を添えられる", () => {
    const panel = panelWithView();
    panel.showRunning(work, "プロット逸脱を検知", 2, 19, "話");

    expect(runningPosts()[0]).toMatchObject({ total: 19, unit: "話" });
  });

  /**
   * **別の作品の進みも、作品名を添えて出す。**
   *
   * 書庫では、作品Aの結果を読みながら作品Bを検知できる。以前は
   * 「見えている件数と関係のない数が動くと分からなくなる」として捨てて
   * いたが、そのせいで**2作品目では進みが一切出なかった**（作者の報告
   * 「下に動いているときのチャンク数がでない」が、1作品目でしか直って
   * いなかった）。作品名があれば、何の数字かはすぐ分かる。
   */
  test("表示中と違う作品の進みは、作品名を添えて出す", () => {
    const panel = panelWithView();
    panel.showResults(work, [typo]);
    posted.length = 0;

    panel.showRunning(other, "誤字脱字を検知", 1, 5);

    expect(runningPosts()).toEqual([
      {
        type: "running",
        label: "誤字脱字を検知",
        done: 1,
        total: 5,
        unit: "チャンク",
        workTitle: "別の作品",
      },
    ]);
  });

  /** 1回目の検知では、まだ何も出ていない（ここで弾くと初回だけ出ない） */
  test("まだ何も出していないときは、そのまま出す", () => {
    const panel = panelWithView();
    panel.showRunning(work, "誤字脱字を検知", 1, 5);

    expect(runningPosts()).toHaveLength(1);
  });

  test("パネルを開いていなければ、送らない（落ちない）", () => {
    const panel = new ProposalPanel();
    expect(() => panel.showRunning(work, "誤字脱字を検知", 1, 5)).not.toThrow();
    expect(runningPosts()).toEqual([]);
  });
});

describe("進み具合を消す", () => {
  /** **これが最悪の形。** 取り消したのに「3/12」が残る */
  test("finishRunning で、消す合図を送る", () => {
    const panel = panelWithView();
    panel.showRunning(work, "誤字脱字を検知", 3, 12);
    panel.finishRunning();

    expect(runningPosts().map((message) => message.type)).toEqual([
      "running",
      "runningDone",
    ]);
  });

  /**
   * 結果が届いたときは、`issues` が消す（画面側）。
   * ここでは**結果が必ず届くこと**だけを確かめる（消すのは webview の役目）。
   */
  test("結果が届けば、issues が後から来る", () => {
    const panel = panelWithView();
    // 開いた時点で一度 issues が出ている（既にある結果を映すため）。数えない
    posted.length = 0;
    panel.showRunning(work, "誤字脱字を検知", 12, 12);
    panel.showResults(work, [typo]);

    const types = posted.map((message) => message.type);
    expect(types[0]).toBe("running");
    expect(types).toContain("issues");
    expect(types.lastIndexOf("issues")).toBeGreaterThan(types.indexOf("running"));
  });
});

/**
 * 画面側（WebViewを要するので、その道が残っているかを文字列で見る）。
 */
describe("画面の出し分け", () => {
  const html = readFileSync("src/views/proposalPanelHtml.ts", "utf8");

  test("進み具合の報せを受ける道がある", () => {
    expect(html).toContain("message.type === 'running'");
    expect(html).toContain("message.type === 'runningDone'");
  });

  test("「◯◯しています… 3/12チャンク」の形で出す", () => {
    expect(html).toContain("'しています… '");
  });

  test("別の作品なら、題名を頭に付ける", () => {
    // 「〈別の作品〉誤字脱字を検知しています… 1/5チャンク」
    expect(html).toContain("runningState.workTitle");
  });

  /**
   * 0件のときの案内は、どの分類でも同じものが出る（実機確認 2026-09-05）。
   *
   * 以前は「誤字脱字を検知」「表記ゆれを検知」の2つだけを挙げていたため、
   * 矛盾検知を走らせて0件だった作者に、別の機能を勧めているように読めた。
   */
  test("0件の案内に、特定の分類の名前を書かない", () => {
    const empty = html.slice(html.indexOf('<div id="empty">'));
    const line = empty.slice(0, empty.indexOf("</div>"));
    for (const name of [
      "誤字脱字を検知",
      "表記ゆれを検知",
      "推敲",
      "矛盾を検知",
      "プロット逸脱",
    ]) {
      expect(line, name).not.toContain(name);
    }
    expect(line).toContain("この分類の検知");
  });

  /** 一覧が空のときは中央、出ているときは見出しの横（読む場所を奪わない） */
  test("一覧が空かどうかで、出す場所を変える", () => {
    expect(html).toContain("lastItemCount === 0");
    expect(html).toContain("runningEl.textContent = text");
  });

  test("結果が届いたら、進み具合を消す", () => {
    // 走り終えているのに数字が残ると、まだ動いているように見える
    const issuesBranch = html.slice(html.indexOf("message.type === 'issues'"));
    expect(issuesBranch).toContain("runningState = null");
  });
});

/**
 * 配線（`extension.ts`）。
 *
 * **中止・失敗でも必ず消す**ことを、ここで固める。結果が届かない道が
 * あるので、画面側の「結果が来たら消す」だけでは足りない。
 */
describe("検知への配線", () => {
  const source = readFileSync("src/extension.ts", "utf8");

  test("消すのは finally に置く", () => {
    expect(source).toMatch(/finally \{\s*proposalPanel\.finishRunning\(\);/);
  });

  test("検知はすべて、進み具合を通してから呼ぶ", () => {
    // 直に呼ぶ道が残っていると、その機能だけ進みが出ない
    for (const name of [
      "checkTypos",
      "checkProofread",
      "checkContradictions",
      "checkDeviations",
      "checkForeshadows",
      "checkForeshadowResolution",
    ]) {
      expect(source, name).not.toContain(`await ${name}(`);
    }
  });
});
