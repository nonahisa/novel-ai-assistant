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
  PLOT_CONTINUE_OPTION,
  PLOT_END_OPTION,
  PLOT_MORE_OPTION,
  PLOT_RETRY_OPTION,
  PLOT_SKIP_OPTION,
  PLOT_START_FROM_PLOT_OPTION,
  PLOT_SUMMARY_OPTION,
  PLOT_WRITE_OPTION,
  PLOT_WRITE_SUMMARY_OPTION,
} from "../../../src/core/plotInterview";
import { PLOT_DIG_ON_OPTION, PLOT_FIELD_ORDER } from "../../../src/core/plotDialogueStyles";

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
  const systems: string[] = [];
  const ai = {
    onDidChangeSelection: () => ({ dispose: () => undefined }),
    resolve: () => ({
      provider: {
        id: "ollama",
        displayName: "Ollama",
        isPaid: false,
        generate: async (params: { userPrompt: string; systemPrompt: string }) => {
          prompts.push(params.userPrompt);
          systems.push(params.systemPrompt);
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
    systems,
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
  test("始めたときはAIを呼ばず、型を選ぶ札を出す（説明は1行ずつ）", async () => {
    const h = harness([turn({ topic: "最強の理由", question: "業者はなぜ最強なのですか？" })]);

    await h.panel.startPlotInterview(WORK);

    expect(h.prompts).toHaveLength(0);
    const first = h.posted.find((message) => message.type === "chatter");
    expect(first?.text).toContain("始め方を選んでください");
    expect(first?.text).toContain(PLOT_WRITE_OPTION);
    expect(first?.options).toEqual([
      "着想から掘る",
      "場面から広げる",
      "結末から逆算する",
      "型に当てはめる",
      "項目を順に埋める",
      PLOT_END_OPTION,
    ]);

    // 型を選んでも、まだAIは呼ばない。何を書けばよいかをコードが言う
    await h.reply("着想から掘る");
    expect(h.prompts).toHaveLength(0);
    const seed = h.posted.filter((message) => message.type === "chatter").pop();
    expect(seed?.text).toContain("自由に書いてください");
    // 雛形だけのプロットは「書いてあること」に数えない
    expect(seed?.options).not.toContain(PLOT_START_FROM_PLOT_OPTION);
  });

  test("型を選ばずに書き始めたら、着想から掘る問答としてその文を着想にする", async () => {
    const h = harness([turn({ topic: "最強の理由", question: "業者はなぜ最強なのですか？" })]);

    await h.panel.startPlotInterview(WORK);
    await h.reply(IDEA);

    expect(h.prompts).toHaveLength(1);
    expect(h.prompts[0]).toContain(`# 作者の着想\n${IDEA}`);
    expect(h.systems[0]).toContain("尋ねる順は決まっていません");
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
    // 候補 → ほかの案 → 飛ばす → 書く → まとめる → 終える
    expect(h.lastOptions()).toEqual([
      "回線が魔力も運ぶから",
      "ダンジョンの地図を握っているから",
      "配信が止まると冒険者が死ぬから",
      PLOT_MORE_OPTION,
      PLOT_SKIP_OPTION,
      PLOT_WRITE_OPTION,
      PLOT_SUMMARY_OPTION,
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
    await h.reply("着想から掘る");
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

/**
 * 型（設計書6.4.7「問答は『型の一つ』」）。作者の指示（2026-09-25）
 * 「これはプロット作成のパターンの一つ。これだけに固定しないで」。
 * どの型でも「候補はAI・決めるのは作者」「書くのは押したときだけ」
 * 「書かなくても次へ進む」「同じ問いを繰り返さない」は変わらない。
 */
describe("対話式プロット作成（型）", () => {
  const SCENE = "中級エリアで配線が切れ、配信中の新人配信者が魔物に襲われる";
  const ENDING = "最強の班長の正体は、ただの電気工事士だった";

  function lastChatter(h: ReturnType<typeof harness>): Posted | undefined {
    return h.posted.filter((message) => message.type === "chatter").pop();
  }

  test("場面から広げる：場面を起点に、外へ広げる指示で尋ねる。場面は「あらすじ」に残る", async () => {
    const h = harness([
      turn({ topic: "場面の直前", question: "配線が切れる直前、現場で何がありましたか？", section: "outline" }),
    ]);

    await h.panel.startPlotInterview(WORK);
    await h.reply("場面から広げる");
    expect(h.prompts).toHaveLength(0);
    expect(lastChatter(h)?.text).toContain("書きたい場面を書いてください");
    // 場面が無いと始まらないので、「プロットから始める」は出さない
    expect(lastChatter(h)?.options).toEqual([PLOT_END_OPTION]);

    await h.reply(SCENE);
    expect(h.prompts[0]).toContain(`# 作者が書きたい場面\n${SCENE}`);
    expect(h.systems[0]).toContain("話を外へ広げる1点");
    expect(h.topics()).toEqual(["場面の直前"]);

    await h.reply(PLOT_WRITE_OPTION);
    expect(parsePlotMarkdown(readPlot()).sections.outline).toContain(`書きたい場面：${SCENE}`);
  });

  test("場面から広げる：直前 → 至る理由 → その後 は、AIが別の1点を返してもコードの順で尋ねる", async () => {
    // 手元の gemma4:26b は、場面の直前を正面から尋ねず「配信者の背景」から始めた（2026-09-25 夜）
    const h = harness([
      turn({ topic: "配信者の背景", question: "新人配信者はなぜ中級エリアにいたのですか？", section: "mainCharacters" }),
      turn({ topic: "襲撃の理由", question: "なぜその場面に至ったのですか？", section: "mainCharacters" }),
      turn({ topic: "直後", question: "その場面のあと、何が起きますか？", section: "worldview" }),
      turn({ topic: "魔物の種類", question: "襲ってくる魔物はどんな魔物ですか？", section: "worldview" }),
    ]);

    await h.panel.startPlotInterview(WORK);
    await h.reply("場面から広げる");
    await h.reply(SCENE);
    expect(h.prompts[0]).toContain("# 次に尋ねる1点（ここだけを尋ねる）\n【場面の直前】");
    await h.reply("配信の同接が伸びず焦っていた");
    expect(h.prompts[1]).toContain("# 次に尋ねる1点（ここだけを尋ねる）\n【場面に至る理由】");
    await h.reply("業者の敷いた線を勝手に使っていた");
    expect(h.prompts[2]).toContain("# 次に尋ねる1点（ここだけを尋ねる）\n【場面のその後】");
    await h.reply("業者の班長が現れて魔物を倒す");
    // 3点を尋ね終えたら、次は目標の文字数（4問目）
    expect(h.prompts[3]).toContain("# 次に尋ねる1点（ここだけを尋ねる）\n【目標の文字数】");

    // 名前と書く先はコードの点を使う。場面の型でも、いまどこかの印は出さない
    expect(h.topics()).toEqual(["場面の直前", "場面に至る理由", "場面のその後", "目標の文字数"]);
    expect(h.posted.some((message) => message.reply?.includes("［"))).toBe(false);
    await h.reply(PLOT_WRITE_OPTION);
    const outline = parsePlotMarkdown(readPlot()).sections.outline;
    expect(outline).toContain("- 場面の直前：配信の同接が伸びず焦っていた");
    expect(outline).toContain("- 場面のその後：業者の班長が現れて魔物を倒す");
    expect(parsePlotMarkdown(readPlot()).sections.mainCharacters).toBe("");
  });

  test("着想から掘る：3問を尋ねても目標の文字数が決まっていなければ、4問目はコードが字数を尋ねる", async () => {
    // 2026-09-25 夜の実接続では、5つの型 × 2モデルの10本とも、5往復のうちに一度も字数を尋ねなかった
    const h = harness([
      turn({ topic: "最強の理由", question: "業者はなぜ最強なのですか？" }),
      turn({ topic: "主人公", question: "主人公は誰ですか？", section: "mainCharacters" }),
      turn({ topic: "敵", question: "誰と戦いますか？", section: "mainCharacters" }),
      turn({ topic: "舞台の広さ", question: "物語はどこまで広がりますか？", section: "setting" }),
      turn({ topic: "山場", question: "いちばんの山場は何ですか？", section: "outline" }),
    ]);

    await h.panel.startPlotInterview(WORK);
    await h.reply(IDEA);
    await h.reply("回線が魔力も運ぶから");
    await h.reply("その業者に入った新人");
    expect(h.prompts[2]).not.toContain("【目標の文字数】");
    await h.reply("回線を切る魔物");

    expect(h.prompts[3]).toContain("# 次に尋ねる1点（ここだけを尋ねる）\n【目標の文字数】");
    expect(h.topics().pop()).toBe("目標の文字数");
    await h.reply("10万字");
    // 決まったら、もう割り込まない
    expect(h.prompts[4]).not.toContain("# 次に尋ねる1点");
    expect(h.prompts[4]).toContain("- 【目標の文字数】10万字");
    await h.reply(PLOT_WRITE_OPTION);
    expect(parsePlotMarkdown(readPlot()).sections.outline).toContain("- 目標の文字数：10万字");
  });

  test("結末から逆算する：結末を変えない指示で、さかのぼって尋ねる", async () => {
    const h = harness([
      turn({ topic: "正体を隠す理由", question: "班長はなぜ正体を隠していたのですか？", section: "mainCharacters" }),
    ]);

    await h.panel.startPlotInterview(WORK);
    await h.reply("結末から逆算する");
    expect(lastChatter(h)?.text).toContain("決まっている終わり方を書いてください");
    await h.reply(ENDING);

    expect(h.prompts[0]).toContain(`# 作者が決めている結末\n${ENDING}`);
    expect(h.systems[0]).toContain("結末を変える候補や、結末を疑う問いを出さないこと");
    expect(h.topics()).toEqual(["正体を隠す理由"]);
  });

  test("型に当てはめる：枠を順に尋ね、名前と書く先はコードが持ち、尽きたらAIを呼ばずに締める", async () => {
    // AIは枠と違う名前・書く先を返すが、コードが決めた枠で記録する。
    // 問いの文は枠の名前だけ違う（似かたでは繰り返しに見える）
    const h = harness([
      turn({ topic: "導入", question: "起では、主人公にどんな出来事が起きますか？", section: "worldview" }),
      turn({ topic: "展開", question: "承では、主人公にどんな出来事が起きますか？", section: "worldview" }),
      turn({ topic: "転換", question: "転では、主人公にどんな出来事が起きますか？", section: "worldview" }),
      turn({ topic: "決着", question: "結では、主人公にどんな出来事が起きますか？", section: "worldview" }),
    ]);

    await h.panel.startPlotInterview(WORK);
    await h.reply("型に当てはめる");
    expect(lastChatter(h)?.options).toEqual(["三幕構成", "起承転結", "ヒーローズジャーニー", "序破急", PLOT_END_OPTION]);
    await h.reply("起承転結");
    expect(lastChatter(h)?.text).toContain("起承転結（起 → 承 → 転 → 結）で進めます。");
    expect(h.prompts).toHaveLength(0);

    await h.reply(IDEA);
    expect(h.prompts[0]).toContain("# 次に埋める枠（ここだけを尋ねる）\n【起】");
    expect(h.systems[0]).toContain("「次に埋める枠」に書いてある枠1つだけ");
    const firstTurn = h.posted.filter((message) => message.type === "answer").pop();
    expect(firstTurn?.reply).toContain("［起承転結 1/4］");

    await h.reply("新人が初現場で配線を敷く");
    await h.reply("配線が魔力を運ぶと分かる");
    await h.reply("班長が深層へ一人で潜る");
    expect(h.topics()).toEqual(["起", "承", "転", "結"]);
    expect(h.prompts[3]).toContain("【結】");

    await h.reply("班長の正体が明かされる");
    // 枠が尽きた：AIは呼ばず、締めの一言と「続けて掘る」「書く」「まとめる」「終える」だけ
    expect(h.prompts).toHaveLength(4);
    const done = h.posted.filter((message) => message.type === "answer").pop();
    expect(done?.reply).toContain("起承転結の枠は、すべて尋ねました");
    expect(done?.options).toEqual([
      PLOT_DIG_ON_OPTION,
      PLOT_WRITE_OPTION,
      PLOT_SUMMARY_OPTION,
      PLOT_END_OPTION,
    ]);

    await h.reply(PLOT_WRITE_OPTION);
    const outline = parsePlotMarkdown(readPlot()).sections.outline;
    expect(outline).toContain("- 型：起承転結");
    expect(outline).toContain(`- 着想：${IDEA}`);
    expect(outline).toContain("- 起：新人が初現場で配線を敷く");
    expect(outline).toContain("- 結：班長の正体が明かされる");
    // AIが言った書く先（世界観）へは書いていない
    expect(parsePlotMarkdown(readPlot()).sections.worldview).toBe("");
  });

  test("型に当てはめる：枠を埋め終えたら「続けて着想から掘る」で、決まったことを土台にAIが1点を選ぶ問答へ移る", async () => {
    // 作者の裁定（2026-09-25 朝）：埋め終えたあと「書く・まとめる・終える」しか無かった
    const h = harness([
      turn({ topic: "導入", question: "起では何が起きますか？" }),
      turn({ topic: "展開", question: "承では何が深まりますか？" }),
      turn({ topic: "転換", question: "転では何が覆りますか？" }),
      turn({ topic: "決着", question: "結ではどう決着しますか？" }),
      turn({ topic: "班長の過去", question: "班長は業者に入る前、何をしていましたか？", section: "mainCharacters" }),
      turn({ topic: "新人の弱み", question: "新人の弱みは何ですか？", section: "mainCharacters" }),
    ]);

    await h.panel.startPlotInterview(WORK);
    await h.reply("型に当てはめる");
    await h.reply("起承転結");
    await h.reply(IDEA);
    await h.reply("新人が初現場で配線を敷く");
    await h.reply("配線が魔力を運ぶと分かる");
    await h.reply("班長が深層へ一人で潜る");
    await h.reply("班長の正体が明かされる");
    expect(h.prompts).toHaveLength(4);

    // 枠が尽きた：続けて掘る札が、書く・まとめる・終えるの前に出る
    const done = h.posted.filter((message) => message.type === "answer").pop();
    expect(done?.reply).toContain("起承転結の枠は、すべて尋ねました");
    expect(done?.reply).toContain(`「${PLOT_DIG_ON_OPTION}」`);
    expect(done?.options).toEqual([
      PLOT_DIG_ON_OPTION,
      PLOT_WRITE_OPTION,
      PLOT_SUMMARY_OPTION,
      PLOT_END_OPTION,
    ]);

    await h.reply(PLOT_DIG_ON_OPTION);
    // 着想から掘る型の指示で、AIが1点を選ぶ（コードは枠も字数も割り込まない）
    expect(h.prompts).toHaveLength(5);
    expect(h.systems[4]).toContain("着想のいちばん強いところから");
    expect(h.prompts[4]).toContain("# 問答の型\n着想から掘る");
    expect(h.prompts[4]).toContain("型に当てはめる（起承転結）");
    expect(h.prompts[4]).not.toContain("# 次に埋める枠");
    expect(h.prompts[4]).not.toContain("# 次に尋ねる1点");
    // 決まったことと、尋ねた問いの記録を引き継ぐ（同じ問いを繰り返さない）
    expect(h.prompts[4]).toContain("- 【結】班長の正体が明かされる");
    expect(h.prompts[4]).toContain("- 結：結ではどう決着しますか？");
    expect(h.topics().pop()).toBe("班長の過去");
    const next = h.posted.filter((message) => message.type === "answer").pop();
    // いまどこかの印は出さない（AIが選ぶ型には終わりの数が無い）
    expect(next?.reply).not.toContain("［起承転結");
    expect(next?.options).toContain(PLOT_MORE_OPTION);

    // 次の回からは、着想から掘る型の決まりどおり（字数がまだなのでコードが割り込む）
    await h.reply("元は電力会社の保線員");
    expect(h.prompts[5]).toContain("# 次に尋ねる1点（ここだけを尋ねる）\n【目標の文字数】");

    await h.reply(PLOT_WRITE_OPTION);
    const written = parsePlotMarkdown(readPlot()).sections;
    expect(written.outline).toContain("- 結：班長の正体が明かされる");
    expect(written.mainCharacters).toContain("班長の過去：元は電力会社の保線員");
  });

  test("項目を順に埋める：埋め終えたあとも「続けて着想から掘る」へ移れる", async () => {
    const sections = emptyPlotSections();
    // 最後の1項目（モチーフ）だけが空の作品
    for (const key of PLOT_FIELD_ORDER) {
      if (key !== "motif") sections[key] = `作者が書いた${key}`;
    }
    disk.set(PLOT_PATH, new TextEncoder().encode(buildPlotMarkdown(WORK.title, sections)));
    const h = harness([
      turn({ topic: "モチーフの話", question: "繰り返し出すものは何ですか？", section: "motif" }),
      turn({ topic: "敵の動機", question: "敵はなぜ回線を切るのですか？", section: "mainCharacters" }),
    ]);

    await h.panel.startPlotInterview(WORK);
    await h.reply("項目を順に埋める");
    await h.reply(IDEA);
    await h.reply("切れた回線の火花");
    const done = h.posted.filter((message) => message.type === "answer").pop();
    expect(done?.reply).toContain("プロットの項目は、すべて尋ねました");
    expect(done?.options?.[0]).toBe(PLOT_DIG_ON_OPTION);

    await h.reply(PLOT_DIG_ON_OPTION);
    expect(h.prompts[1]).toContain("# 問答の型\n着想から掘る");
    expect(h.prompts[1]).toContain("項目を順に埋める");
    expect(h.prompts[1]).not.toContain("# 次に埋める項目");
    expect(h.topics().pop()).toBe("敵の動機");
  });

  test("型に当てはめる：型を札で選ばずに書いたら、選び直してもらう（着想と取り違えない）", async () => {
    const h = harness([turn({ topic: "導入", question: "起では何が起きますか？" })]);

    await h.panel.startPlotInterview(WORK);
    await h.reply("型に当てはめる");
    await h.reply("起承転結で");

    expect(h.prompts).toHaveLength(0);
    expect(lastChatter(h)?.text).toContain("型を下の札から選んでください");
  });

  test("型に当てはめる：問いを出せなかった枠は、飛ばすことも、自分で書いて答えにすることもできる", async () => {
    const bad = turn({
      topic: "導入",
      question: "起では何が起きますか？",
      candidates: ["主人公の立場を教えてほしい", "案1を元に考えてほしい", "（ここに出来事が入ります）"],
    });
    const h = harness([
      bad,
      bad,
      turn({ topic: "展開", question: "承では何が深まりますか？" }),
      bad,
      bad,
      turn({ topic: "決着", question: "結ではどう決着しますか？" }),
    ]);

    await h.panel.startPlotInterview(WORK);
    await h.reply("型に当てはめる");
    await h.reply("起承転結");
    await h.reply(IDEA);

    // 2度とも受け取れず止まった。どの枠かを言い、飛ばす札も出す
    const stopped = h.posted[h.posted.length - 1];
    expect(stopped.reply).toContain("【起】について思いついたことを書けば、その答えにします");
    expect(stopped.options).toEqual([
      PLOT_RETRY_OPTION,
      PLOT_SKIP_OPTION,
      PLOT_WRITE_OPTION,
      PLOT_SUMMARY_OPTION,
      PLOT_END_OPTION,
    ]);

    // 自分で書いたら、その枠の答えになる（補足にしない）
    await h.reply("新人が初現場で配線を敷く");
    expect(h.prompts[2]).toContain("- 【起】新人が初現場で配線を敷く");
    expect(h.prompts[2]).toContain("# 次に埋める枠（ここだけを尋ねる）\n【承】");
    // （止まったときの一言にも【起】が出るので、最後の問いだけを見る）
    expect(h.topics().pop()).toBe("承");

    // 承の問いは飛ばし、転で止まったら、その枠も飛ばせる
    await h.reply(PLOT_SKIP_OPTION);
    expect(h.prompts[3]).toContain("【転】");
    await h.reply(PLOT_SKIP_OPTION);
    expect(h.prompts[5]).toContain("- 転：大きな転換・意外な展開（作者は飛ばした）");
    expect(h.prompts[5]).toContain("# 次に埋める枠（ここだけを尋ねる）\n【結】");
  });

  test("項目を順に埋める：決まった順に、作者が書いた項目を飛ばして尋ね、書く先はその項目", async () => {
    const sections = emptyPlotSections();
    sections.logline = "作者が書いたログライン";
    disk.set(PLOT_PATH, new TextEncoder().encode(buildPlotMarkdown(WORK.title, sections)));
    const h = harness([
      turn({ topic: "テーマの話", question: "読み終えた人に何を残したいですか？", section: "worldview" }),
      turn({ topic: "世界の話", question: "この世界は現実と何が違いますか？", section: "outline" }),
    ]);

    await h.panel.startPlotInterview(WORK);
    await h.reply("項目を順に埋める");
    // プロットに書いてあるので、そこから始める札も出る
    expect(lastChatter(h)?.options).toContain(PLOT_START_FROM_PLOT_OPTION);
    await h.reply(IDEA);

    // ログラインは作者が書いているので尋ねない
    expect(h.prompts[0]).toContain("# 次に埋める項目（ここだけを尋ねる）\n【テーマ】");
    expect(h.topics()).toEqual(["テーマ"]);
    await h.reply("裏方の誇り");
    expect(h.prompts[1]).toContain("【世界観】");
    await h.reply(PLOT_WRITE_OPTION);

    const written = parsePlotMarkdown(readPlot()).sections;
    expect(written.theme).toBe("裏方の誇り");
    expect(written.logline).toBe("作者が書いたログライン");
  });
});

describe("対話式プロット作成（ほかの案・確かめ直し・まとめ）", () => {
  test("ほかの案：同じ問いのまま、見せた案と違う案を出す。何も記録しない", async () => {
    const h = harness([
      turn({
        topic: "最強の理由",
        question: "業者はなぜ最強なのですか？",
        candidates: ["回線が魔力も運ぶから", "地図を握っているから", "配信が命綱だから"],
      }),
      turn({
        topic: "最強の理由",
        question: "言い換えた問い？",
        candidates: [
          "回線が魔力も運ぶから",
          "魔物と契約しているから",
          "国が後ろ盾だから",
          "線が結界になるから",
          "班長が元勇者だから",
        ],
      }),
      turn({ topic: "主人公", question: "主人公は誰ですか？", section: "mainCharacters" }),
    ]);

    await h.panel.startPlotInterview(WORK);
    await h.reply(IDEA);
    await h.reply(PLOT_MORE_OPTION);

    expect(h.prompts[1]).toContain("ほかの案を求めています");
    expect(h.prompts[1]).toContain("- 回線が魔力も運ぶから");
    const more = h.posted.filter((message) => message.type === "answer").pop();
    expect(more?.reply).toContain("【最強の理由】のほかの案です。");
    // もう見せた案は落ち、普段（4つ）より多く出せる
    expect(h.lastOptions().slice(0, 4)).toEqual([
      "魔物と契約しているから",
      "国が後ろ盾だから",
      "線が結界になるから",
      "班長が元勇者だから",
    ]);

    await h.reply("国が後ろ盾だから");
    expect(h.prompts[2]).toContain("- 【最強の理由】国が後ろ盾だから");
    // 尋ねたことは1回だけ（ほかの案は同じ問い）
    expect(h.prompts[2].match(/- 最強の理由：/gu)).toHaveLength(1);
  });

  test("確かめ直し：切れた答えは決まったことにせず、選び直した答えで記録する。2度目は許さない", async () => {
    const h = harness([
      turn({ topic: "最強の理由", question: "業者はなぜ最強なのですか？" }),
      {
        ...turn({
          topic: "別の名前",
          question: "「回線が」の続きは、どちらですか？",
          candidates: ["回線が魔力も運ぶ", "回線が地図になる", "回線が結界になる"],
        }),
        mode: "clarify",
      },
      turn({ topic: "主人公", question: "主人公は誰ですか？" }),
    ]);

    await h.panel.startPlotInterview(WORK);
    await h.reply(IDEA);
    await h.reply("回線が");

    // 直前の答えを受けた回は確かめ直してよい
    expect(h.prompts[1]).not.toContain("この回は確かめ直しをしないこと");
    // 確かめ直しは、もとの問いの名前で出る
    expect(h.topics()).toEqual(["最強の理由", "最強の理由"]);

    await h.reply("回線が魔力も運ぶ");
    // 確かめ直しへの答えには、もう確かめ直しを許さない
    expect(h.prompts[2]).toContain("この回は確かめ直しをしないこと");
    expect(h.prompts[2]).toContain("- 【最強の理由】回線が魔力も運ぶ");
    expect(h.prompts[2]).not.toMatch(/- 【最強の理由】回線が\n/u);
  });

  test("まとめ：項目へまとめ、抜けた決まったことはコードが戻し、押したときだけ書く", async () => {
    const h = harness([
      turn({ topic: "最強の理由", question: "業者はなぜ最強なのですか？", section: "worldview" }),
      turn({ topic: "主人公", question: "主人公は誰ですか？", section: "mainCharacters" }),
      {
        logline: "〔補い〕回線業者の新人が、最強の班長と現場を回る話",
        theme: "",
        motif: "",
        worldview: "回線が魔力も運ぶ世界",
        setting: "",
        narrativePerson: "",
        protagonistMotive: "",
        outline: "- 新人が現場に入る",
        mainCharacters: "",
      },
    ]);

    await h.panel.startPlotInterview(WORK);
    await h.reply(IDEA);
    await h.reply("回線が魔力も運ぶから");
    await h.reply(PLOT_SUMMARY_OPTION);

    expect(h.systems[2]).toContain("まとめる係");
    expect(h.prompts[2]).toContain("## worldview\n- 【最強の理由】回線が魔力も運ぶから");
    const summary = h.posted.filter((message) => message.type === "answer").pop();
    expect(summary?.reply).toContain("〔補い〕はAIがつなぐために補った所");
    expect(summary?.reply).toContain("【ログライン】");
    // 着想はまとめから抜けていた。作者の言葉のまま戻す
    expect(summary?.reply).toContain("あなたの言葉のまま戻しました：着想");
    expect(summary?.options).toEqual([PLOT_WRITE_SUMMARY_OPTION, PLOT_CONTINUE_OPTION, PLOT_END_OPTION]);
    // まだ書いていない
    expect(parsePlotMarkdown(readPlot()).sections.logline).toBe("");

    await h.reply(PLOT_WRITE_SUMMARY_OPTION);
    const written = parsePlotMarkdown(readPlot()).sections;
    expect(written.logline).toBe("〔補い〕回線業者の新人が、最強の班長と現場を回る話");
    expect(written.worldview).toBe("回線が魔力も運ぶ世界");
    expect(written.outline).toContain(`- 着想：${IDEA}`);

    // 書いたあとも、いまの問いへ戻れる
    await h.reply(PLOT_CONTINUE_OPTION);
    expect(h.lastOptions()[0]).toBe("主人公の答えその一");
    expect(h.prompts).toHaveLength(3);
  });
});

/**
 * 人称の項目に「誰の目で語るか」が入った答え（0.86.12 の担当の報告。e4b が
 * 【物語の視点と語り手】の答えを人称へ書いた）。書く前に形だけを残し、
 * 誰かの部分はあらすじへ回して、作者へ示す（`settleNarrativePerson`）。
 */
describe("人称の項目には書き方の形だけを書く", () => {
  test("「ここまでをプロットに書く」：人称には形だけ、誰かはあらすじへ回し、そう示す", async () => {
    const h = harness([
      turn({
        topic: "物語の視点と語り手",
        question: "主人公は誰の目で語られますか？",
        section: "narrativePerson",
        candidates: [
          "主人公である新人ケースワーカー・ユキの一人称",
          "班長の三人称一元",
          "神視点",
        ],
      }),
      turn({ topic: "主人公", question: "主人公は誰ですか？", section: "mainCharacters" }),
    ]);

    await h.panel.startPlotInterview(WORK);
    await h.reply(IDEA);
    await h.reply("主人公である新人ケースワーカー・ユキの一人称");
    await h.reply(PLOT_WRITE_OPTION);

    const sections = parsePlotMarkdown(readPlot()).sections;
    expect(sections.narrativePerson).toBe("一人称");
    expect(sections.outline).toContain(
      "- 視点の人物：主人公である新人ケースワーカー・ユキの一人称"
    );
    // 主要登場人物には置かない（「視点の人物」という人物が資料へ積まれる）
    expect(sections.mainCharacters).not.toContain("視点の人物");
    const note = h.posted.find(
      (message) => message.type === "note" && message.message?.includes("【人称】")
    );
    expect(note?.message).toContain("「一人称」だけを書き");
  });

  test("形だけの答え（「三人称一元」）は、そのまま人称へ書き、断りも出さない", async () => {
    const h = harness([
      turn({
        topic: "人称",
        question: "どの人称で書きますか？",
        section: "narrativePerson",
        candidates: ["一人称", "三人称一元", "三人称多元"],
      }),
      turn({ topic: "主人公", question: "主人公は誰ですか？", section: "mainCharacters" }),
    ]);

    await h.panel.startPlotInterview(WORK);
    await h.reply(IDEA);
    await h.reply("三人称一元");
    await h.reply(PLOT_WRITE_OPTION);

    expect(parsePlotMarkdown(readPlot()).sections.narrativePerson).toBe("三人称一元");
    expect(
      h.posted.some((message) => message.type === "note" && message.message?.includes("【人称】"))
    ).toBe(false);
  });
});
