import { beforeEach, describe, expect, test, vi } from "vitest";
import type { WorkEntry } from "../../src/models/types";

/**
 * 相談パネルが残す失敗の記録（実装ルール5「エラーの本文を捨てない」）。
 *
 * **実機で困ったこと**（2026-09-21）：相談で「AIから空の応答が返りました。」
 * が出たが、操作ログにも出力チャネルにも同じ一文しか残らず、原因に
 * たどり着けなかった。`AIError` は第3引数（`detail`）へ
 * `finish_reason=length` のような手掛かりを入れているのに、受け取る側が
 * `message` しか読んでいなかった。
 *
 * ここで見張るのは「記録に `detail` が入るか」だけである。**画面の通知は
 * 今までどおり**——作者に見せる文が長くなるほうが困る。
 */

const failures = vi.hoisted(
  () => [] as Array<{ context: string; detail: Record<string, unknown> }>
);

vi.mock("../../src/core/logger", () => ({
  logFailure: (context: string, detail: Record<string, unknown>) => {
    failures.push({ context, detail });
  },
  logStep: () => undefined,
  logLine: () => undefined,
  useLogFile: () => undefined,
}));

/** 相談の記録はディスクへ書く。ここでは配線を見ないので黙らせる */
vi.mock("../../src/core/chatLog", () => ({
  appendChatLog: () => undefined,
  summarizeMaterials: () => [],
}));

vi.mock("../../src/features/aiConnectivity", () => ({
  confirmProviderReachable: async () => true,
  confirmPaidUsage: async () => true,
}));

const { WorkChatPanel } = await import("../../src/features/workChatPanel");
const { AIError } = await import("../../src/ai/types");

const WORK: WorkEntry = {
  id: "w_a",
  title: "氷の街",
  folderPath: "C:\\novels\\w_a",
  registeredAt: "2026-09-05T00:00:00.000Z",
};

interface Posted {
  type: string;
  message?: string;
}

/** 画面へ送られたものを覗く作り物 */
function fakeView(posted: Posted[]) {
  return {
    visible: true,
    webview: {
      options: {},
      html: "",
      cspSource: "vscode-webview:",
      onDidReceiveMessage: () => ({ dispose: () => undefined }),
      postMessage: (message: Posted) => {
        posted.push(message);
        return Promise.resolve(true);
      },
    },
    onDidDispose: () => ({ dispose: () => undefined }),
  };
}

/** 送るたびに `error` を投げるAI */
function throwingAi(error: unknown) {
  return {
    onDidChangeSelection: () => ({ dispose: () => undefined }),
    resolve: () => ({
      provider: {
        id: "openai",
        displayName: "ChatGPT",
        isPaid: false,
        generate: async () => {
          throw error;
        },
      },
      model: "gpt-5",
    }),
  };
}

function harness(error: unknown): {
  panel: InstanceType<typeof WorkChatPanel>;
  posted: Posted[];
} {
  const posted: Posted[] = [];
  const registry = { list: () => [WORK] };
  const runner = { run: async () => undefined };
  const panel = new WorkChatPanel(
    registry as unknown as ConstructorParameters<typeof WorkChatPanel>[0],
    throwingAi(error) as unknown as ConstructorParameters<
      typeof WorkChatPanel
    >[1],
    runner as unknown as ConstructorParameters<typeof WorkChatPanel>[2]
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  panel.resolveWebviewView(fakeView(posted) as any);

  // 検索は作品フォルダーを読む。ここでは失敗の記録だけを見たいので止める
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (panel as any).findRelated = async () => ({
    reference: [],
    searchTerms: [],
    materials: [],
  });
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

  return { panel, posted };
}

async function ask(
  panel: InstanceType<typeof WorkChatPanel>,
  question: string
): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (panel as any).ask(question);
}

beforeEach(() => {
  failures.length = 0;
});

describe("相談の失敗は、AIが返した手掛かりごと記録する", () => {
  test("AIError の detail が記録に入る", async () => {
    const h = harness(
      new AIError(
        "AIから空の応答が返りました。",
        "bad_response",
        "finish_reason=length"
      )
    );

    await ask(h.panel, "灯の年齢はどうしましょう");

    const logged = failures.find((entry) => entry.context === "相談");
    expect(logged, "失敗が記録されていない").toBeTruthy();
    // **ここが本題。** これが無いと、空の応答の原因が出力上限なのか
    // 打ち切りなのか、記録からは永久に分からない
    expect(logged!.detail["詳細"]).toBe("finish_reason=length");
  });

  test("画面へ出す文はこれまでどおり（detail を混ぜない）", async () => {
    const h = harness(
      new AIError(
        "AIから空の応答が返りました。",
        "bad_response",
        "finish_reason=length"
      )
    );

    await ask(h.panel, "灯の年齢はどうしましょう");

    const shown = h.posted
      .filter((message) => message.type === "error")
      .map((message) => message.message ?? "")
      .join("\n");
    expect(shown).toContain("AIから空の応答が返りました。");
    expect(shown).not.toContain("finish_reason");
  });

  test("ただのエラーなら、詳細の欄は空のまま", async () => {
    const h = harness(new Error("つながりませんでした"));

    await ask(h.panel, "灯の年齢はどうしましょう");

    const logged = failures.find((entry) => entry.context === "相談");
    expect(logged, "失敗が記録されていない").toBeTruthy();
    // `logFailure` は空の欄を捨てるので、"undefined" とは出ない
    expect(logged!.detail["詳細"]).toBeUndefined();
  });
});
