import { beforeEach, describe, expect, test, vi } from "vitest";
import type { WorkEntry } from "../../src/models/types";
import { buildWorkChatPanelHtml } from "../../src/views/workChatPanelHtml";
import { window } from "./support/vscodeStub";

/**
 * 面を移っても、会話の「いまの端」が消えない（ノートPCの実機、2026-09-23）。
 *
 * 横のパネルでは答えの下に選択肢（「推敲を試す」など）・番号の案内・
 * 画面の案内の誘いがあったのに、［メインに表示］で大きい画面へ移すと、
 * **答えの本文だけで選択肢が見当たらなかった。** 考えている途中に移すと、
 * 問いも「考えています…」も無い初期画面になっていた。
 *
 * 原因：後から開いた画面へ送る `history` が、**積み終えた発言の文字だけ**
 * だった。最後の答えに付いていたもの・失敗の赤字・送ったまま答えを
 * 待っている問いは、どれも履歴に積まれないので届いていなかった。
 *
 * ここでは2つを見る。
 * 1. 拡張機能側が、後から開いた画面へ**それらを送る**こと
 * 2. 画面側が、届いたものから**実際にボタンと待ち状態を作る**こと
 *    （送っていても、受け側が捨てていれば同じ見た目になる）
 */

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

interface Screen {
  posted: Posted[];
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
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
  };
}

/**
 * 相談のAI。返事は `reply` で差し替えられる。
 * 関数を渡すと、その都度呼んで返す（待たせる・失敗させるのに使う）。
 */
type Reply = () => Promise<{ text: string }>;

function fakeAi(state: { reply: Reply }) {
  return {
    onDidChangeSelection: () => ({ dispose: () => undefined }),
    resolve: () => ({
      provider: {
        id: "ollama",
        displayName: "Ollama",
        isPaid: false,
        generate: () => state.reply(),
      },
      model: "gemma4:e4b",
    }),
  };
}

interface Harness {
  panel: InstanceType<typeof WorkChatPanel>;
  side: Screen;
  large: Screen;
  state: { reply: Reply };
}

const WITH_OPTIONS: Reply = async () => ({
  text: JSON.stringify({
    reply: "この場面は説明が多めです。",
    options: ["推敲を試す", "このままにする", "別の場面を見る"],
  }),
});

function harness(): Harness {
  const side = screen();
  const large = screen();
  const state = { reply: WITH_OPTIONS };

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
    fakeAi(state) as unknown as ConstructorParameters<typeof WorkChatPanel>[1],
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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const loose = panel as any;
  loose.findRelated = async () => ({
    reference: [],
    searchTerms: [],
    materials: [],
  });
  loose.resolveContext = async () => ({
    work: WORK,
    kind: "workOnly",
    filePath: WORK.folderPath,
    label: WORK.title,
    excerpt: "",
    truncated: false,
    fromSelection: false,
    reference: [],
  });

  return { panel, side, large, state };
}

function received(target: Screen, type: string): Posted[] {
  return target.posted.filter((message) => message.type === type);
}

/** 大きい画面を「いま開いた」ことにして、届いた履歴を返す */
async function reopenLarge(h: Harness): Promise<Posted | undefined> {
  h.large.posted.length = 0;
  await h.large.send({ type: "ready" });
  return received(h.large, "history")[0];
}

/** 手で開け閉めできる返事（考えている途中を作る） */
function deferred(): { reply: Reply; release: () => void } {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    reply: async () => {
      await gate;
      return WITH_OPTIONS();
    },
    release: () => release(),
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("後から開いた画面へ、最後の答えに付いていたものを送る", () => {
  test("選択肢が届く", async () => {
    const h = harness();
    await h.side.send({ type: "ask", question: "この場面どう？" });

    const history = await reopenLarge(h);

    expect(history, "履歴が届いていない").toBeDefined();
    expect(history!.lastAnswer).toMatchObject({
      options: ["推敲を試す", "このままにする", "別の場面を見る"],
    });
  });

  test("画面の案内の誘いも届く", async () => {
    const h = harness();
    // 手順の当たりは手順書きの中身次第なので、ここでは誘いそのものを差し替える
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (h.panel as any).tourOffer = () => ({
      tour: { key: "proofread", title: "推敲を試す", steps: 3 },
    });
    await h.side.send({ type: "ask", question: "推敲はどうやるの？" });

    const history = await reopenLarge(h);

    expect(history!.lastAnswer).toMatchObject({
      tour: { key: "proofread", title: "推敲を試す", steps: 3 },
    });
  });

  test("次の問いを送ったら、前の答えの選択肢は引き継がない", async () => {
    // 画面側は送った瞬間に古い選択肢を消している。移った先でだけ
    // 古いボタンが残ると、どの返事に対する選択なのか分からなくなる
    const h = harness();
    await h.side.send({ type: "ask", question: "この場面どう？" });
    const gate = deferred();
    h.state.reply = gate.reply;
    await h.side.send({ type: "ask", question: "推敲を試す" });

    const history = await reopenLarge(h);

    expect(history!.lastAnswer).toBeUndefined();
    gate.release();
  });

  test("「最初から」のあとは何も送らない", async () => {
    const h = harness();
    await h.side.send({ type: "ask", question: "この場面どう？" });
    await h.side.send({ type: "clear" });

    expect(await reopenLarge(h)).toBeUndefined();
  });
});

describe("考えている途中に開いた画面へ、待っている問いを送る", () => {
  test("まだ会話が無くても、待っている問いが届く", async () => {
    const h = harness();
    const gate = deferred();
    h.state.reply = gate.reply;
    await h.side.send({ type: "ask", question: "灯の年齢はどうしましょう" });

    const history = await reopenLarge(h);

    expect(history, "考えている途中なのに、何も届いていない").toBeDefined();
    expect(history!.pending).toEqual({ question: "灯の年齢はどうしましょう" });
    gate.release();
  });

  test("答えが出たら、待っている問いは消える", async () => {
    const h = harness();
    const gate = deferred();
    h.state.reply = gate.reply;
    await h.side.send({ type: "ask", question: "灯の年齢はどうしましょう" });
    gate.release();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const history = await reopenLarge(h);

    expect(history!.pending).toBeUndefined();
    expect((history!.turns as unknown[]).length).toBe(2);
  });
});

describe("失敗の赤字も引き継ぐ", () => {
  test("失敗した問いと、その赤字が届く", async () => {
    const h = harness();
    h.state.reply = async () => {
      throw new Error("接続が切れました");
    };
    await h.side.send({ type: "ask", question: "この場面どう？" });
    expect(received(h.side, "error")).toHaveLength(1);

    const history = await reopenLarge(h);

    // 失敗した問いは履歴に積まれない。問いごと送らないと、移った先では
    // 何を聞いて失敗したのか分からない
    expect(history!.failure).toMatchObject({
      question: "この場面どう？",
      message: "接続が切れました",
    });
  });

  test("次の問いを送ったら、前の赤字は引き継がない", async () => {
    const h = harness();
    h.state.reply = async () => {
      throw new Error("接続が切れました");
    };
    await h.side.send({ type: "ask", question: "この場面どう？" });
    h.state.reply = WITH_OPTIONS;
    await h.side.send({ type: "ask", question: "もう一度" });

    const history = await reopenLarge(h);

    expect(history!.failure).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/* 画面側：届いた履歴から、実際にボタンと待ち状態を作るか                 */
/* ------------------------------------------------------------------ */

/**
 * 画面のスクリプトを動かすための、ごく小さな DOM の代役。
 *
 * **ここで見たいのは「届いたものを捨てていないか」だけ**なので、
 * 使われている操作（要素を足す・消す・クラスで探す）だけを持つ。
 */
class FakeElement {
  children: FakeElement[] = [];
  parent: FakeElement | undefined;
  hidden = false;
  disabled = false;
  textContent = "";
  innerHTML = "";
  className = "";
  value = "";
  title = "";
  type = "";
  scrollTop = 0;
  scrollHeight = 0;
  dataset: Record<string, string> = {};
  listeners = new Map<string, Array<(event: unknown) => void>>();
  classList = {
    add: (name: string) => {
      if (!this.className.split(" ").includes(name)) {
        this.className = (this.className + " " + name).trim();
      }
    },
    remove: (name: string) => {
      this.className = this.className
        .split(" ")
        .filter((one) => one !== name)
        .join(" ");
    },
  };
  constructor(readonly tag: string, readonly id = "") {}
  appendChild(child: FakeElement): FakeElement {
    child.parent?.removeChild(child);
    child.parent = this;
    this.children.push(child);
    return child;
  }
  removeChild(child: FakeElement): void {
    this.children = this.children.filter((one) => one !== child);
    child.parent = undefined;
  }
  remove(): void {
    this.parent?.removeChild(this);
  }
  replaceChildren(): void {
    for (const child of [...this.children]) this.removeChild(child);
  }
  addEventListener(type: string, listener: (event: unknown) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }
  setAttribute(): void {}
  focus(): void {}
  /** `.options` のような単純なクラス指定だけを扱う（それ以外は空） */
  querySelectorAll(selector: string): FakeElement[] {
    const found: FakeElement[] = [];
    const match = /^\.([\w-]+)$/.exec(selector);
    if (!match) return found;
    const walk = (node: FakeElement): void => {
      for (const child of node.children) {
        if (child.className.split(" ").includes(match[1])) found.push(child);
        walk(child);
      }
    };
    walk(this);
    return found;
  }
}

interface Page {
  deliver(message: unknown): void;
  byId(id: string): FakeElement;
  log: FakeElement;
}

function loadPage(html: string): Page {
  const found = html.match(/<script nonce="test-nonce">([\s\S]*?)<\/script>/);
  expect(found, "スクリプトが見つからない").toBeTruthy();

  const byId = new Map<string, FakeElement>();
  const root = new FakeElement("body");
  const get = (id: string): FakeElement => {
    let el = byId.get(id);
    if (!el) {
      el = new FakeElement("div", id);
      byId.set(id, el);
      // 会話の欄（log）の子だけを探せば足りる。空の案内は最初から log の中にある
      if (id === "empty") get("log").appendChild(el);
      else root.appendChild(el);
    }
    return el;
  };
  get("empty");
  // 考え中の表示は、最初は隠れている（HTML の hidden 属性）
  get("thinking").hidden = true;

  const messageListeners: Array<(event: { data: unknown }) => void> = [];
  const fakeDocument = {
    body: root,
    getElementById: get,
    createElement: (tag: string) => new FakeElement(tag),
    querySelectorAll: (selector: string) => root.querySelectorAll(selector),
    querySelector: () => null,
    addEventListener: () => undefined,
  };
  const fakeWindow = {
    addEventListener: (
      type: string,
      listener: (event: { data: unknown }) => void
    ) => {
      if (type === "message") messageListeners.push(listener);
    },
  };
  const run = new Function(
    "acquireVsCodeApi",
    "document",
    "window",
    found![1]
  );
  run(() => ({ postMessage: () => undefined }), fakeDocument, fakeWindow);

  return {
    deliver(message) {
      for (const listener of messageListeners) listener({ data: message });
    },
    byId: get,
    log: get("log"),
  };
}

const PAGES = [
  ["大きい画面", { large: true }],
  ["横のパネル", undefined],
] as const;

describe("画面側：届いた履歴から、答えの下のものを作り直す", () => {
  for (const [name, options] of PAGES) {
    test(`${name}：選択肢のボタンと番号の案内が出る`, () => {
      const page = loadPage(
        buildWorkChatPanelHtml("test-nonce", "vscode-resource:", options)
      );

      page.deliver({
        type: "history",
        turns: [
          { role: "author", text: "この場面どう？" },
          { role: "assistant", text: "説明が多めです。", html: "<p>説明が多めです。</p>" },
        ],
        lastAnswer: {
          options: ["推敲を試す", "このままにする"],
          tour: { key: "proofread", title: "推敲を試す", steps: 3 },
        },
      });

      const optionButtons = page.log
        .querySelectorAll(".option")
        .map((el) => el.innerHTML);
      expect(optionButtons.some((one) => one.includes("推敲を試す（3手順）"))).toBe(
        true
      );
      expect(optionButtons.some((one) => one.includes("このままにする"))).toBe(
        true
      );
      expect(page.byId("hint").textContent).toContain("番号（1〜2）");
    });

    test(`${name}：考えている途中なら、問いと待ち状態を出す`, () => {
      const page = loadPage(
        buildWorkChatPanelHtml("test-nonce", "vscode-resource:", options)
      );

      page.deliver({
        type: "history",
        turns: [],
        pending: { question: "灯の年齢はどうしましょう" },
      });

      const turns = page.log.children.filter((el) =>
        el.className.includes("turn")
      );
      expect(turns.map((el) => el.innerHTML).join("")).toContain(
        "灯の年齢はどうしましょう"
      );
      expect(page.byId("thinking").hidden, "考え中の表示が出ていない").toBe(
        false
      );
      expect(page.byId("send").disabled).toBe(true);
      // 空の案内は隠す（初期画面のままに見えると、止まったと思われる）
      expect(page.byId("empty").hidden).toBe(true);
    });

    test(`${name}：失敗の赤字と直し方の札を出す`, () => {
      const page = loadPage(
        buildWorkChatPanelHtml("test-nonce", "vscode-resource:", options)
      );

      page.deliver({
        type: "history",
        turns: [],
        failure: {
          question: "この場面どう？",
          message: "時間切れです。",
          actions: [{ label: "タイムアウトを600秒にする", command: "timeout-1" }],
        },
      });

      const html = page.log.children.map((el) => el.innerHTML).join("");
      expect(html).toContain("この場面どう？");
      expect(html).toContain("時間切れです。");
      const labels = page.log
        .querySelectorAll(".option")
        .map((el) => el.innerHTML);
      expect(labels.some((one) => one.includes("タイムアウトを600秒にする"))).toBe(
        true
      );
      // 失敗のあとは送り直せる状態でなければならない
      expect(page.byId("send").disabled).toBe(false);
    });
  }
});
