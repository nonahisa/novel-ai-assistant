import { afterEach, describe, expect, test, vi } from "vitest";
import { statusBarMessages, window } from "../support/vscodeStub";
import type { AdviceProfile } from "../../../src/core/advicePolicy";
import type { WorkEntry } from "../../../src/models/types";

/**
 * 相談の答えから推定した助言方針の**タイプが変わったら、ステータスバーと
 * 相談パネルの両方で**「助言方針の推定が変わりました：〇〇型 → △△型」と
 * 言う（設計書6.86。実機確認リスト F-95 の代わり）。
 *
 * 文言そのものは `advicePolicy.test.ts`「タイプが変わったときだけ、作者へ
 * 知らせる」が見ている。ここは**その文が2つの場所へ届くか**と、**タイプが
 * 変わらないときは何も出さないか**（黙って調子が変わるのも、毎回言われる
 * のも困る）を、本物のパネルに推定の結果を渡して見る。
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
  id: "w_advice",
  title: "氷の街",
  folderPath: "C:\\novels\\w_advice",
  registeredAt: "2026-09-07T00:00:00.000Z",
};

/** 内省表現型（読者への意識が低め）の作品。`advicePolicy.test.ts` と同じ値 */
const INWARD: AdviceProfile = {
  answers: [],
  updatedAt: "2026-09-07T00:00:00.000Z",
  scores: { reader: 1.5, self: 3, taste: 0 },
};

function openPanel(start: AdviceProfile) {
  const posted: Array<{ type: string; message?: string }> = [];
  let current = start;
  const policies = {
    getEffective: () => current,
    set: async (_id: string, next: AdviceProfile) => {
      current = next;
    },
  };
  const panel = new WorkChatPanel(
    { list: () => [WORK] } as unknown as ConstructorParameters<typeof WorkChatPanel>[0],
    {
      onDidChangeSelection: () => ({ dispose: () => undefined }),
      resolve: () => undefined,
    } as unknown as ConstructorParameters<typeof WorkChatPanel>[1],
    { run: async () => undefined } as unknown as ConstructorParameters<
      typeof WorkChatPanel
    >[2],
    policies as unknown as ConstructorParameters<typeof WorkChatPanel>[3]
  );
  panel.resolveWebviewView({
    visible: true,
    webview: {
      options: {},
      html: "",
      cspSource: "vscode-webview:",
      onDidReceiveMessage: () => ({ dispose: () => undefined }),
      postMessage: (message: { type: string; message?: string }) => {
        posted.push(message);
        return Promise.resolve(true);
      },
    },
    onDidDispose: () => ({ dispose: () => undefined }),
  } as never);
  /** 相談の答えから読み取った推定を渡す（答えを受けたときと同じ口） */
  const update = (signals: { reader?: number }) =>
    (
      panel as unknown as {
        updateAdvicePolicy(work: WorkEntry, signals: unknown): Promise<void>;
      }
    ).updateAdvicePolicy(WORK, signals);
  return { posted, update };
}

const originalStatus = window.setStatusBarMessage;
afterEach(() => {
  window.setStatusBarMessage = originalStatus;
  statusBarMessages.length = 0;
});

describe("助言方針のタイプが変わったときの知らせ", () => {
  const CHANGED = "助言方針の推定が変わりました：内省表現型 → 対話表現型";

  test("タイプが変わったら、ステータスバーと相談パネルの両方に出す", async () => {
    statusBarMessages.length = 0;
    const { posted, update } = openPanel(INWARD);

    await update({ reader: 1 });

    expect(statusBarMessages.map((entry) => entry.text).join("\n")).toContain(
      CHANGED
    );
    expect(
      posted.some((message) => message.type === "note" && message.message === CHANGED)
    ).toBe(true);
  });

  test("タイプが変わらない推定では、どちらにも出さない", async () => {
    statusBarMessages.length = 0;
    const { posted, update } = openPanel(INWARD);

    // 読者への意識をさらに下げる（内省表現型のまま）
    await update({ reader: -1 });

    expect(statusBarMessages.map((entry) => entry.text).join("\n")).not.toContain(
      "助言方針の推定が変わりました"
    );
    expect(posted.some((message) => message.type === "note")).toBe(false);
  });
});
