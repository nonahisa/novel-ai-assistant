import { beforeEach, describe, expect, test, vi } from "vitest";
import { commands, window } from "vscode";
import type { WorkEntry } from "../../../src/models/types";
import {
  emptyPlotSections,
  type PlotSections,
} from "../../../src/core/plotDoc";
import { PLOT_SKIP_OPTION } from "../../../src/core/plotInterview";

/**
 * 「この項目は飛ばす」で次へ進む（ノートのソース照合、2026-09-22）。
 *
 * **0.75.2 までは、この言葉を受け取る処理がどこにも無かった。**
 * 問いの選択肢には足してあったが、次へ進む道は `advancePlotInterview`
 * だけで、そちらは**AIの提案を実際に書き込めたときにしか呼ばれない。**
 * 押すと普通の相談としてAIへ送られ、面談はその項目で止まったままになる。
 *
 * ここで見張るのは3つ——**次の問いへ進むこと**、**何も書き込まないこと**、
 * そして**同じ問いが出直さないこと**（飛ばした項目は空のままなので、
 * 覚えておかないと `nextQuestion` がまた同じ項目を返す）。
 */

// **書き出しだけを止める。** ほかの口（時刻の整形・伏せ字）は
// 相談の記録（`chatLog.ts`）が使うので、置き換えると落ちる
vi.mock("../../../src/core/logger", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/core/logger")>()),
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
  text?: string;
  options?: string[];
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

interface Harness {
  panel: InstanceType<typeof WorkChatPanel>;
  posted: Posted[];
  /** AIを呼んだ回数。飛ばすだけならAIは要らない */
  calls: { count: number };
  /** 作者の返事を送る（画面は番号で打っても文言を送ってくる） */
  reply(text: string): Promise<void>;
  /** 画面へ出た**問い**の見出しだけを、出た順に（返事の相づちは数えない） */
  headings(): string[];
}

/** 面談の途中まで進んだパネルを作る。`plot.md` は作り物で差し替える */
function harness(sections: PlotSections): Harness {
  const posted: Posted[] = [];
  const calls = { count: 0 };
  const registry = { list: () => [WORK] };
  const runner = { run: async () => undefined };
  const ai = {
    onDidChangeSelection: () => ({ dispose: () => undefined }),
    resolve: () => ({
      provider: {
        id: "ollama",
        displayName: "Ollama",
        isPaid: false,
        generate: async () => {
          calls.count++;
          return { text: "{}" };
        },
      },
      model: "gemma4:e4b",
    }),
  };

  const panel = new WorkChatPanel(
    registry as unknown as ConstructorParameters<typeof WorkChatPanel>[0],
    ai as unknown as ConstructorParameters<typeof WorkChatPanel>[1],
    runner as unknown as ConstructorParameters<typeof WorkChatPanel>[2]
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const inner = panel as any;
  // `plot.md` の読み書きはこの試験の関心ではない。**書き込みが起きない**
  // ことは、読んだ中身が最後まで変わらないことで確かめる
  inner.readPlotSections = async () => sections;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  panel.resolveWebviewView(fakeView(posted) as any);

  return {
    panel,
    posted,
    calls,
    reply: (text: string) => inner.ask(text),
    headings: () =>
      posted
        // 問いには必ず選択肢が付く。相づち（「【…】は飛ばします」）には付かない
        .filter((message) => message.type === "chatter" && message.options)
        .flatMap((message) => {
          const found = /【(.+?)】/u.exec(message.text as string);
          return found ? [found[1]] : [];
        }),
  };
}

/** 指定した項目だけを空にした `plot.md` */
function sectionsBlankOnly(...blank: string[]): PlotSections {
  const sections = emptyPlotSections();
  for (const key of Object.keys(sections) as Array<keyof PlotSections>) {
    if (!blank.includes(key)) sections[key] = "書いてあります。";
  }
  return sections;
}

beforeEach(() => {
  window.showInformationMessage = vi.fn(async () => undefined) as never;
  commands.executeCommand = (async () => undefined) as never;
});

describe("プロット面談の「この項目は飛ばす」", () => {
  test("飛ばすと次の問いへ進み、AIも呼ばず何も書き込まない", async () => {
    const sections = sectionsBlankOnly("logline", "theme");
    const h = harness(sections);

    await h.panel.startPlotInterview(WORK);
    expect(h.headings()).toEqual(["ログライン"]);
    // 飛ばす札が問いに添えられている（押す側と受ける側で同じ文言）
    const asked = h.posted.find((message) => message.options);
    expect(asked?.options).toContain(PLOT_SKIP_OPTION);

    await h.reply(PLOT_SKIP_OPTION);

    // 次の項目（テーマ）まで進んだ
    expect(h.headings()).toEqual(["ログライン", "テーマ"]);
    // **AIは呼ばない。** 止まっているAIのせいで飛ばせない、にはしない
    expect(h.calls.count).toBe(0);
    // **`plot.md` へは何も書かない。** 飛ばしたことを本文に残さない
    expect(sections.logline).toBe("");
    // 送っていないので、入力を待ち状態から戻す
    expect(h.posted.some((message) => message.type === "cancelled")).toBe(true);
  });

  test("飛ばした項目は、もう一度出てこない", async () => {
    // ログラインを飛ばしたあとテーマも飛ばす。空のままでも戻らないこと
    const h = harness(sectionsBlankOnly("logline", "theme"));

    await h.panel.startPlotInterview(WORK);
    await h.reply(PLOT_SKIP_OPTION);
    await h.reply(PLOT_SKIP_OPTION);

    expect(h.headings()).toEqual(["ログライン", "テーマ"]);
    expect(h.calls.count).toBe(0);
  });

  test("最後の項目を飛ばすと、面談が終わる", async () => {
    const h = harness(sectionsBlankOnly("motif"));

    await h.panel.startPlotInterview(WORK);
    expect(h.headings()).toEqual(["モチーフ"]);

    await h.reply(PLOT_SKIP_OPTION);

    expect(
      h.posted.some((message) => message.text?.includes("ひととおり埋まりました")),
      "終わりを告げていない"
    ).toBe(true);
    expect(h.calls.count).toBe(0);
  });

  test("面談の外で同じ言葉を打っても、普通の相談として扱う", async () => {
    // 面談を始めていないので飛ばす先が無い。ここで飲み込むと、
    // 作者の質問が黙って消える
    const h = harness(sectionsBlankOnly("logline"));

    await h.reply(PLOT_SKIP_OPTION);

    expect(h.calls.count).toBe(1);
  });

  test("似ているだけの答えは飛ばしにしない", async () => {
    // 「飛ばす」を含むだけで拾うと、作者の答えが捨てられる
    const h = harness(sectionsBlankOnly("logline", "theme"));

    await h.panel.startPlotInterview(WORK);
    await h.reply("この話は時間を飛ばす構成です");

    // 面談は進まず、普通の相談としてAIへ渡る
    expect(h.headings()).toEqual(["ログライン"]);
    expect(h.calls.count).toBe(1);
  });
});
