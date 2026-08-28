import { beforeEach, describe, expect, test, vi } from "vitest";
import { readFileSync } from "node:fs";

/**
 * 矛盾検知から伏線への転送（設計書6.35.4）。
 *
 * 作者の指定：「矛盾検知で伏線になるものが検知される可能性があるので、
 * ここから伏線へ飛ばすというルートも作る」。
 *
 * 矛盾検知は「前の話と食い違う記述」を拾うが、**それが矛盾ではなく
 * 伏線（意図した違和感）であることがある**。押した時点で作者の承認なので、
 * この経路だけは台帳へ直接保存してよい。
 *
 * ここで押さえるのは2つ。
 *   (a) 押すと、矛盾の内容が保存側へそのまま渡ること
 *   (b) 保存できたら、その矛盾が片付いた状態になること
 * 保存そのもの（ファイルの書き方）は `foreshadowStore` の側の話である。
 */

const posted: Array<{ category: string; items: unknown[] }> = [];
const notified: string[] = [];
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
        return Promise.resolve(undefined);
      }),
      showErrorMessage: vi.fn(),
    },
    workspace: {
      getConfiguration: () => ({ get: (_k: string, d?: unknown) => d }),
      fs: {
        // 操作ログの追記はこのテストの関心ではないが、落ちると
        // 本筋の判定まで巻き込まれるので、素直に動く偽物を置く
        readFile: vi.fn(() => Promise.resolve(new Uint8Array())),
        writeFile: vi.fn(() => Promise.resolve()),
        createDirectory: vi.fn(() => Promise.resolve()),
      },
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

import {
  ProposalPanel,
  type ForeshadowFromContradiction,
} from "../../src/features/proposalPanel";
import type { WorkEntry } from "../../src/models/types";

const work: WorkEntry = {
  id: "w1",
  title: "いじめられっ子",
  folderPath: "C:/小説/いじめられっ子",
  registeredAt: "2026-08-28T00:00:00.000Z",
};

/** 話数がファイル名から読める矛盾の1件 */
const contradiction = {
  filePath: "C:/小説/いじめられっ子/本文/007_湖畔の誓い.txt",
  chunkHash: "h1",
  line: 42,
  excerpt: "少女の髪は、月の光を受けて赤く見えた",
  category: "人物",
  settingSays: "髪は黒",
  textSays: "赤い髪",
  note: "第3話では黒と書かれている",
  confidence: "high" as const,
};

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

function panelWithView(): ProposalPanel {
  const panel = new ProposalPanel();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  panel.resolveWebviewView(fakeView() as any);
  return panel;
}

function latest() {
  return posted[posted.length - 1];
}

/** 画面のボタンを押したのと同じ（webviewからのメッセージ） */
async function press(panel: ProposalPanel, id: string): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (panel as any).handleMessage({ type: "registerForeshadow", id });
}

/** いま出ている矛盾の1件（idは組み立てられるので、画面から取る） */
function shownContradiction(): {
  id: string;
  status: string;
  dismissReason?: string;
  canRegisterForeshadow?: boolean;
} {
  return latest().items[0] as {
    id: string;
    status: string;
    dismissReason?: string;
    canRegisterForeshadow?: boolean;
  };
}

beforeEach(() => {
  posted.length = 0;
  notified.length = 0;
  warned.length = 0;
});

describe("矛盾を伏線として登録する", () => {
  test("押すと、矛盾の内容が保存側へ渡る", async () => {
    const registered: ForeshadowFromContradiction[] = [];
    const panel = panelWithView();
    panel.showContradictions(
      work,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      [contradiction as any],
      async (source) => {
        registered.push(source);
        return { ok: true };
      }
    );

    await press(panel, shownContradiction().id);

    expect(registered).toHaveLength(1);
    // 名前は**本文の側**から採る。伏線になりうるのは設定と違う記述のほう
    expect(registered[0].label).toBe("赤い髪");
    // 矛盾の内容は、並べた2つと補足をそのまま写す
    expect(registered[0].note).toContain("設定では：髪は黒");
    expect(registered[0].note).toContain("本文では：赤い髪");
    expect(registered[0].note).toContain("第3話では黒と書かれている");
    // 引用は本文と照合済みのものをそのまま渡す
    expect(registered[0].quote).toBe("少女の髪は、月の光を受けて赤く見えた");
    // 話数はファイル名から読める
    expect(registered[0].chapter).toBe(7);
  });

  test("話数が読めないファイル名なら、話数は入れない", async () => {
    // **推測で埋めない**（第1話にしてしまうと、一覧の並びも内容も嘘になる）
    const registered: ForeshadowFromContradiction[] = [];
    const panel = panelWithView();
    panel.showContradictions(
      work,
      [
        {
          ...contradiction,
          filePath: "C:/小説/いじめられっ子/本文/プロローグ.txt",
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
      ],
      async (source) => {
        registered.push(source);
        return { ok: true };
      }
    );

    await press(panel, shownContradiction().id);

    expect(registered[0].chapter).toBeNull();
  });

  test("長い記述は、短い名に切り詰める", async () => {
    const registered: ForeshadowFromContradiction[] = [];
    const panel = panelWithView();
    panel.showContradictions(
      work,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      [{ ...contradiction, textSays: "あ".repeat(40) } as any],
      async (source) => {
        registered.push(source);
        return { ok: true };
      }
    );

    await press(panel, shownContradiction().id);

    expect(registered[0].label).toBe(`${"あ".repeat(20)}…`);
  });

  test("登録できたら、その矛盾は片付いた扱いになる", async () => {
    const panel = panelWithView();
    panel.showContradictions(
      work,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      [contradiction as any],
      async () => ({ ok: true })
    );

    await press(panel, shownContradiction().id);

    const item = shownContradiction();
    // 状態そのものは「無視」と同じ（＝片付いた）。**理由だけを分ける**
    expect(item.status).toBe("dismissed");
    expect(item.dismissReason).toBe("伏線として登録しました");
    expect(notified.join("\n")).toContain("伏線として登録しました");
  });

  test("同じ矛盾を二度登録しない", async () => {
    // 片付いたものは、もう押せない（画面もボタンを消すが、念のため止める）
    let calls = 0;
    const panel = panelWithView();
    panel.showContradictions(
      work,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      [contradiction as any],
      async () => {
        calls += 1;
        return { ok: true };
      }
    );

    const id = shownContradiction().id;
    await press(panel, id);
    await press(panel, id);

    expect(calls).toBe(1);
  });

  test("保存に失敗したら、矛盾は片付かず理由が出る", async () => {
    // **先に片付けない。** 逆順にすると、失敗したとき矛盾も伏線も残らない
    const panel = panelWithView();
    panel.showContradictions(
      work,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      [contradiction as any],
      async () => ({ ok: false, reason: "書き込めませんでした。" })
    );

    await press(panel, shownContradiction().id);

    expect(shownContradiction().status).toBe("pending");
    expect(warned.join("\n")).toContain("書き込めませんでした。");
  });

  test("保存の口が渡っていなければ、ボタンを出さない", () => {
    // 押しても何も起きない口を作らない（「見送る」で実際に起きた失敗）
    const panel = panelWithView();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    panel.showContradictions(work, [contradiction as any]);

    expect(shownContradiction().canRegisterForeshadow).toBe(false);
  });

  test("渡っていれば、ボタンを出す", () => {
    const panel = panelWithView();
    panel.showContradictions(
      work,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      [contradiction as any],
      async () => ({ ok: true })
    );

    expect(shownContradiction().canRegisterForeshadow).toBe(true);
  });

  test("プロット逸脱には出さない", () => {
    // 逸脱は「プロットと本文の食い違い」であって、後の展開への示唆ではない
    const panel = panelWithView();
    panel.showDeviations(work, [
      {
        filePath: "C:/小説/いじめられっ子/本文/007_湖畔の誓い.txt",
        chunkHash: "h1",
        lineStart: 10,
        lineEnd: 12,
        excerpt: "湖の話が続く",
        type: "間延び",
        plotReference: "第7話で決別するはず",
        reason: "決別が起きていない",
        confidence: "medium",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
    ]);

    expect(shownContradiction().canRegisterForeshadow).toBeUndefined();
  });
});

/** 画面側の道（WebViewを要するので、口が残っているかだけを見る） */
describe("画面の登録の口", () => {
  const html = () => readFileSync("src/views/proposalPanelHtml.ts", "utf-8");

  test("押すと registerForeshadow を送る", () => {
    expect(html()).toContain("registerForeshadow");
  });

  test("片付いた理由は、添えてあればそちらを出す", () => {
    // 伏線として登録したものを「無視しました」と書かない
    expect(html()).toContain("item.dismissReason");
  });
});
