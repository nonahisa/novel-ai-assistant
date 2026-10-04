import { describe, expect, test, vi } from "vitest";
import * as vscode from "vscode";
import type { AIRegistry } from "../../../src/ai/registry";
import type { WorkEntry } from "../../../src/models/types";

/**
 * 校正・メモパネルの［AIに相談］が、相談パネルへ問いを送る口
 * （`WorkChatPanel.askFromOutside`。作者の要望 2026-10-04「AIからの助言も欲しいです」。
 * 設計書6.96.5）。
 *
 * **作者が入力欄から送ったときと同じ `ask` を通す**ことを見る——使うAI（相談の
 * 割当）・繋がるかの確認・有料の確認はすべて `ask` の中にあるので、ここを
 * 迂回していなければ同じ確認の窓を通る。**AI は呼ばない**（`ask` を差し替える）。
 *
 * 画面には作者の発言として積み、答えを待つ状態にする（`asked`）。答えを待って
 * いる途中なら送らない。
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
const { buildFindingAdviceQuestion } = await import("../../../src/prompts/workChat");

const WORK: WorkEntry = {
  id: "w_consult",
  title: "氷の街",
  folderPath: "C:\\novels\\w_consult",
  registeredAt: "2026-10-04T00:00:00.000Z",
};

function openPanel(works: WorkEntry[] = [WORK]): {
  panel: InstanceType<typeof WorkChatPanel>;
  posted: Array<{ type?: string; question?: string }>;
  asked: string[];
} {
  const posted: Array<{ type?: string; question?: string }> = [];
  // 相談の割当の見張り（`onDidChange…`）は、どれも何もしない耳で足りる
  const listen = () => ({ dispose: () => undefined });
  const ai = new Proxy(
    { resolve: () => undefined },
    {
      get: (target, key) =>
        key in target
          ? target[key as keyof typeof target]
          : typeof key === "string" && key.startsWith("onDid")
            ? listen
            : undefined,
    }
  ) as unknown as AIRegistry;
  const panel = new WorkChatPanel(
    { list: () => works } as unknown as ConstructorParameters<typeof WorkChatPanel>[0],
    ai,
    { run: async () => undefined } as unknown as ConstructorParameters<
      typeof WorkChatPanel
    >[2]
  );
  panel.resolveWebviewView({
    visible: true,
    webview: {
      options: {},
      html: "",
      cspSource: "vscode-webview:",
      onDidReceiveMessage: () => ({ dispose: () => undefined }),
      postMessage: (message: { type?: string; question?: string }) => {
        posted.push(message);
        return Promise.resolve(true);
      },
    },
    onDidDispose: () => ({ dispose: () => undefined }),
  } as never);
  const asked: string[] = [];
  // **AI を呼ばない。** 作者が入力欄から送ったときの口（private の `ask`）を差し替え、
  // そこへ届いたかだけを見る
  vi.spyOn(panel as unknown as { ask: (q: string) => Promise<void> }, "ask").mockImplementation(
    async (question: string) => {
      asked.push(question);
    }
  );
  return { panel, posted, asked };
}

const QUESTION = buildFindingAdviceQuestion({
  place: "003.txtの2行目",
  quote: "　夜が明けた。",
  finding: "視点：ここだけ語り手が外から見ています",
});

describe("［AIに相談］の依頼文（P-21 3.25）", () => {
  test("場所・一文・指摘の中身と、頼み方の3つの決まりが入る", () => {
    expect(QUESTION).toContain("003.txtの2行目");
    // 段落の頭の全角空白は落とす（trim は U+3000 も落とす）
    expect(QUESTION).toContain("【本文の一文】夜が明けた。");
    expect(QUESTION).toContain("視点：ここだけ語り手が外から見ています");
    expect(QUESTION).toContain("文体を尊重");
    expect(QUESTION).toContain("書き換えた本文の全体は作らないでください");
    expect(QUESTION).toContain("私が決めます");
  });

  test("長い一文は切り、改行は畳む（合本の長い行で膨らませない）", () => {
    const long = buildFindingAdviceQuestion({
      place: "第1話",
      quote: "あ".repeat(500),
      finding: "一行目\n二行目",
    });
    expect(long).toContain(`${"あ".repeat(300)}…`);
    expect(long).not.toContain("あ".repeat(301));
    expect(long).toContain("【指摘】一行目 二行目");
  });
});

describe("相談パネルへ送る口", () => {
  test("作者の発言として画面に積み、入力欄から送ったときと同じ ask を通す", async () => {
    const { panel, posted, asked } = openPanel();

    expect(await panel.askFromOutside(QUESTION)).toBe(true);

    expect(posted).toContainEqual({ type: "asked", question: QUESTION });
    expect(asked).toEqual([QUESTION]);
  });

  test("相談の相手（文書と範囲）を渡すと、素のエディターが無くてもその話の作品で相談する", async () => {
    // **2つ目の作品に置く。** 選んである作品（先頭）と区別できないと、渡した
    // 相手が効いたのか、作品の既定に倒れただけなのかが分からない
    const other: WorkEntry = {
      id: "w_other",
      title: "雪の町",
      folderPath: "C:\\novels\\w_other",
      registeredAt: "2026-10-04T00:00:00.000Z",
    };
    const { panel } = openPanel([WORK, other]);
    // 上部の表示の組み直し（作品設定を読みに行く）は、ここでは見ない
    vi.spyOn(
      panel as unknown as { postContext: () => Promise<void> },
      "postContext"
    ).mockResolvedValue(undefined);
    const seen: Array<string | undefined> = [];
    vi.spyOn(panel as unknown as { ask: (q: string) => Promise<void> }, "ask").mockImplementation(
      async () => {
        seen.push(panel.currentWorkId());
      }
    );
    const document = {
      uri: vscode.Uri.file("C:\\novels\\w_other\\001.txt"),
      getText: () => "　朝が来た。",
      offsetAt: () => 0,
    } as unknown as vscode.TextDocument;
    const range = {
      start: { line: 0, character: 0 },
      end: { line: 0, character: 6 },
      active: { line: 0, character: 6 },
    } as unknown as vscode.Range;

    expect(await panel.askFromOutside(QUESTION, { document, range })).toBe(true);
    expect(seen).toEqual(["w_other"]);
  });

  test("答えを待っている途中なら、送らない", async () => {
    const { panel, asked } = openPanel();
    let release: () => void = () => undefined;
    const spy = vi.spyOn(panel as unknown as { ask: (q: string) => Promise<void> }, "ask");
    spy.mockImplementationOnce(
      (question: string) =>
        new Promise<void>((resolve) => {
          asked.push(question);
          release = resolve;
        })
    );

    const first = panel.askFromOutside(QUESTION);
    await vi.waitFor(() => expect(asked).toHaveLength(1));
    expect(await panel.askFromOutside("二つ目の問い")).toBe(false);
    release();
    await first;
    expect(asked).toEqual([QUESTION]);
  });
});
