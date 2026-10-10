import { describe, expect, test, vi, beforeEach } from "vitest";

/**
 * ［まとめて適用］で、移し先を選んでいない移す案を、失敗と分けて数える（0.102.4。設計書6.5.12）。
 *
 * 0.102.3 では、選んでいない移す案も反映へ回って「移し先を選んでください」で
 * 失敗になり、知らせは「N件を反映しました。」だけだった。押した数と合わず、
 * 何が残ったのかが読めない。**選んでいない案は反映へ回さず（失敗の印も付けない）、
 * 知らせで数を分けて言う。**
 */

vi.mock("vscode", () => {
  const noop = () => undefined;
  return {
    commands: { executeCommand: vi.fn() },
    window: {
      showWarningMessage: vi.fn(() => Promise.resolve("反映する")),
      showInformationMessage: vi.fn(() => Promise.resolve(undefined)),
      showErrorMessage: vi.fn(),
      createOutputChannel: () => ({ appendLine: noop }),
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
import { ProposalPanel } from "../../../src/features/proposalPanel";
import type { RecordUpdateViewItem } from "../../../src/features/proposalPanel";
import type { WorkEntry } from "../../../src/models/types";

const work: WorkEntry = {
  id: "w1",
  title: "ハイエルフ未亡人",
  folderPath: "C:/作品/ハイエルフ未亡人",
  registeredAt: "2026-10-10T00:00:00.000Z",
};

function update(id: string, name: string): RecordUpdateViewItem {
  return { id, name, changes: [`${name}の呼称が増えます`], source: "抽出", status: "pending" };
}

/** 移す案の行。`selected` が null なら、名指しできなかった（作者が選ぶ）案 */
function move(id: string, selected: string | null): RecordUpdateViewItem {
  return {
    id,
    name: "アジャーノ",
    changes: ["いまの値：皇子"],
    source: "移す案：役割「皇子」（第12話）",
    status: "pending",
    moveChoice: { options: [{ id: "char_016", name: "殿下" }], selected },
  };
}

function fakeView() {
  let receive: ((message: unknown) => void) | undefined;
  let lastItems: Array<{ id: string; status: string }> = [];
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
        postMessage: (message: { recordUpdates?: typeof lastItems }) => {
          if (message.recordUpdates) lastItems = message.recordUpdates;
          return Promise.resolve(true);
        },
      },
      onDidDispose: () => ({ dispose: () => undefined }),
      badge: undefined,
    },
    send: (message: unknown) => receive?.(message),
  };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

function panelWith(items: RecordUpdateViewItem[], failIds: string[] = []) {
  const received: string[] = [];
  const panel = new ProposalPanel();
  const fake = fakeView();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  panel.resolveWebviewView(fake.view as any);
  panel.showRecordUpdates(
    work,
    items,
    async (id) => {
      received.push(id);
      if (failIds.includes(id)) return { ok: false, reason: "書けませんでした" };
      return { ok: true, dropped: 0 };
    },
    async () => ({ ok: true })
  );
  return { send: fake.send, received, panel };
}

function lastInfo(): string {
  return String(vi.mocked(vscode.window.showInformationMessage).mock.calls.at(-1)?.[0]);
}

beforeEach(() => {
  vi.mocked(vscode.window.showInformationMessage).mockClear();
  vi.mocked(vscode.window.showWarningMessage).mockClear();
});

describe("まとめて適用：移し先を選んでいない移す案", () => {
  test("反映へ回さず、知らせで数を分けて言う", async () => {
    const { send, received } = panelWith([
      update("pending-1", "殿下"),
      move("move-named", "char_016"),
      move("move-unchosen", null),
      move("move-picked", null),
    ]);

    send({
      type: "applyAll",
      drops: [{ id: "move-picked", dropKeys: ["moveTo:char_016"] }],
    });
    await settle();

    expect(received).toEqual(["pending-1", "move-named", "move-picked"]);
    // 確認の数も、反映へ回すぶんだけ
    expect(String(vi.mocked(vscode.window.showWarningMessage).mock.calls[0][0])).toBe(
      "3件をまとめて反映します。"
    );
    expect(lastInfo()).toBe(
      "3件を反映しました。移し先を選んでいない移す案 1件は残しました。"
    );
  });

  test("「外すだけ」を選んだ案は、選んだものとして反映へ回す", async () => {
    const { send, received } = panelWith([move("move-remove", null)]);
    send({ type: "applyAll", drops: [{ id: "move-remove", dropKeys: ["moveTo:-"] }] });
    await settle();
    expect(received).toEqual(["move-remove"]);
    expect(lastInfo()).toBe("1件を反映しました。");
  });

  test("失敗と、選んでいない案を分けて数える", async () => {
    const { send } = panelWith(
      [update("pending-1", "殿下"), update("pending-2", "宿屋の娘"), move("move-unchosen", null)],
      ["pending-2"]
    );
    send({ type: "applyAll" });
    await settle();
    expect(lastInfo()).toBe(
      "1件を反映しました。反映できなかった 1件は、一覧に理由が出ています。" +
        "移し先を選んでいない移す案 1件は残しました。"
    );
  });

  test("選んでいない案しか無ければ、反映せずに選ぶよう伝える", async () => {
    const { send, received } = panelWith([move("move-unchosen", null)]);
    send({ type: "applyAll" });
    await settle();
    expect(received).toEqual([]);
    expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
    expect(lastInfo()).toBe(
      "反映できる更新がありません。移し先を選んでいない移す案 1件は、移し先を選んでから反映してください。"
    );
  });
});
