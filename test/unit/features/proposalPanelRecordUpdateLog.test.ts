import { describe, expect, test, vi, beforeEach } from "vitest";

/**
 * 提案パネルの「まとめて適用」で、最後に件数の1行を作品のログへ残す（0.101.13）。
 *
 * 2026-10-10、作者の作品で人物6件が提案パネルから書き換わったのに、
 * 作品のログに適用の行が1行も無かった。1件ずつの行は反映の口
 * （`applyPendingUpdates.ts` の `showInPanel`）が書く
 * （`applyPendingUpdates.test.ts` が見る）。ここで見るのは、まとめて
 * 押したときの輪がパネル側にあるので、件数の行をパネルが書くこと。
 *
 * 面の代役は `proposalPanelApplyAllDrops.test.ts` と同じ。
 */

vi.mock("vscode", () => {
  const noop = () => undefined;
  return {
    commands: { executeCommand: vi.fn() },
    window: {
      // まとめての確認。押されたことにしないと先へ進まない
      showWarningMessage: vi.fn((_message: string, _options: unknown, ...items: string[]) =>
        Promise.resolve(items[0])
      ),
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

const logged = vi.hoisted(() => ({ events: [] as string[] }));
vi.mock("../../../src/core/logger", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/core/logger")>()),
  logLine: vi.fn((message: string) => logged.events.push(`line:${message}`)),
  useLogFile: vi.fn((folder: string) => logged.events.push(`use:${folder}`)),
}));

import { ProposalPanel } from "../../../src/features/proposalPanel";
import type { RecordUpdateViewItem } from "../../../src/features/proposalPanel";
import type { WorkEntry } from "../../../src/models/types";

const work: WorkEntry = {
  id: "w1",
  title: "初恋",
  folderPath: "C:/作品/初恋",
  registeredAt: "2026-10-10T00:00:00.000Z",
};

function update(
  id: string,
  name: string,
  origin?: RecordUpdateViewItem["origin"]
): RecordUpdateViewItem {
  return {
    id,
    name,
    changes: [`${name}の別名が増えます`],
    source: "抽出",
    status: "pending",
    ...(origin ? { origin } : {}),
  };
}

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

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

function panelWith(
  items: RecordUpdateViewItem[],
  outcome: (id: string) => { ok: boolean; dropped?: number; reason?: string } = () => ({
    ok: true,
  })
): (message: unknown) => void {
  const panel = new ProposalPanel();
  const fake = fakeView();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  panel.resolveWebviewView(fake.view as any);
  panel.showRecordUpdates(
    work,
    items,
    async (id) => outcome(id),
    async () => ({ ok: true })
  );
  return fake.send;
}

function lines(): string[] {
  return logged.events
    .filter((event) => event.startsWith("line:"))
    .map((event) => event.slice("line:".length));
}

beforeEach(() => {
  logged.events = [];
});

describe("まとめて適用の件数の行", () => {
  test("全部入ったら、件数の1行を作品のログへ残す", async () => {
    const send = panelWith([update("p1", "灯"), update("p2", "澪")]);

    send({ type: "applyAll" });
    await settle();

    const expected = "設定資料の更新をまとめて適用：2/2件（提案パネル）";
    expect(lines()).toContain(expected);
    const index = logged.events.indexOf(`line:${expected}`);
    expect(logged.events[index - 1]).toBe(`use:${work.folderPath}`);
  });

  test("入らなかった数と、✕ で落とした数を黙らない", async () => {
    const send = panelWith([update("p1", "灯"), update("p2", "澪")], (id) =>
      id === "p1" ? { ok: true, dropped: 2 } : { ok: false, reason: "書けません" }
    );

    send({ type: "applyAll" });
    await settle();

    expect(lines()).toContain(
      "設定資料の更新をまとめて適用：1/2件（反映できなかった 1件、✕で落とした 2件）（提案パネル）"
    );
  });

  test("外部AIの提案のまとめての承認も、件数の行を残す", async () => {
    const send = panelWith([update("p1", "灯", "external"), update("p2", "澪")]);

    send({ type: "approveExternal" });
    await settle();

    expect(lines()).toContain("設定資料の更新（外部AIから）をまとめて承認：1/1件（提案パネル）");
  });
});
