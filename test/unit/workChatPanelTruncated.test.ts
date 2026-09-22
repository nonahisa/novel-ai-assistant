import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { workspace } from "vscode";
import type { WorkEntry } from "../../src/models/types";
import { useMemoryTuningStore } from "./support/tuningStore";

/**
 * 切り詰められた返答と、タイムアウトの直し方（作者の実機報告、2026-09-23）。
 *
 * 見るのは3つ。
 * 1. 読み取れなかったJSONを、そのまま画面へ出さないこと
 *    （作者は `"needFiles": [],` が並ぶ画面を見せられていた）
 * 2. 救えた回には、途中で切れていることを添えること
 * 3. タイムアウトの案内に「その場で直す」札が出て、押すと設定が書かれること
 *    （作者はプログラマではない。文章で設定の場所を言っても辿り着けない）
 */

/** AIが返す本文と、切り詰めの札。試験ごとに差し替える */
const response = vi.hoisted(() => ({
  text: "",
  truncated: false,
  error: undefined as unknown,
}));

vi.mock("../../src/core/chatLog", () => ({
  appendChatLog: () => undefined,
  summarizeMaterials: () => [],
}));

vi.mock("../../src/core/logger", () => ({
  logFailure: () => undefined,
  logStep: () => undefined,
  logLine: () => undefined,
  useLogFile: () => undefined,
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

/** 実機で出た形。`}` が1つも無い */
const TRUNCATED_JSON =
  '{\n  "reply": "第12話の視点は灯に寄っています。",\n' +
  '  "options": ["別の切り口で3案出してほしい"],\n' +
  '  "needFiles": [],\n  "run": null';

interface Posted {
  type: string;
  message?: string;
  reply?: string;
  actions?: Array<{ label: string; command: string }>;
}

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

function fakeAi(providerId: string, model: string) {
  return {
    onDidChangeSelection: () => ({ dispose: () => undefined }),
    resolve: () => ({
      provider: {
        id: providerId,
        displayName: providerId === "sakura" ? "さくらのAI" : "Ollama",
        isPaid: false,
        generate: async () => {
          if (response.error) throw response.error;
          return { text: response.text, truncated: response.truncated };
        },
      },
      model,
    }),
  };
}

interface Harness {
  panel: InstanceType<typeof WorkChatPanel>;
  posted: Posted[];
}

function harness(providerId = "sakura", model = "gpt-oss-120b"): Harness {
  const posted: Posted[] = [];
  const registry = { list: () => [WORK] };
  const runner = { run: async () => undefined };
  const panel = new WorkChatPanel(
    registry as unknown as ConstructorParameters<typeof WorkChatPanel>[0],
    fakeAi(providerId, model) as unknown as ConstructorParameters<
      typeof WorkChatPanel
    >[1],
    runner as unknown as ConstructorParameters<typeof WorkChatPanel>[2]
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  panel.resolveWebviewView(fakeView(posted) as any);
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

async function ask(h: Harness, question: string): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (h.panel as any).ask(question);
}

/** 画面から札を押す。**製品と同じ受け口**（`handle`）を通す */
async function press(h: Harness, command: string): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const view = (h.panel as any).view;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (h.panel as any).handle(
    { type: "errorAction", command },
    view.webview
  );
}

const originalConfig = workspace.getConfiguration;
/** `update` で書かれた設定。鍵と値と行き先を覚える */
const written: Array<{ key: string; value: unknown; target: unknown }> = [];

beforeEach(async () => {
  response.text = "";
  response.truncated = false;
  response.error = undefined;
  written.length = 0;
  // 台帳は空から。**空なら待ち時間は設定のほうが効く**
  await useMemoryTuningStore({});
  workspace.getConfiguration = (() => ({
    get: <T>(_key: string, defaultValue: T): T => defaultValue,
    update: async (key: string, value: unknown, target: unknown) => {
      written.push({ key, value, target });
    },
  })) as unknown as typeof workspace.getConfiguration;
});

afterEach(() => {
  workspace.getConfiguration = originalConfig;
});

describe("読み取れなかったJSONを作者に見せない", () => {
  test("切り詰めの案内が出て、JSONは1文字も出ない", async () => {
    // 救えない形にしておく（`reply` が文字列として成立しない）
    response.text = '{"reply": 12, "needFiles": [], "run"';
    response.truncated = true;
    const h = harness();

    await ask(h, "第12話の視点はどうですか");

    const answers = h.posted.filter((m) => m.type === "answer");
    expect(answers, "読めない返事を答えとして出してはいけない").toHaveLength(0);
    const error = h.posted.find((m) => m.type === "error");
    expect(error, "案内が出ていない").toBeTruthy();
    expect(error!.message).toContain("出力上限");
    expect(error!.message).not.toContain('"needFiles"');
  });

  test("切り詰めの札が立っていなくても、読めなければ案内を出す", async () => {
    // プロバイダが切り詰めを申告しない回もある。**そこで素通りさせない**
    response.text = '{"reply": 12, "needFiles": [], "run"';
    response.truncated = false;
    const h = harness();

    await ask(h, "第12話の視点はどうですか");

    const error = h.posted.find((m) => m.type === "error");
    expect(error!.message).toContain("読み取れませんでした");
    expect(error!.message).not.toContain('"needFiles"');
  });

  test("救えた回は、答えを出したうえで切れていると添える", async () => {
    response.text = TRUNCATED_JSON;
    response.truncated = true;
    const h = harness();

    await ask(h, "第12話の視点はどうですか");

    const answer = h.posted.find((m) => m.type === "answer");
    expect(answer, "救えた答えが出ていない").toBeTruthy();
    expect(answer!.reply).toBe("第12話の視点は灯に寄っています。");
    const note = h.posted.find(
      (m) => m.type === "note" && (m.message ?? "").includes("途中で切れて")
    );
    expect(note, "切れていることを伝えていない").toBeTruthy();
  });

  test("そのまま読めた回には、切れた断りを出さない", async () => {
    response.text = JSON.stringify({ reply: "こう読めます。", options: [] });
    const h = harness();

    await ask(h, "第12話の視点はどうですか");

    const note = h.posted.find(
      (m) => m.type === "note" && (m.message ?? "").includes("途中で切れて")
    );
    expect(note).toBeUndefined();
  });
});

describe("タイムアウトは、その場で直せる", () => {
  test("案内に「秒数を上げる」札が付く", async () => {
    response.error = new AIError("応答がありませんでした。", "timeout");
    const h = harness();

    await ask(h, "第12話の視点はどうですか");

    const error = h.posted.find((m) => m.type === "error");
    expect(error?.actions, "札が出ていない").toBeTruthy();
    // 既定の180秒の倍
    expect(error!.actions![0].label).toBe("タイムアウトを360秒にする");
  });

  test("押すまでは何も書かない", async () => {
    response.error = new AIError("応答がありませんでした。", "timeout");
    const h = harness();

    await ask(h, "第12話の視点はどうですか");

    expect(written, "押していないのに設定が変わった").toHaveLength(0);
  });

  test("押すと、そのAIの待ち時間が全体の設定へ入る", async () => {
    response.error = new AIError("応答がありませんでした。", "timeout");
    const h = harness("sakura", "gpt-oss-120b");
    await ask(h, "第12話の視点はどうですか");
    const command = h.posted.find((m) => m.type === "error")!.actions![0]
      .command;

    await press(h, command);

    expect(written).toHaveLength(1);
    // **鍵はプロバイダごと。** さくらの相談でOllamaの設定を書かない
    expect(written[0].key).toBe("sakura.timeoutSeconds");
    expect(written[0].value).toBe(360);
    const note = h.posted.find(
      (m) => m.type === "note" && (m.message ?? "").includes("360秒")
    );
    expect(note, "書いたことを伝えていない").toBeTruthy();
  });

  test("二度押しても、二度は書かない", async () => {
    response.error = new AIError("応答がありませんでした。", "timeout");
    const h = harness();
    await ask(h, "第12話の視点はどうですか");
    const command = h.posted.find((m) => m.type === "error")!.actions![0]
      .command;

    await press(h, command);
    await press(h, command);

    expect(written).toHaveLength(1);
  });

  test("タイムアウト以外の失敗には札を出さない", async () => {
    response.error = new AIError("APIキーが違います。", "authentication_failed");
    const h = harness();

    await ask(h, "第12話の視点はどうですか");

    const error = h.posted.find((m) => m.type === "error");
    expect(error?.actions).toBeUndefined();
  });

  test("すでに上限なら札を出さない（押しても変わらない札を出さない）", async () => {
    response.error = new AIError("応答がありませんでした。", "timeout");
    workspace.getConfiguration = (() => ({
      get: <T>(key: string, defaultValue: T): T =>
        (key === "sakura.timeoutSeconds" ? 600 : defaultValue) as T,
      update: async (key: string, value: unknown, target: unknown) => {
        written.push({ key, value, target });
      },
    })) as unknown as typeof workspace.getConfiguration;
    const h = harness();

    await ask(h, "第12話の視点はどうですか");

    expect(h.posted.find((m) => m.type === "error")?.actions).toBeUndefined();
  });

  test("台帳に待ち時間があるときは、台帳のほうへ書く", async () => {
    // **設定だけ書いても効かない。** 待ち時間は台帳が設定に勝つ
    await useMemoryTuningStore({
      "sakura/gpt-oss-120b": { timeoutSeconds: 200 },
    });
    response.error = new AIError("応答がありませんでした。", "timeout");
    const h = harness("sakura", "gpt-oss-120b");
    await ask(h, "第12話の視点はどうですか");
    const action = h.posted.find((m) => m.type === "error")!.actions![0];
    expect(action.label).toBe("タイムアウトを400秒にする");

    await press(h, action.command);

    const { tuningStoreContents } = await import("./support/tuningStore");
    expect(written, "効かない設定のほうへ書いている").toHaveLength(0);
    expect(
      (
        tuningStoreContents()["sakura/gpt-oss-120b"] as {
          timeoutSeconds?: number;
        }
      ).timeoutSeconds
    ).toBe(400);
  });
});
