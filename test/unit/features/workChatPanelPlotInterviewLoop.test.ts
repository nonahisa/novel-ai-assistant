import * as nodePath from "path";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { FileSystemError, Uri, commands, window, workspace } from "../support/vscodeStub";
import type { WorkEntry } from "../../../src/models/types";
import {
  buildPlotMarkdown,
  emptyPlotSections,
  parsePlotMarkdown,
} from "../../../src/core/plotDoc";
import {
  PLOT_END_OPTION,
  PLOT_RETRY_OPTION,
  PLOT_SKIP_OPTION,
  PLOT_START_FROM_PLOT_OPTION,
  PLOT_WRITE_OPTION,
} from "../../../src/core/plotInterview";

/**
 * 対話式プロット作成（設計書6.4.7。0.86.2 で作り直した）。
 *
 * **作者の実機の報告（2026-09-24 夜）**：「選択肢が延々と出てきてループします。
 * 本題が始まらない」「あまりにかけ離れている」。0.86.1 までは決まった9項目を
 * 順に尋ねる用紙で、どの作品でも同じ選択肢（「主人公は決まっています」など）を
 * 出していた。押しても書ける中身が無く、AIが聞き返し、**次へ進むのは
 * 「AIが書き込みを返したとき」だけ**だったので、選択肢の往復が続いた。
 *
 * いまの形は問答である。作者が着想を書き、AIが1点ずつ尋ね、候補を3〜4つ
 * 添える。ここで見張るのは次のこと。
 * - **書かなくても次の問いへ進む**（ループの元を断つ）
 * - 決まったことは**作者の答えそのもの**を記録し、次の問いの材料に渡す
 * - **同じ問いを二度出さない**（AIが繰り返したらコードで止める）
 * - 候補が足りない・依頼文だらけなら、1度だけ頼み直す
 * - 書くのは「ここまでをプロットに書く」を押したときだけ。作者が書いた項目は上書きしない
 */

vi.mock("../../../src/core/logger", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/core/logger")>()),
  logFailure: () => undefined,
  logStep: () => undefined,
  logLine: () => undefined,
  useLogFile: () => undefined,
}));

const { WorkChatPanel } = await import("../../../src/features/workChatPanel");

const WORK: WorkEntry = {
  id: "w_dialogue",
  title: "回線の街",
  folderPath: nodePath.join("C:", "novels", "plot_dialogue"),
  registeredAt: "2026-09-24T00:00:00.000Z",
};
const PLOT_PATH = Uri.file(nodePath.join(WORK.folderPath, "設定", "plot.md")).fsPath;

const IDEA =
  "現代にダンジョンが出現。冒険者と配信者が現れるが、配信のための通信線を敷く業者が最強";

interface Posted {
  type: string;
  text?: string;
  reply?: string;
  options?: string[];
  preview?: string;
  message?: string;
}

const disk = new Map<string, Uint8Array>();

function readPlot(): string {
  const bytes = disk.get(PLOT_PATH);
  return bytes ? new TextDecoder().decode(bytes) : "";
}

function turn(fields: {
  topic: string;
  question: string;
  candidates?: string[];
  section?: string;
  confirm?: string;
  why?: string;
}): object {
  return {
    confirm: fields.confirm ?? "",
    topic: fields.topic,
    question: fields.question,
    why: fields.why ?? "ここが決まると話が広がります",
    candidates: fields.candidates ?? [
      `${fields.topic}の答えその一`,
      `${fields.topic}の答えその二`,
      `${fields.topic}の答えその三`,
    ],
    section: fields.section ?? "worldview",
  };
}

/** AIの答えを1つずつ差し替える。尽きたら最後のものを返し続ける */
function harness(answers: object[]) {
  const posted: Posted[] = [];
  const prompts: string[] = [];
  const ai = {
    onDidChangeSelection: () => ({ dispose: () => undefined }),
    resolve: () => ({
      provider: {
        id: "ollama",
        displayName: "Ollama",
        isPaid: false,
        generate: async (params: { userPrompt: string }) => {
          prompts.push(params.userPrompt);
          const answer = answers[Math.min(prompts.length - 1, answers.length - 1)];
          return { text: JSON.stringify(answer) };
        },
      },
      model: "gemma4:e4b",
    }),
  };
  const panel = new WorkChatPanel(
    { list: () => [WORK] } as never,
    ai as never,
    { run: async () => undefined } as never
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const inner = panel as any;
  panel.resolveWebviewView({
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
  } as never);

  return {
    panel,
    posted,
    prompts,
    reply: (text: string): Promise<void> => inner.ask(text),
    /** 画面へ出た問いの【名前】を、出た順に */
    topics: (): string[] =>
      posted
        .filter((message) => message.type === "answer")
        .flatMap((message) => {
          const found = /【(.+?)】/u.exec(message.reply as string);
          return found ? [found[1]] : [];
        }),
    lastOptions: (): string[] => {
      for (let i = posted.length - 1; i >= 0; i--) {
        const options = posted[i].options;
        if (options && options.length > 0) return options;
      }
      return [];
    },
  };
}

beforeEach(() => {
  disk.clear();
  workspace.fs = {
    stat: async (uri: { fsPath: string }) => {
      if (!disk.has(uri.fsPath)) throw new FileSystemError("missing", "FileNotFound");
      return { type: 1, ctime: 0, mtime: 0, size: 0 };
    },
    createDirectory: async () => undefined,
    readDirectory: async () => [],
    readFile: async (uri: { fsPath: string }) => {
      const bytes = disk.get(uri.fsPath);
      if (!bytes) throw new FileSystemError("missing", "FileNotFound");
      return bytes;
    },
    writeFile: async (uri: { fsPath: string }, bytes: Uint8Array) => {
      disk.set(uri.fsPath, bytes);
    },
    rename: async (from: { fsPath: string }, to: { fsPath: string }) => {
      const bytes = disk.get(from.fsPath);
      if (!bytes) throw new FileSystemError("missing", "FileNotFound");
      disk.set(to.fsPath, bytes);
      disk.delete(from.fsPath);
    },
    delete: async (uri: { fsPath: string }) => {
      disk.delete(uri.fsPath);
    },
  } as unknown as typeof workspace.fs;
  // 「プロット自力作成」が置く雛形だけの plot.md
  disk.set(
    PLOT_PATH,
    new TextEncoder().encode(
      buildPlotMarkdown(WORK.title, emptyPlotSections(), { hints: true })
    )
  );
  window.showInformationMessage = vi.fn(async () => undefined) as never;
  commands.executeCommand = (async () => undefined) as never;
});

describe("対話式プロット作成（問答）", () => {
  test("始めたときはAIを呼ばず、何をするのかを1回だけ言う", async () => {
    const h = harness([turn({ topic: "最強の理由", question: "業者はなぜ最強なのですか？" })]);

    await h.panel.startPlotInterview(WORK);

    expect(h.prompts).toHaveLength(0);
    const first = h.posted.find((message) => message.type === "chatter");
    expect(first?.text).toContain("自由に書いてください");
    expect(first?.text).toContain(PLOT_WRITE_OPTION);
    // 雛形だけのプロットは「書いてあること」に数えない
    expect(first?.options).not.toContain(PLOT_START_FROM_PLOT_OPTION);
  });

  test("書かなくても次の問いへ進む（選んだ答えがそのまま決まったことになる）", async () => {
    const h = harness([
      turn({
        topic: "最強の理由",
        question: "業者はなぜ最強なのですか？",
        candidates: ["回線が魔力も運ぶから", "ダンジョンの地図を握っているから", "配信が止まると冒険者が死ぬから"],
      }),
      turn({ topic: "主人公", question: "主人公は誰ですか？", section: "mainCharacters" }),
      turn({ topic: "目標の文字数", question: "どのくらいの長さにしますか？", section: "outline" }),
    ]);

    await h.panel.startPlotInterview(WORK);
    await h.reply(IDEA);
    expect(h.topics()).toEqual(["最強の理由"]);
    // 候補 → 飛ばす → 書く → 終える
    expect(h.lastOptions()).toEqual([
      "回線が魔力も運ぶから",
      "ダンジョンの地図を握っているから",
      "配信が止まると冒険者が死ぬから",
      PLOT_SKIP_OPTION,
      PLOT_WRITE_OPTION,
      PLOT_END_OPTION,
    ]);

    await h.reply("回線が魔力も運ぶから");
    await h.reply("その業者に入った新人");

    expect(h.topics()).toEqual(["最強の理由", "主人公", "目標の文字数"]);
    // **書いていない**（押したときだけ書く）
    expect(parsePlotMarkdown(readPlot()).sections.worldview).toBe("");

    // 次の問いの材料に、着想と作者の答えそのものが渡る
    const last = h.prompts[h.prompts.length - 1];
    expect(last).toContain(IDEA);
    expect(last).toContain("【最強の理由】回線が魔力も運ぶから");
    expect(last).toContain("【主人公】その業者に入った新人");
    // すでに尋ねたことも渡す（二度尋ねさせない）
    expect(last).toContain("最強の理由：業者はなぜ最強なのですか？");
  });

  test("AIが前と同じ問いを返したら、1度だけ頼み直し、それでも同じなら止める", async () => {
    const same = turn({ topic: "最強の理由", question: "業者はなぜ最強なのですか？" });
    const h = harness([same, same, same]);

    await h.panel.startPlotInterview(WORK);
    await h.reply(IDEA);
    await h.reply("最強の理由の答えその一");

    // 1回目の問い＋（繰り返し→頼み直し→また繰り返し）で3回
    expect(h.prompts).toHaveLength(3);
    // 頼み直しには、何が駄目だったかを添える
    expect(h.prompts[2]).toContain("すでに尋ねた「最強の理由」と同じ問い");
    // **同じ問いは画面に出さない**
    expect(h.topics()).toEqual(["最強の理由"]);
    const stopped = h.posted[h.posted.length - 1];
    expect(stopped.type).toBe("answer");
    expect(stopped.reply).toContain("同じ問いを繰り返した");
    expect(stopped.options).toContain(PLOT_RETRY_OPTION);
    expect(stopped.options).toContain(PLOT_WRITE_OPTION);
  });

  test("候補が依頼文ばかりなら頼み直す（押しても答えにならない候補を出さない）", async () => {
    const h = harness([
      turn({
        topic: "最強の理由",
        question: "業者はなぜ最強なのですか？",
        // 手元の gemma4:e4b が相談の癖で返した形
        candidates: ["主人公の立場を教えてほしい", "案1を元に考えてほしい", "（ここに理由が入ります）"],
      }),
      turn({ topic: "最強の理由", question: "業者はなぜ最強なのですか？" }),
    ]);

    await h.panel.startPlotInterview(WORK);
    await h.reply(IDEA);

    expect(h.prompts).toHaveLength(2);
    expect(h.prompts[1]).toContain("そのまま作者の答えになる文");
    expect(h.lastOptions()[0]).toBe("最強の理由の答えその一");
  });

  test("飛ばした問いは「尋ねたこと」に残り、決まったことには入らない", async () => {
    const h = harness([
      turn({ topic: "最強の理由", question: "業者はなぜ最強なのですか？" }),
      turn({ topic: "主人公", question: "主人公は誰ですか？" }),
    ]);

    await h.panel.startPlotInterview(WORK);
    await h.reply(IDEA);
    await h.reply(PLOT_SKIP_OPTION);

    const last = h.prompts[1];
    expect(last).toContain("最強の理由：業者はなぜ最強なのですか？（作者は飛ばした）");
    expect(last).not.toContain("【最強の理由】");
    expect(h.topics()).toEqual(["最強の理由", "主人公"]);
  });

  test("「ここまでをプロットに書く」は、AIを呼ばずに書き、問答は続く", async () => {
    const h = harness([
      turn({ topic: "最強の理由", question: "業者はなぜ最強なのですか？", section: "worldview" }),
      turn({ topic: "主人公", question: "主人公は誰ですか？", section: "mainCharacters" }),
    ]);

    await h.panel.startPlotInterview(WORK);
    await h.reply(IDEA);
    await h.reply("回線が魔力も運ぶから");
    const calls = h.prompts.length;

    await h.reply(PLOT_WRITE_OPTION);

    expect(h.prompts.length).toBe(calls);
    const sections = parsePlotMarkdown(readPlot()).sections;
    expect(sections.worldview).toBe("最強の理由：回線が魔力も運ぶから");
    // 着想は「あらすじ」の頭へ
    expect(sections.outline).toContain(`着想：${IDEA}`);
    // 問答は続く：いまの問いの候補がもう一度出る
    expect(h.lastOptions()).toContain("主人公の答えその一");
  });

  test("作者が書いた項目は上書きせず、書かなかった中身を見せる", async () => {
    const sections = emptyPlotSections();
    sections.worldview = "作者が自分で書いた世界観";
    disk.set(PLOT_PATH, new TextEncoder().encode(buildPlotMarkdown(WORK.title, sections)));
    const h = harness([
      turn({ topic: "最強の理由", question: "業者はなぜ最強なのですか？", section: "worldview" }),
      turn({ topic: "主人公", question: "主人公は誰ですか？" }),
    ]);

    await h.panel.startPlotInterview(WORK);
    // プロットに書いてあるので、そこから始める札が出る
    expect(h.lastOptions()).toContain(PLOT_START_FROM_PLOT_OPTION);
    await h.reply(PLOT_START_FROM_PLOT_OPTION);
    // プロットに書いてあることを材料に渡す
    expect(h.prompts[0]).toContain("【世界観】作者が自分で書いた世界観");
    await h.reply("回線が魔力も運ぶから");
    await h.reply(PLOT_WRITE_OPTION);

    expect(parsePlotMarkdown(readPlot()).sections.worldview).toBe("作者が自分で書いた世界観");
    const note = h.posted.find(
      (message) => message.type === "note" && message.message?.includes("上書きしませんでした")
    );
    expect(note?.message).toContain("【世界観】最強の理由：回線が魔力も運ぶから");
  });

  test("「問答を終える」で抜けると、次の言葉は普通の相談に戻る", async () => {
    const h = harness([turn({ topic: "最強の理由", question: "業者はなぜ最強なのですか？" })]);

    await h.panel.startPlotInterview(WORK);
    await h.reply(IDEA);
    await h.reply(PLOT_END_OPTION);

    const ended = h.posted.filter((message) => message.type === "chatter").pop();
    expect(ended?.text).toContain("問答を終えました");
    expect(ended?.text).toContain(`着想：${IDEA}`);

    const before = h.prompts.length;
    await h.reply("この話の読者層は？");
    // 普通の相談（P-21）へ回った：検索語と相談の本体で、問答の指示ではない
    const sent = h.prompts.slice(before);
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.some((prompt) => prompt.includes("# すでに尋ねたこと"))).toBe(false);
  });
});
