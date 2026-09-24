import { describe, expect, test, vi } from "vitest";
import type { WorkEntry } from "../../../src/models/types";
import { window } from "../support/vscodeStub";
import { runnableFeatures } from "../../../src/core/chatEdit";

/**
 * 大きい相談画面の「できること」から機能を押したとき（設計書6.31。
 * 実機確認リスト F-23 の代わり）。
 *
 * 押した札は、**詳細メニューと同じ入口**（`extension.ts` の相談パネルの
 * `run` → 登録済みのコマンド。`chatRunEntry.test.ts` が見ている）へ渡り、
 * 結果はそのコマンドが提案パネルへ出す。ここで見るのは、画面から届いた
 * 押下が**その入口へ届くこと**と、**どこに結果が出るかを作者へ言うこと**。
 * 札に「（AIを使います）」を付ける条件は `workChatPanelLarge.test.ts`。
 */

vi.mock("../../../src/core/chatLog", () => ({
  appendChatLog: () => undefined,
  summarizeMaterials: () => [],
}));
vi.mock("../../../src/core/logger", () => ({
  logFailure: () => undefined,
  logStep: () => undefined,
  logLine: () => undefined,
  useLogFile: () => undefined,
}));

const { WorkChatPanel } = await import("../../../src/features/workChatPanel");

const WORK: WorkEntry = {
  id: "w_run",
  title: "氷の街",
  folderPath: "C:\\novels\\w_run",
  registeredAt: "2026-09-05T00:00:00.000Z",
};

interface Posted {
  type: string;
  [key: string]: unknown;
}

function harness() {
  const posted: Posted[] = [];
  let handler: ((message: unknown) => void) | undefined;
  const webview = {
    options: {},
    html: "",
    cspSource: "vscode-webview:",
    onDidReceiveMessage: (listener: (message: unknown) => void) => {
      handler = listener;
      return { dispose: () => undefined };
    },
    postMessage: (message: Posted) => {
      posted.push(message);
      return Promise.resolve(true);
    },
  };
  Object.assign(window, {
    createWebviewPanel: () => ({
      webview,
      reveal: () => undefined,
      onDidDispose: () => ({ dispose: () => undefined }),
      dispose: () => undefined,
    }),
  });
  const run = vi.fn(async () => undefined);
  const panel = new WorkChatPanel(
    { list: () => [WORK] } as unknown as ConstructorParameters<typeof WorkChatPanel>[0],
    {
      onDidChangeSelection: () => ({ dispose: () => undefined }),
      resolve: () => undefined,
    } as unknown as ConstructorParameters<typeof WorkChatPanel>[1],
    { run } as unknown as ConstructorParameters<typeof WorkChatPanel>[2]
  );
  panel.openLargePanel();
  // 開いている作品は「氷の街」（作品全体の相談）にしておく
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (panel as any).resolveContext = async () => ({
    work: WORK,
    kind: "workOnly",
    filePath: WORK.folderPath,
    label: WORK.title,
    excerpt: "",
    truncated: false,
    fromSelection: false,
    reference: [],
  });
  return {
    posted,
    run,
    async send(message: unknown) {
      handler?.(message);
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
  };
}

describe("「できること」から機能を起動する", () => {
  test("誤字脱字の検知を押すと、作品を渡して入口を呼び、結果の出る場所を言う", async () => {
    const h = harness();

    await h.send({ type: "quickRun", kind: "checkTypos" });

    expect(h.run).toHaveBeenCalledTimes(1);
    expect(h.run).toHaveBeenCalledWith(WORK, "checkTypos", undefined);
    const notes = h.posted.filter((message) => message.type === "note");
    expect(String(notes.at(-1)?.message)).toContain(
      "結果は右の列の「提案」パネルに出ます"
    );
  });

  test("一覧に無い名前を送られても、何も走らせない", async () => {
    // 画面から届く文字列をそのままコマンドにしない（許した一覧と突き合わせる）
    const h = harness();

    await h.send({ type: "quickRun", kind: "workbench.action.quit" });

    expect(h.run).not.toHaveBeenCalled();
  });

  test("「できること」の一覧は、AIを使うものと使わないものを言い分けられる", () => {
    // 札の印は `run.usesAI` で付く。一覧の側に両方が居ないと、
    // どちらかの札が必ず間違った印になる
    const runs = runnableFeatures();
    expect(runs.find((run) => run.kind === "checkTypos")?.usesAI).toBe(true);
    expect(runs.some((run) => run.usesAI === false)).toBe(true);
  });
});
