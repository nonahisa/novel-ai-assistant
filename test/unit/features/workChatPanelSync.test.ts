import { beforeEach, describe, expect, test, vi } from "vitest";
import type { WorkEntry } from "../../src/models/types";
import { window } from "./support/vscodeStub";

/**
 * 横のパネルと大きい画面で、同じ会話を見る（設計書6.31、実機確認リスト F-23）。
 *
 * 会話は1つしかない。**どちらで聞いても続きから話せる**のが要件で、
 * そのために片方で起きたことをもう片方へ配る。配り方を間違えると、
 * 作者の発言が二重に並んだり、片方だけ古い会話を出し続けたりする。
 *
 * 画面が実際に並ぶことは実機に残る。ここで見るのは**何が誰へ届くか**である。
 */

/** 相談の記録はディスクへ書く。ここでは配線を見ないので黙らせる */
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

const WORK: WorkEntry = {
  id: "w_a",
  title: "氷の街",
  folderPath: "C:\\novels\\w_a",
  registeredAt: "2026-09-05T00:00:00.000Z",
};

interface Posted {
  type: string;
  [key: string]: unknown;
}

/** 1つの画面の代役。届いたものと、画面から送る口を持つ */
interface Screen {
  posted: Posted[];
  /** この画面から拡張機能側へ送る */
  send(message: unknown): Promise<void>;
  webview: unknown;
}

function screen(): Screen {
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
  return {
    posted,
    webview,
    async send(message: unknown) {
      handler?.(message);
      // 受け側が await を挟むので、1周まわしてから見る
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
  };
}

/** 相談のAI。決まった一言を返すだけ */
function fakeAi() {
  return {
    onDidChangeSelection: () => ({ dispose: () => undefined }),
    resolve: () => ({
      provider: {
        id: "ollama",
        displayName: "Ollama",
        isPaid: false,
        generate: async () => ({
          text: JSON.stringify({ reply: "17歳がよさそうです。" }),
        }),
      },
      model: "gemma4:e4b",
    }),
  };
}

interface Harness {
  panel: InstanceType<typeof WorkChatPanel>;
  side: Screen;
  large: Screen;
}

/** 横のパネルと大きい画面を、両方開いた状態を作る */
function harness(): Harness {
  const side = screen();
  const large = screen();

  Object.assign(window, {
    createWebviewPanel: () => ({
      webview: large.webview,
      reveal: () => undefined,
      onDidDispose: () => ({ dispose: () => undefined }),
      dispose: () => undefined,
    }),
  });

  const registry = { list: () => [WORK] };
  const runner = { run: async () => undefined };
  const panel = new WorkChatPanel(
    registry as unknown as ConstructorParameters<typeof WorkChatPanel>[0],
    fakeAi() as unknown as ConstructorParameters<typeof WorkChatPanel>[1],
    runner as unknown as ConstructorParameters<typeof WorkChatPanel>[2]
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  panel.resolveWebviewView({
    visible: true,
    webview: side.webview,
    onDidDispose: () => ({ dispose: () => undefined }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
  panel.openLargePanel();

  // 検索は作品フォルダーを読む。相談の道筋だけを見たいので止める
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

  return { panel, side, large };
}

/** その画面に届いた、その種類のもの */
function received(target: Screen, type: string): Posted[] {
  return target.posted.filter((message) => message.type === type);
}

/** 1往復する（画面から送るのと同じ道を通す） */
async function ask(h: Harness, from: Screen, question: string): Promise<void> {
  await from.send({ type: "ask", question });
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("2つの画面で同じ会話を見る", () => {
  test("片方で聞くと、もう片方にも質問が積まれる（実機確認リスト F-23 の代わり）", async () => {
    const h = harness();

    await ask(h, h.side, "灯の年齢はどうしましょう");

    // 押した側は自分で出しているので、送り返さない（二重に並ぶ）
    expect(received(h.side, "asked")).toHaveLength(0);
    expect(received(h.large, "asked")).toHaveLength(1);
    expect(received(h.large, "asked")[0].question).toBe(
      "灯の年齢はどうしましょう"
    );
  });

  test("答えは、両方の画面に出る（実機確認リスト F-23 の代わり）", async () => {
    const h = harness();

    await ask(h, h.side, "灯の年齢はどうしましょう");

    expect(received(h.side, "answer")).toHaveLength(1);
    expect(received(h.large, "answer")).toHaveLength(1);
  });

  test("後から開いた側に、それまでの会話が届く（実機確認リスト F-23 の代わり）", async () => {
    const h = harness();
    await ask(h, h.side, "灯の年齢はどうしましょう");
    h.large.posted.length = 0;

    // 大きい画面が読み込み終わった、という合図
    await h.large.send({ type: "ready" });

    const history = received(h.large, "history");
    expect(history).toHaveLength(1);
    expect((history[0].turns as unknown[]).length).toBe(2);
    // 既に出ている側へは送らない（同じものが二重に並ぶ）
    expect(received(h.side, "history")).toHaveLength(0);
  });

  test("会話が無いうちは、履歴を送らない（実機確認リスト F-23 の代わり）", async () => {
    const h = harness();

    await h.large.send({ type: "ready" });

    expect(received(h.large, "history")).toHaveLength(0);
  });

  test("片方で「最初から」を押すと、もう片方も消える（実機確認リスト F-23 の代わり）", async () => {
    const h = harness();
    await ask(h, h.side, "灯の年齢はどうしましょう");

    await h.side.send({ type: "clear" });

    expect(received(h.large, "cleared")).toHaveLength(1);
    // 押した側は自分で消している。送り返すと行ったり来たりする
    expect(received(h.side, "cleared")).toHaveLength(0);
  });

  test("消したあとは、開き直しても前の会話が戻らない（実機確認リスト F-23 の代わり）", async () => {
    const h = harness();
    await ask(h, h.side, "灯の年齢はどうしましょう");
    await h.side.send({ type: "clear" });
    h.large.posted.length = 0;

    await h.large.send({ type: "ready" });

    expect(received(h.large, "history")).toHaveLength(0);
  });
});
