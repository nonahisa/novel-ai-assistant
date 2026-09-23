import { describe, expect, test, vi, beforeEach } from "vitest";

/**
 * 「本文を見る」は、飛ぶ直前に引用を探し直す（作者の報告、2026-09-12）。
 *
 * 「推敲で一つ修正すると、該当行へ飛ぶ機能がずれました」。
 *
 * 指摘が持っている `line` は**検知したときの行番号**である。推敲は原文を
 * まるごと修正案へ置き換えるので、1件当てるだけで行の数が変わることがある
 * （複数行にまたがる「語尾単調」など）。一覧に残っている指摘は古い行番号を
 * 抱えたままなので、そこから先の指摘が全部ずれる。
 *
 * そこで、飛ぶ直前にいまのファイルを読み、**引用（`original` / `excerpt`）が
 * 実際に在る行**を探し直す。見つからなければ、これまでどおり記録された行へ
 * 飛ぶ（黙って落とさず、ログに1行残す）。
 */

/** 原稿エディタへ渡った行番号（素のエディタは開かせない） */
const asked: Array<{ filePath: string; line: number }> = [];

/**
 * 偽の本文。`undefined` なら「ファイルが読めなかった」ことにする。
 *
 * `vi.mock` の工場は読み込み時に走るが、ここを見るのは工場が作る関数の
 * **中身**なので、テストが動き出してから評価される
 */
let manuscript: string | undefined;

vi.mock("vscode", () => {
  const noop = () => undefined;
  return {
    commands: { executeCommand: vi.fn() },
    window: {
      showWarningMessage: vi.fn(() => Promise.resolve(undefined)),
      showInformationMessage: vi.fn(() => Promise.resolve(undefined)),
      showErrorMessage: vi.fn(),
      showTextDocument: vi.fn(() =>
        Promise.resolve({ selection: undefined, revealRange: noop })
      ),
      createOutputChannel: () => ({
        appendLine: noop,
        show: noop,
        dispose: noop,
      }),
    },
    workspace: {
      getConfiguration: () => ({ get: (_k: string, d?: unknown) => d }),
      fs: {
        readFile: vi.fn(() =>
          manuscript === undefined
            ? Promise.reject(new Error("開けませんでした"))
            : Promise.resolve(new TextEncoder().encode(manuscript))
        ),
        writeFile: vi.fn(),
        createDirectory: vi.fn(),
      },
      openTextDocument: vi.fn((uri: { fsPath: string }) =>
        Promise.resolve({
          uri,
          lineCount: 200,
          lineAt: (index: number) => ({ range: { start: index, end: index } }),
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
  registeredAt: "2026-09-12T00:00:00.000Z",
};

const filePath = "C:/小説/いじめられっ子/本文/003.txt";

/**
 * 1件当てたあとの本文。
 *
 * 推敲の1件目（元は3行目にあった2行の言い回し）を1行へまとめたので、
 * **それより後ろの行が1つずつ繰り上がっている**
 */
const afterApply = [
  "　朝の廊下は静かだった。", // 1
  "", // 2
  "　彼は足を速めて教室へ向かった。", // 3（2行を1行にまとめた跡）
  "", // 4
  "　彼女は振り返らなかった。", // 5（検知時は6行目だった）
  "",
  "　窓の外で鐘が鳴る。",
].join("\r\n");

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

function panelWithView(): ProposalPanel {
  const panel = new ProposalPanel(undefined, undefined, async (path, line) => {
    asked.push({ filePath: path, line });
    return true;
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  panel.resolveWebviewView(fakeView() as any);
  return panel;
}

/** 一覧の1件目を「本文を見る」で押したのと同じ */
async function jump(panel: ProposalPanel, id: string): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (panel as any).handleMessage({ type: "jump", id });
}

beforeEach(() => {
  asked.length = 0;
  manuscript = afterApply;
});

describe("飛ぶ直前に、いまの本文から引用を探し直す", () => {
  test("1件当てて行がずれたあと、次の指摘は引用の在る行へ飛ぶ", async () => {
    const panel = panelWithView();
    panel.showResults(work, [
      {
        filePath,
        chunkHash: "h1",
        // 検知したときは6行目。1件当てたので、いまは5行目にある
        line: 6,
        original: "　彼女は振り返らなかった。",
        target: "振り返らなかった",
        suggestion: "振り向かなかった",
        reason: "語尾単調",
        confidence: "high",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
    ]);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await jump(panel, (panel as any).items[0].id as string);

    expect(asked).toEqual([{ filePath, line: 5 }]);
  });

  test("引用が見つからなければ、記録された行へ飛ぶ", async () => {
    const panel = panelWithView();
    panel.showResults(work, [
      {
        filePath,
        chunkHash: "h2",
        line: 4,
        // 作者が手で書き直したあと。もう本文のどこにも無い
        original: "　誰も居ない廊下に足音が響いた。",
        target: "足音",
        suggestion: "靴音",
        reason: "冗長",
        confidence: "medium",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
    ]);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await jump(panel, (panel as any).items[0].id as string);

    expect(asked).toEqual([{ filePath, line: 4 }]);
  });

  test("本文が読めなければ、記録された行へ飛ぶ", async () => {
    manuscript = undefined;
    const panel = panelWithView();
    panel.showResults(work, [
      {
        filePath,
        chunkHash: "h3",
        line: 6,
        original: "　彼女は振り返らなかった。",
        target: "振り返らなかった",
        suggestion: "振り向かなかった",
        reason: "語尾単調",
        confidence: "high",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
    ]);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await jump(panel, (panel as any).items[0].id as string);

    expect(asked).toEqual([{ filePath, line: 6 }]);
  });

  /** 矛盾も同じ道を通す（引用は `excerpt` が持っている） */
  test("矛盾も、引用の在る行へ飛ぶ", async () => {
    const panel = panelWithView();
    panel.showContradictions(work, [
      {
        filePath,
        chunkHash: "h4",
        // 検知したときは8行目。1件当てたので、いまは7行目にある
        line: 8,
        excerpt: "　窓の外で鐘が鳴る。",
        category: "人物",
        settingSays: "鐘は鳴らない",
        textSays: "鐘が鳴っている",
        note: "設定と食い違う",
        confidence: "high",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
    ]);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const id = (panel as any).contradictions[0].id as string;
    await jump(panel, id);

    expect(asked).toEqual([{ filePath, line: 7 }]);
  });
});
