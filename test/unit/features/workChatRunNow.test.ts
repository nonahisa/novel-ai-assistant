import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { workspace } from "vscode";
import type { WorkEntry } from "../../../src/models/types";
import type { ChatRunKind } from "../../../src/core/chatEdit";
import { useMemoryTuningStore } from "../support/tuningStore";

/**
 * 作者がはっきり頼んだら、押すのを待たずに機能を動かす（作者の判断、2026-10-31
 * 「明確な意思表示があるなら、AIが機能を実行しても良いのでは？」）。
 *
 * 守ること：
 * 1. AIの印（runNow）＋一覧にある操作（run）＋作者の頼みの形、の3つがそろったときだけ動く
 * 2. 相談・質問では動かない（AIが印を立てても）
 * 3. 一覧に無い名前は動かない。印の値が真偽の true 以外なら動かない（指示の語が返っても）
 * 4. 動かしたあとも答えの下のボタンが残り、もう一度押せる
 * 5. 動かしたことは会話に1行で出る
 *
 * 組み方は `workChatExecutionClaim.test.ts` と同じ（AIだけ作り物）。
 * 確認の窓（料金・処理量）は、走る先のコマンドが出す——ここでは `runner.run` に
 * 渡ったところまでを見る（`extension.ts` の `run` が `markInferredWork` を付ける）。
 */

const response = vi.hoisted(() => ({ text: "" }));

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

vi.mock("../../../src/features/aiConnectivity", () => ({
  confirmProviderReachable: async () => true,
  confirmPaidUsage: async () => true,
}));

const { WorkChatPanel } = await import("../../../src/features/workChatPanel");

const WORK: WorkEntry = {
  id: "w_textbook",
  title: "教科書チート",
  folderPath: "C:\\novels\\w_textbook",
  registeredAt: "2026-10-31T00:00:00.000Z",
};

interface Posted {
  type: string;
  message?: string;
  reply?: string;
  run?: { id: string; label: string } | undefined;
}

function harness(): {
  panel: InstanceType<typeof WorkChatPanel>;
  posted: Posted[];
  runs: Array<{ work: string; kind: ChatRunKind }>;
} {
  const posted: Posted[] = [];
  const runs: Array<{ work: string; kind: ChatRunKind }> = [];
  const ai = {
    onDidChangeSelection: () => ({ dispose: () => undefined }),
    resolve: () => ({
      provider: {
        id: "ollama",
        displayName: "Ollama",
        isPaid: false,
        generate: async () => ({ text: response.text }),
      },
      model: "gemma4:26b",
    }),
  };
  const panel = new WorkChatPanel(
    { list: () => [WORK] } as never,
    ai as never,
    {
      run: async (work: WorkEntry, kind: ChatRunKind) => {
        runs.push({ work: work.id, kind });
      },
    } as never
  );
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const inner = panel as any;
  inner.findRelated = async () => ({ reference: [], searchTerms: [], materials: [] });
  inner.resolveContext = async () => ({
    work: WORK,
    kind: "workOnly",
    filePath: WORK.folderPath,
    label: WORK.title,
    excerpt: "",
    truncated: false,
    fromSelection: false,
    reference: [],
  });
  return { panel, posted, runs };
}

async function ask(panel: InstanceType<typeof WorkChatPanel>, question: string): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (panel as any).ask(question);
}

async function press(panel: InstanceType<typeof WorkChatPanel>, id: string): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (panel as any).runFeature(id);
}

function reply(text: string, run: unknown, runNow: unknown): string {
  return JSON.stringify({ reply: text, options: [], needFiles: [], run, runNow });
}

/** 動かしたことを示す1行（`chatRunNowMessage`） */
const RUN_NOW_NOTE = "頼まれたので";

const originalConfig = workspace.getConfiguration;
beforeEach(async () => {
  await useMemoryTuningStore({});
  workspace.getConfiguration = (() => ({
    get: <T>(_key: string, defaultValue: T): T => defaultValue,
    update: async () => undefined,
  })) as unknown as typeof workspace.getConfiguration;
});
afterEach(() => {
  workspace.getConfiguration = originalConfig;
});

describe("はっきり頼まれたら、押すのを待たずに動かす", () => {
  test("「資料抽出を実行して」で印が立てば、相談の作品で1回動く", async () => {
    response.text = reply("設定資料をまとめて抽出します。", "extractSettings", true);
    const h = harness();

    await ask(h.panel, "資料抽出を実行して");

    expect(h.runs).toEqual([{ work: WORK.id, kind: "extractSettings" }]);
    const notes = h.posted.filter(
      (m) => m.type === "note" && m.message?.includes(RUN_NOW_NOTE)
    );
    expect(notes, "動かしたことが会話に1行出ていない").toHaveLength(1);
    expect(notes[0].message).toContain("「設定資料をまとめて抽出する」");
    // 答えより後に出る（答えの上に出ると、何の話か分からない）
    const answerAt = h.posted.findIndex((m) => m.type === "answer");
    expect(h.posted.indexOf(notes[0])).toBeGreaterThan(answerAt);
  });

  test("動かしたあとも答えの下のボタンが残り、もう一度押せる", async () => {
    response.text = reply("誤字脱字を検知します。", "checkTypos", true);
    const h = harness();

    await ask(h.panel, "誤字脱字を走らせてください");
    const answer = h.posted.find((m) => m.type === "answer");
    expect(answer?.run, "ボタンが出ていない").toBeTruthy();
    expect(h.runs).toHaveLength(1);

    await press(h.panel, answer!.run!.id);
    expect(h.runs, "ボタンを押しても動かない（控えが消えている）").toHaveLength(2);
    expect(
      h.posted.some((m) => m.type === "error"),
      "「この提案はもう使えません」が出た"
    ).toBe(false);
  });

  test("質問の形なら、印が立っていても動かさない（ボタンだけ）", async () => {
    for (const question of [
      "抽出ってできる？",
      "どうすればいい？",
      "抽出の使い方を教えて",
      "設定資料を抽出したほうがいいですか？",
    ]) {
      response.text = reply("設定資料の抽出が使えます。", "extractSettings", true);
      const h = harness();
      await ask(h.panel, question);
      expect(h.runs, question).toEqual([]);
      expect(
        h.posted.some((m) => m.type === "note" && m.message?.includes(RUN_NOW_NOTE)),
        question
      ).toBe(false);
    }
  });

  test("印が立っていなければ、頼まれてもボタンを出すだけ（これまでどおり）", async () => {
    response.text = reply("設定資料をまとめて抽出できます。", "extractSettings", false);
    const h = harness();

    await ask(h.panel, "資料抽出を実行して");

    expect(h.runs).toEqual([]);
    expect(h.posted.find((m) => m.type === "answer")?.run).toBeTruthy();
  });

  test("一覧に無い名前は、印が立っていても動かさない", async () => {
    for (const run of [
      "deleteWork",
      "novelai.removeWork",
      // 指示の言葉がそのまま返ってくる（CLAUDE.md の失敗3）
      "今すぐ動かす",
      "runNow",
      "...",
    ]) {
      response.text = reply("実行します。", run, true);
      const h = harness();
      await ask(h.panel, "削除して");
      expect(h.runs, run).toEqual([]);
    }
  });

  test("印の値が真偽の true でなければ動かさない（指示の語が返っても）", async () => {
    for (const runNow of ["true", 1, "今すぐ動かす", "runNow", "yes", {}, [true]]) {
      response.text = reply("設定資料をまとめて抽出します。", "extractSettings", runNow);
      const h = harness();
      await ask(h.panel, "資料抽出を実行して");
      expect(h.runs, JSON.stringify(runNow)).toEqual([]);
    }
  });

  test("AIが名指ししていないボタン（規則で補ったもの）は、印があっても動かさない", async () => {
    // run を落として印だけ立てた回。ボタンは規則（detectRunIntent）で補われる
    response.text = reply("抽出します。", null, true);
    const h = harness();

    await ask(h.panel, "設定を抽出して");

    expect(h.posted.find((m) => m.type === "answer")?.run, "補いのボタンが出ていない").toBeTruthy();
    expect(h.runs).toEqual([]);
  });

  test("話題の合わない操作は、印があっても動かさない", async () => {
    // 読者層の相談に誤字脱字の検知が返った（2026-09-25 の測定と同じ形）
    response.text = reply("読者層を考えましょう。", "checkTypos", true);
    const h = harness();

    await ask(h.panel, "読者層を一緒に考えてほしい");

    expect(h.runs).toEqual([]);
  });

  test("動かして失敗しても、答えは残り、失敗を赤字で知らせる", async () => {
    response.text = reply("誤字脱字を検知します。", "checkTypos", true);
    const h = harness();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (h.panel as any).runner = {
      run: async () => {
        throw new Error("試験の失敗");
      },
    };

    await ask(h.panel, "誤字脱字を検知して");

    expect(h.posted.some((m) => m.type === "answer")).toBe(true);
    const error = h.posted.find((m) => m.type === "error");
    expect(JSON.stringify(error)).toContain("試験の失敗");
  });
});
