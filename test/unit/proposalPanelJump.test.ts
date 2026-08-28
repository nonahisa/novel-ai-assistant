import { describe, expect, test, vi, beforeEach } from "vitest";

/**
 * 提案パネルの「飛ぶ」（作者の依頼、2026-08-28）。
 *
 * 「誤字脱字から開く場合は、現在メインで開いているエディターと同じ
 * エディターで開いたうえで場所を示してください」。
 *
 * これまでは必ず素のテキストエディタを開いていたので、**縦書きの原稿エディタで
 * 書いていた作者は、飛ぶたびに別の画面へ追い出されていた。**
 *
 * ただし**素のエディタで書いている人まで縦書きへ移してはいけない。**
 * どちらで書いているかを知っているのは原稿エディタ側なので、
 * 判断ごと外へ出し（`revealInManuscript`）、**引き受けられたときだけ**
 * そちらに任せる。断られたら、これまでどおり素のエディタで開く。
 */

/** 素のエディタで開かれたファイル */
const openedPlain: string[] = [];

vi.mock("vscode", () => {
  const noop = () => undefined;
  return {
    commands: { executeCommand: vi.fn() },
    window: {
      showWarningMessage: vi.fn(() => Promise.resolve(undefined)),
      showInformationMessage: vi.fn(() => Promise.resolve(undefined)),
      showErrorMessage: vi.fn(),
      showTextDocument: vi.fn((doc: { uri: { fsPath: string } }) => {
        openedPlain.push(doc.uri.fsPath);
        return Promise.resolve({
          selection: undefined,
          revealRange: noop,
        });
      }),
      // **黙って終わる枝を無くした**（作者の報告、2026-08-29）。
      // 原稿エディタ側で転んだ理由をログへ残すので、書き込み先が要る
      createOutputChannel: () => ({
        appendLine: noop,
        show: noop,
        dispose: noop,
      }),
    },
    workspace: {
      getConfiguration: () => ({ get: (_k: string, d?: unknown) => d }),
      fs: { readFile: vi.fn(), writeFile: vi.fn(), createDirectory: vi.fn() },
      openTextDocument: vi.fn((filePath: string) =>
        Promise.resolve({
          uri: { fsPath: filePath },
          lineCount: 50,
          lineAt: (index: number) => ({
            range: { start: index, end: index },
          }),
        })
      ),
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
    Selection: class {},
    TextEditorRevealType: { InCenter: 2 },
    ViewColumn: { One: 1 },
  };
});

import { ProposalPanel } from "../../src/features/proposalPanel";
import type { WorkEntry } from "../../src/models/types";

const work: WorkEntry = {
  id: "w1",
  title: "いじめられっ子",
  folderPath: "C:/小説/いじめられっ子",
  registeredAt: "2026-08-28T00:00:00.000Z",
};

const typo = {
  filePath: "C:/小説/いじめられっ子/本文/003.txt",
  chunkHash: "h1",
  line: 12,
  original: "彼は走つた",
  target: "走つた",
  suggestion: "走った",
  reason: "促音の誤り",
  confidence: "high" as const,
};

/** `postMessage` を捨てるだけの偽のビュー */
function fakeView() {
  return {
    webview: {
      options: {},
      html: "",
      cspSource: "vscode-webview:",
      onDidReceiveMessage: () => ({ dispose: () => undefined }),
      postMessage: () => Promise.resolve(true),
    },
    onDidDispose: () => ({ dispose: () => undefined }),
  };
}

function panelWith(
  reveal?: (filePath: string, line: number) => Promise<boolean>
): ProposalPanel {
  const panel = new ProposalPanel(undefined, undefined, reveal);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  panel.resolveWebviewView(fakeView() as any);
  panel.showResults(work, [typo]);
  return panel;
}

/** 一覧の1件目を「飛ぶ」で押したのと同じ */
async function jumpFirst(panel: ProposalPanel): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const id = (panel as any).items[0].id as string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (panel as any).handleMessage({ type: "jump", id });
}

beforeEach(() => {
  openedPlain.length = 0;
});

describe("原稿エディタで書いているときは、その画面で示す", () => {
  test("引き受けられたら、素のエディタは開かない", async () => {
    const asked: Array<{ filePath: string; line: number }> = [];
    const panel = panelWith(async (filePath, line) => {
      asked.push({ filePath, line });
      return true;
    });

    await jumpFirst(panel);

    expect(asked).toEqual([
      { filePath: "C:/小説/いじめられっ子/本文/003.txt", line: 12 },
    ]);
    expect(openedPlain).toEqual([]);
  });

  /** 素のエディタで書いている作者を、勝手に縦書きの画面へ移さない */
  test("断られたら、これまでどおり素のエディタで開く", async () => {
    const panel = panelWith(async () => false);

    await jumpFirst(panel);

    expect(openedPlain).toEqual(["C:/小説/いじめられっ子/本文/003.txt"]);
  });

  /** 口が渡されていない場面（試験・古い配線）でも、飛べる道は残る */
  test("口が無ければ、これまでどおり素のエディタで開く", async () => {
    const panel = panelWith(undefined);

    await jumpFirst(panel);

    expect(openedPlain).toEqual(["C:/小説/いじめられっ子/本文/003.txt"]);
  });

  /** **原稿エディタ側で転んでも、飛べなくならない** */
  test("原稿エディタ側が失敗しても、素のエディタで開く", async () => {
    const panel = panelWith(async () => {
      throw new Error("開けませんでした");
    });

    await jumpFirst(panel);

    expect(openedPlain).toEqual(["C:/小説/いじめられっ子/本文/003.txt"]);
  });
});
