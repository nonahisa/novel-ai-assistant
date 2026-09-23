import { beforeEach, describe, expect, test, vi } from "vitest";
import { readFileSync } from "node:fs";

/**
 * **提案パネルを、エディターの右の列に開く**（作者の指示、2026-09-23）。
 *
 * 「提案パネルは右側のメモを基準とし、下の提案等は混乱しそうなので
 * 最小化しましょう」。あわせて、ノートPCの実機（0.76.1）で2回報告された
 * 押し間違い——右下の通知（「結果が届きました［表示する］」）を押そうと
 * したら通知が先に消え、同じ位置にあった［まとめて適用］を押しかけた——
 * を塞ぐ。
 *
 * ## 直す前
 *
 * - 提案パネルは**下段**（出力・ターミナルと同じ領域）の `WebviewView` だけ
 * - 結果が届くと `novelai.proposalsView.focus` で下段を前へ出していた
 * - ［まとめて適用］はツールバーの**右の端**（`margin-left: auto` の後ろ）。
 *   下段では、そこが通知の真下に来る
 *
 * ## 直したあと
 *
 * - シーンメモと同じく `ViewColumn.Beside` に `WebviewPanel` で開く。
 *   シーンメモが開いていれば、その列へ重ねる
 * - 下段は設定で出したときだけ（既定では出さない。消してはいない）
 * - ［まとめて適用］は見出しと件数のすぐ後ろ（左寄り）
 */

type Created = {
  viewType: string;
  title: string;
  showOptions: { viewColumn: number; preserveFocus?: boolean };
  options: { enableScripts?: boolean; retainContextWhenHidden?: boolean };
  panel: FakePanel;
};

class FakePanel {
  title = "";
  active = false;
  viewColumn = 2;
  revealed: Array<{ column: number | undefined; preserveFocus: boolean | undefined }> = [];
  posted: Array<{ type: string }> = [];
  private disposeHandlers: Array<() => void> = [];
  webview = {
    html: "",
    cspSource: "vscode-webview:",
    onDidReceiveMessage: () => ({ dispose: () => undefined }),
    postMessage: (message: { type: string }) => {
      this.posted.push(message);
      return Promise.resolve(true);
    },
  };
  reveal(column?: number, preserveFocus?: boolean): void {
    this.revealed.push({ column, preserveFocus });
  }
  onDidDispose(handler: () => void) {
    this.disposeHandlers.push(handler);
    return { dispose: () => undefined };
  }
  dispose(): void {
    for (const handler of this.disposeHandlers) handler();
  }
}

const created: Created[] = [];
const commands: Array<{ command: string; args: unknown[] }> = [];
/** 開いている列とタブ（シーンメモがどこにあるか） */
let tabGroups: Array<{ viewColumn: number; tabs: Array<{ input: unknown }> }> = [];

vi.mock("vscode", () => {
  const noop = () => undefined;
  class TabInputWebview {
    constructor(public readonly viewType: string) {}
  }
  class TabInputText {
    constructor(public readonly uri: unknown) {}
  }
  class TabInputCustom {
    constructor(public readonly uri: unknown) {}
  }
  class TabInputNotebook {
    constructor(public readonly uri: unknown) {}
  }
  return {
    commands: {
      executeCommand: vi.fn((command: string, ...args: unknown[]) => {
        commands.push({ command, args });
        return Promise.resolve(undefined);
      }),
    },
    window: {
      createWebviewPanel: vi.fn(
        (
          viewType: string,
          title: string,
          showOptions: Created["showOptions"],
          options: Created["options"]
        ) => {
          const panel = new FakePanel();
          panel.title = title;
          panel.viewColumn = showOptions.viewColumn > 0 ? showOptions.viewColumn : 2;
          created.push({ viewType, title, showOptions, options, panel });
          return panel;
        }
      ),
      get tabGroups() {
        return { all: tabGroups };
      },
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
    TabInputWebview,
    TabInputText,
    TabInputCustom,
    TabInputNotebook,
    ViewColumn: { Active: -1, Beside: -2, One: 1, Two: 2, Three: 3 },
  };
});

import * as vscode from "vscode";
import {
  OPEN_PROPOSALS_COMMAND,
  PROPOSALS_PANEL_TYPE,
  ProposalPanel,
} from "../../../src/features/proposalPanel";
import type { WorkEntry } from "../../../src/models/types";

const work: WorkEntry = {
  id: "w1",
  title: "教科書チート",
  folderPath: "C:/小説/教科書チート",
  registeredAt: "2026-09-23T00:00:00.000Z",
};

const typo = {
  filePath: "C:/小説/教科書チート/本文/001.txt",
  chunkHash: "h1",
  line: 3,
  original: "その日はは晴れていた。",
  target: "はは",
  suggestion: "は",
  reason: "重複",
  confidence: "high" as const,
};

beforeEach(() => {
  created.length = 0;
  commands.length = 0;
  tabGroups = [];
});

describe("右の列に開く（シーンメモと同じ置き方）", () => {
  test("シーンメモが無ければ、`ViewColumn.Beside` に開く", () => {
    const panel = new ProposalPanel();
    panel.reveal();

    expect(created).toHaveLength(1);
    expect(created[0].viewType).toBe(PROPOSALS_PANEL_TYPE);
    expect(created[0].showOptions.viewColumn).toBe(vscode.ViewColumn.Beside);
    // 隠れても中身を捨てない（下段のときと同じ）
    expect(created[0].options).toEqual({
      enableScripts: true,
      retainContextWhenHidden: true,
    });
    expect(created[0].panel.webview.html).toContain("まとめて適用");
  });

  test("シーンメモが開いていれば、その列へ重ねる（右に列を増やさない）", () => {
    tabGroups = [
      { viewColumn: 1, tabs: [{ input: new vscode.TabInputText({} as vscode.Uri) }] },
      {
        viewColumn: 2,
        // VS Code はタブの viewType に内部の接頭辞を付ける
        tabs: [{ input: new vscode.TabInputWebview("mainThreadWebview-novelai.sceneMemos") }],
      },
    ];
    const panel = new ProposalPanel();
    panel.reveal({ preserveFocus: true });

    expect(created[0].showOptions).toEqual({ viewColumn: 2, preserveFocus: true });
  });

  test("2度目は作り直さず、作者が置いた列のまま前へ出す", () => {
    const panel = new ProposalPanel();
    panel.reveal();
    created[0].panel.viewColumn = 3;
    panel.reveal({ preserveFocus: true });

    expect(created).toHaveLength(1);
    expect(created[0].panel.revealed).toEqual([{ column: 3, preserveFocus: true }]);
  });

  test("閉じたら、次は新しく開く", () => {
    const panel = new ProposalPanel();
    panel.reveal();
    created[0].panel.dispose();
    panel.reveal();

    expect(created).toHaveLength(2);
  });

  test("開いた面へ一覧を送り、残りの件数を題名に出す（右の列にはタブの数字が無い）", async () => {
    const panel = new ProposalPanel();
    panel.reveal();
    panel.showResults(work, [typo]);

    const fake = created[0].panel;
    expect(fake.posted.some((message) => message.type === "issues")).toBe(true);
    expect(fake.title).toBe("提案（1）");
  });
});

describe("結果が届いたら、下段ではなく右の列を前へ出す", () => {
  test("下段のビューへフォーカスを移さない。右の列を、書く手を奪わずに出す", async () => {
    const panel = new ProposalPanel();
    panel.showResults(work, [typo]);

    expect(commands.map((entry) => entry.command)).not.toContain(
      "novelai.proposalsView.focus"
    );
    expect(commands).toContainEqual({
      command: OPEN_PROPOSALS_COMMAND,
      args: [{ preserveFocus: true }],
    });
  });

  test("ソースのどこにも、下段を前へ出す呼び出しが残っていない", () => {
    for (const file of ["src/features/proposalPanel.ts", "src/extension.ts"]) {
      const source = readFileSync(file, "utf-8");
      expect(source, file).not.toMatch(/PROPOSALS_VIEW_ID\}\.focus/);
    }
  });
});

describe("下段は既定で出さない（消してはいない）", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf-8")) as {
    contributes: {
      views: Record<string, Array<{ id: string; when?: string }>>;
      commands: Array<{ command: string; title: string }>;
      configuration: {
        properties: Record<string, { type?: string; default?: unknown }>;
      };
    };
  };

  test("下段の「提案」は、設定を入れたときだけ出る", () => {
    const view = pkg.contributes.views.novelaiIssues?.find(
      (entry) => entry.id === "novelai.proposalsView"
    );
    expect(view?.when).toBe("config.novelai.proposals.showInBottomPanel");
    const setting = pkg.contributes.configuration.properties[
      "novelai.proposals.showInBottomPanel"
    ];
    expect(setting?.type).toBe("boolean");
    expect(setting?.default).toBe(false);
  });

  test("閉じたあとで開き直す口がある", () => {
    expect(
      pkg.contributes.commands.find((entry) => entry.command === OPEN_PROPOSALS_COMMAND)
        ?.title
    ).toBe("提案パネルを開く");
  });
});

describe("本文を書き換える一括ボタンを、通知の出る右下に置かない", () => {
  const html = readFileSync("src/views/proposalPanelHtml.ts", "utf-8");
  const toolbar = html.slice(
    html.indexOf('<div id="toolbar">'),
    html.indexOf("</div>", html.indexOf('<div id="toolbar">'))
  );

  test("［まとめて適用］は、右へ寄せる塊（確信度の切り替え）より前にある", () => {
    const applyAll = toolbar.indexOf('id="applyAll"');
    // `#toolbar label { margin-left: auto }` から後ろが右の端へ寄る
    const rightGroup = toolbar.indexOf("<label>");
    expect(applyAll).toBeGreaterThan(0);
    expect(rightGroup).toBeGreaterThan(0);
    expect(applyAll).toBeLessThan(rightGroup);
    expect(html).toMatch(/#toolbar label \{[^}]*margin-left: auto/);
  });

  test("ボタンはパネルの上のツールバーにある（下に貼り付けない）", () => {
    expect(html).toMatch(/#toolbar \{[^}]*position: sticky;[^}]*top: 0;/);
    // border-bottom（下の線）は除いて、下に貼り付ける指定が無いこと
    expect(html).not.toMatch(/#toolbar \{[^}]*(?<!-)bottom:/);
  });

  test("まとめて適用の確認の窓は残っている", () => {
    const source = readFileSync("src/features/proposalPanel.ts", "utf-8");
    expect(source).toMatch(/をまとめて適用します。/);
  });
});

describe("適用のあとの読み直しは、本文の列で行う", () => {
  const source = readFileSync("src/features/proposalPanel.ts", "utf-8");
  const revert = source.slice(source.indexOf("async function revertIfOpen("));

  test("本文が開いている列を名指しし、その列を前へ出してから読み直す", () => {
    const beforeRevert = revert.slice(
      0,
      revert.indexOf('executeCommand("workbench.action.files.revert")')
    );
    // 読み直しの命令は前面の列に掛かる。提案パネルの列が前面のままだと空振りする
    expect(beforeRevert).toMatch(/viewColumn:\s*columnForLocation\(filePath\)\.column/);
    expect(beforeRevert).toMatch(/preserveFocus:\s*false/);
  });

  test("読み直したら、フォーカスを提案パネルへ戻す", () => {
    const reload = source.slice(source.indexOf("private async reloadAfterApply("));
    expect(reload.slice(0, 400)).toMatch(/editorPanel\.reveal\(/);
    // 適用の4か所とも、この口を通る
    expect(source.match(/await revertIfOpen\(/g)).toHaveLength(1);
    expect(source.match(/this\.reloadAfterApply\(item\.filePath\)/g)).toHaveLength(4);
  });
});
