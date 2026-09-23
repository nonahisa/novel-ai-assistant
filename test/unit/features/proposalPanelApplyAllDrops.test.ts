import { describe, expect, test, vi, beforeEach } from "vitest";

/**
 * 「まとめて適用」が、✕ の印を黙って無視していた（0.50.1 で修正）。
 *
 * 0.50.0 で「更新案の1つだけを落とす」を入れたが、印を見ていたのは
 * 1件ずつの「反映する」だけだった。**作者が ✕ を付けたあと「まとめて適用」を
 * 押すと、印が効かないまま全部入る。** 黙って意図と違うものが入るので、
 * CLAUDE.md 規則2（作者が書いたデータを守る）の考え方に反する。
 *
 * ここで見張るのは受け側——画面から届いたレコードごとの鍵が、
 * 1件ずつのときと同じ口（`applyRecordUpdate`。この先で `dropDiffEntries` を
 * 通す）へ、**そのレコードの分だけ**渡ることである。
 */

vi.mock("vscode", () => {
  const noop = () => undefined;
  return {
    commands: { executeCommand: vi.fn() },
    window: {
      // まとめて適用の確認。押されたことにしないと先へ進まない
      showWarningMessage: vi.fn(() => Promise.resolve("反映する")),
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

import * as vscode from "vscode";
import { ProposalPanel } from "../../src/features/proposalPanel";
import type { RecordUpdateViewItem } from "../../src/features/proposalPanel";
import type { WorkEntry } from "../../src/models/types";

const work: WorkEntry = {
  id: "w1",
  title: "いじめられっ子",
  folderPath: "C:/作品/いじめられっ子",
  registeredAt: "2026-09-12T00:00:00.000Z",
};

function update(id: string, name: string): RecordUpdateViewItem {
  return { id, name, changes: [`${name}の呼称が増えます`], source: "抽出", status: "pending" };
}

/** 提案パネルの面の代役。送られたメッセージを流し込めるだけあればよい */
function fakeView() {
  let receive: ((message: unknown) => void) | undefined;
  return {
    view: {
      webview: {
        options: {},
        html: "",
        cspSource: "vscode-webview:",
        onDidReceiveMessage: (handler: (message: unknown) => void) => {
          receive = handler;
          return { dispose: () => undefined };
        },
        postMessage: () => Promise.resolve(true),
      },
      onDidDispose: () => ({ dispose: () => undefined }),
      badge: undefined,
    },
    send: (message: unknown) => receive?.(message),
  };
}

/** 確認ダイアログと保存を挟むので、片付くまで待つ */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

/** 反映の口が受け取った (id, dropKeys) の並び */
type Received = Array<{ id: string; dropKeys: string[] | undefined }>;

function panelWith(
  items: RecordUpdateViewItem[],
  dropped: (id: string) => number = () => 0
): { send: (message: unknown) => void; received: Received } {
  const received: Received = [];
  const panel = new ProposalPanel();
  const fake = fakeView();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  panel.resolveWebviewView(fake.view as any);
  panel.showRecordUpdates(
    work,
    items,
    async (id, dropKeys) => {
      received.push({ id, dropKeys });
      return { ok: true, dropped: dropped(id) };
    },
    async () => ({ ok: true })
  );
  return { send: fake.send, received };
}

beforeEach(() => {
  vi.mocked(vscode.window.showInformationMessage).mockClear();
});

describe("まとめて適用も、落とす鍵を見る", () => {
  test("レコードごとの鍵が、そのレコードの反映へ渡る", async () => {
    const { send, received } = panelWith([
      update("pending-1", "中神隼人"),
      update("pending-2", "灯"),
    ]);

    send({
      type: "applyAll",
      drops: [
        { id: "pending-2", dropKeys: ["alias:灯ちゃん"] },
      ],
    });
    await settle();

    expect(received).toEqual([
      // 印の無いレコードには、鍵を渡さない（今までどおり全部入る）
      { id: "pending-1", dropKeys: undefined },
      { id: "pending-2", dropKeys: ["alias:灯ちゃん"] },
    ]);
  });

  test("別のレコードの鍵を混ぜない", async () => {
    // 全部のレコードへ全部の鍵を渡すと、同名の呼び方が巻き添えで落ちる
    const { send, received } = panelWith([
      update("pending-1", "中神隼人"),
      update("pending-2", "灯"),
    ]);

    send({
      type: "applyAll",
      drops: [
        { id: "pending-1", dropKeys: ["address:中神隼人:ハヤブサ先生"] },
        { id: "pending-2", dropKeys: ["alias:灯ちゃん"] },
      ],
    });
    await settle();

    expect(received[0].dropKeys).toEqual(["address:中神隼人:ハヤブサ先生"]);
    expect(received[1].dropKeys).toEqual(["alias:灯ちゃん"]);
  });

  test("鍵が届かなくても、これまでどおり反映できる", async () => {
    const { send, received } = panelWith([update("pending-1", "中神隼人")]);

    send({ type: "applyAll" });
    await settle();

    expect(received).toEqual([{ id: "pending-1", dropKeys: undefined }]);
  });
});

describe("完了の知らせに、落とした件数を出す", () => {
  test("落とした数を合計して伝える", async () => {
    // **黙って落としたことにしない**（CLAUDE.md 規則2）
    const { send } = panelWith(
      [update("pending-1", "中神隼人"), update("pending-2", "灯")],
      (id) => (id === "pending-1" ? 2 : 1)
    );

    send({
      type: "applyAll",
      drops: [
        { id: "pending-1", dropKeys: ["a", "b"] },
        { id: "pending-2", dropKeys: ["c"] },
      ],
    });
    await settle();

    const messages = vi
      .mocked(vscode.window.showInformationMessage)
      .mock.calls.map((call) => String(call[0]));
    expect(messages.at(-1)).toBe("2件を反映しました（3 件を落としました）。");
  });

  test("何も落としていなければ、余計なことを言わない", async () => {
    const { send } = panelWith([update("pending-1", "中神隼人")]);

    send({ type: "applyAll" });
    await settle();

    const messages = vi
      .mocked(vscode.window.showInformationMessage)
      .mock.calls.map((call) => String(call[0]));
    expect(messages.at(-1)).toBe("1件を反映しました。");
  });
});
