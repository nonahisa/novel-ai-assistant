import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { commands, window } from "vscode";
import type { WorkEntry } from "../../../src/models/types";

/**
 * 「対話でプロットを作る」を、相談パネルを開かずに押したとき
 * （2026-09-21の実機確認で見つけた不具合）。
 *
 * **実機で困ったこと**：詳細メニューから押して作品を選んでも、画面にも
 * 通知にも何も出なかった。`startPlotInterview()` は送り先（`hosts()`）が
 * 無いと黙って戻っており、パネルを開いてから押すと正常に動く。
 * 作者からは「押したのに壊れている」としか見えない。
 *
 * ここで見張るのは**押した結果が必ず作者へ届くこと**である。
 * 送り先を作れたなら相談パネルへ、作れなかったなら理由を通知へ。
 */

vi.mock("../../../src/core/logger", () => ({
  logFailure: () => undefined,
  logStep: () => undefined,
  logLine: () => undefined,
  useLogFile: () => undefined,
}));

const { WorkChatPanel } = await import("../../../src/features/workChatPanel");

const WORK: WorkEntry = {
  id: "w_a",
  title: "氷の街",
  folderPath: "C:\\novels\\w_a",
  registeredAt: "2026-09-05T00:00:00.000Z",
};

interface Posted {
  type: string;
  message?: string;
  text?: string;
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

function fakeAi() {
  return {
    onDidChangeSelection: () => ({ dispose: () => undefined }),
    resolve: () => ({
      provider: {
        id: "ollama",
        displayName: "Ollama",
        isPaid: false,
        generate: async () => ({ text: "{}" }),
      },
      model: "gemma4:e4b",
    }),
  };
}

interface Harness {
  panel: InstanceType<typeof WorkChatPanel>;
  posted: Posted[];
  /** 相談パネルの画面を、あとから（コマンドの中などで）用意する */
  attachView(): void;
}

/** **画面をまだ持っていない**パネルを作る（実機の症状と同じ状態） */
function harness(): Harness {
  const posted: Posted[] = [];
  const registry = { list: () => [WORK] };
  const runner = { run: async () => undefined };
  const panel = new WorkChatPanel(
    registry as unknown as ConstructorParameters<typeof WorkChatPanel>[0],
    fakeAi() as unknown as ConstructorParameters<typeof WorkChatPanel>[1],
    runner as unknown as ConstructorParameters<typeof WorkChatPanel>[2]
  );
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
    panel,
    posted,
    attachView() {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      panel.resolveWebviewView(fakeView(posted) as any);
    },
  };
}

let executed: string[];
let shown: string[];

beforeEach(() => {
  executed = [];
  shown = [];
  window.showInformationMessage = vi.fn(async (message: string) => {
    shown.push(message);
    return undefined;
  }) as never;
});

afterEach(() => {
  vi.useRealTimers();
  commands.executeCommand = (async () => undefined) as never;
});

describe("相談パネルが開いていないときの「対話でプロットを作る」", () => {
  test("相談パネルを開いてから始める", async () => {
    const h = harness();
    // 本物の `novelai.openChat` は相談ビューを前に出し、VS Code が
    // `resolveWebviewView` を呼ぶ。その筋道を作り物で再現する
    commands.executeCommand = vi.fn(async (command: string) => {
      executed.push(command);
      if (command === "novelai.openChat") h.attachView();
      return undefined;
    }) as never;

    await h.panel.startPlotInterview(WORK);

    expect(executed).toContain("novelai.openChat");
    // **押した結果が画面へ届いている**ことが本題。中身（プロットが無い、
    // 最初の質問、のどちら）はこの試験の関心ではない
    expect(h.posted.length).toBeGreaterThan(0);
    expect(shown, "開けたのなら通知は出さない").toEqual([]);
  });

  test("パネルを開けなかったら、理由を出して終わる", async () => {
    const h = harness();
    // 開く道が塞がっている状態（コマンドを呼んでも画面が現れない）
    commands.executeCommand = vi.fn(async (command: string) => {
      executed.push(command);
      return undefined;
    }) as never;

    vi.useFakeTimers();
    const running = h.panel.startPlotInterview(WORK);
    // 画面が現れるのを待つ時間を飛ばす
    await vi.advanceTimersByTimeAsync(10_000);
    await running;
    vi.useRealTimers();

    // **黙って戻らない。** 何が足りないのかと、次にどうすればよいのかを出す
    expect(shown.length, "何も知らせていない").toBeGreaterThan(0);
    expect(shown.join("\n")).toContain("AIに相談");
  });

  test("新作のプロット相談（startPlotAdvice）にも同じ穴を残さない", async () => {
    const h = harness();
    commands.executeCommand = vi.fn(async (command: string) => {
      executed.push(command);
      if (command === "novelai.openChat") h.attachView();
      return undefined;
    }) as never;

    await h.panel.startPlotAdvice(WORK);

    expect(executed).toContain("novelai.openChat");
    // 最初の一言（プロットを一緒に考えましょうか）が届いている
    expect(
      h.posted.some((message) => message.type === "chatter"),
      "最初の一言が出ていない"
    ).toBe(true);
  });

  test("すでに開いているなら、開き直さない", async () => {
    const h = harness();
    h.attachView();
    commands.executeCommand = vi.fn(async (command: string) => {
      executed.push(command);
      return undefined;
    }) as never;

    await h.panel.startPlotInterview(WORK);

    // 開いている画面をわざわざ前へ出し直すと、作者が見ていた場所が動く
    expect(executed).not.toContain("novelai.openChat");
    expect(h.posted.length).toBeGreaterThan(0);
  });
});
