import { describe, expect, test, vi } from "vitest";
import type { WorkEntry } from "../../../src/models/types";

/**
 * 相談パネル上部のエンジン名・「有料」の印・「AI未設定」（F-14）。
 *
 * **AIを切り替えると `ai.onDidChangeSelection` が発火し、`postContext()` が
 * 開いている画面へ「その場で」新しい表示を送り直す。** ここで確かめたいのは
 * その配線——切り替え通知を受けた直後に、`paid` や `provider` の中身が
 * 新しい選択と一致した `context` メッセージが飛ぶこと。
 *
 * 実際に画面が書き換わるかどうかは開き直さなくても分かる（F-14の実機項目）
 * が、**送るところまではここで機械に見せられる**。
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
  id: "w_badge",
  title: "氷の街",
  folderPath: "C:\\novels\\w_badge",
  registeredAt: "2026-09-06T00:00:00.000Z",
};

const FREE_PROVIDER = {
  provider: {
    id: "ollama",
    displayName: "Ollama（ローカル）",
    isPaid: false,
    generate: async () => ({ text: "{}" }),
  },
  model: "gemma4:e4b",
};

const PAID_PROVIDER = {
  provider: {
    id: "claude",
    displayName: "Claude",
    isPaid: true,
    generate: async () => ({ text: "{}" }),
  },
  model: "claude-x",
};

function fakeView(posted: unknown[]) {
  return {
    visible: true,
    webview: {
      options: {},
      html: "",
      cspSource: "vscode-webview:",
      onDidReceiveMessage: () => ({ dispose: () => undefined }),
      postMessage: (message: unknown) => {
        posted.push(message);
        return Promise.resolve(true);
      },
    },
    onDidDispose: () => ({ dispose: () => undefined }),
  };
}

/**
 * `ai.resolve` の戻り値を差し替えながら、切り替え通知を手で起こせる作り。
 *
 * `onDidChangeSelection` に渡されたコールバックは本物のコード
 * （`() => void this.postContext()`）そのものなので、それを呼ぶことで
 * 配線（切り替え→表示のやり直し）ごと確かめられる。`postContext` は
 * private だが `vi.spyOn` で包み、コールバックが実際に起こした
 * `postContext()` の呼び出しをそのまま待つ。
 */
function makePanel() {
  const registry = { list: () => [WORK] };
  const posted: unknown[] = [];
  let current: typeof FREE_PROVIDER | undefined = FREE_PROVIDER;
  let changeListener: (() => void) | undefined;
  const ai = {
    onDidChangeSelection: (cb: () => void) => {
      changeListener = cb;
      return { dispose: () => undefined };
    },
    resolve: () => current,
  };
  const runner = { run: async () => undefined };
  const panel = new WorkChatPanel(
    registry as unknown as ConstructorParameters<typeof WorkChatPanel>[0],
    ai as unknown as ConstructorParameters<typeof WorkChatPanel>[1],
    runner as unknown as ConstructorParameters<typeof WorkChatPanel>[2]
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  panel.resolveWebviewView(fakeView(posted) as any);

  const spy = vi.spyOn(
    panel as unknown as { postContext: () => Promise<void> },
    "postContext"
  );

  return {
    posted,
    setResolved: (value: typeof FREE_PROVIDER | undefined) => {
      current = value;
    },
    /** 切り替え通知を起こし、それが引き起こした `postContext()` の完了まで待つ */
    triggerSwitchAndWait: async () => {
      spy.mockClear();
      changeListener?.();
      await spy.mock.results[0]!.value;
    },
  };
}

function lastContextMessage(posted: unknown[]): Record<string, unknown> {
  const messages = posted.filter(
    (message) => (message as { type?: string }).type === "context"
  );
  expect(messages.length).toBeGreaterThan(0);
  return messages[messages.length - 1] as Record<string, unknown>;
}

describe("相談パネル上部の表示（AIの切り替え）", () => {
  test("有料のAIへ切り替えると、その場で「有料」の印が付く", async () => {
    const panel = makePanel();
    panel.setResolved(PAID_PROVIDER);
    await panel.triggerSwitchAndWait();

    const message = lastContextMessage(panel.posted);
    expect(message.paid).toBe(true);
    expect(message.provider).toBe("Claude（claude-x）");
  });

  test("無料へ戻すと、印が消える", async () => {
    const panel = makePanel();
    panel.setResolved(PAID_PROVIDER);
    await panel.triggerSwitchAndWait();

    panel.setResolved(FREE_PROVIDER);
    await panel.triggerSwitchAndWait();

    const message = lastContextMessage(panel.posted);
    expect(message.paid).toBe(false);
  });

  test("AIの設定を解除すると、「AI未設定」に変わる", async () => {
    const panel = makePanel();
    panel.setResolved(undefined);
    await panel.triggerSwitchAndWait();

    const message = lastContextMessage(panel.posted);
    expect(message.provider).toBe("AI未設定");
    expect(message.paid).toBe(false);
  });
});
