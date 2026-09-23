import { beforeEach, describe, expect, test, vi } from "vitest";
import { window } from "./support/vscodeStub";
import type { AIRegistry } from "../../src/ai/registry";
import type { WorkEntry } from "../../src/models/types";

/**
 * プロット逸脱の検知（設計書6.33）を、入口から1回通す。
 *
 * **これまで端から端までのテストが無かった**（0.47.5 の積み残し③）。
 * 部品ごとの試験（`deviationValidation`・`deviationPlotBudget`）はあったが、
 * 「本文を読んで、プロットと一緒に送り、返ってきたものを検算して、
 * 提案の形にする」までの配線を通したことが一度も無かった。
 *
 * **この作品で繰り返し起きた失敗が「単体テストが通っても実データで
 * 動かない」である。** 逸脱検知は実データで**全話0件**だった時期があり、
 * そのとき壊れていたのは判定ではなく配線だった。
 *
 * AIは偽物で、返す JSON はテストが決める。ここで見るのは
 *
 * - プロットが無ければ**AIを呼ばない**（呼ぶと、本文だけを見て逸脱を作り出す）
 * - 本文とプロットの**両方**が送られている
 * - 話ごとに送っている（チャンクに割らない）
 * - 検算が、プロットに無い話を落とす
 * - 読めなかった話が**黙って消えない**
 */

const state = vi.hoisted(() => ({
  /** `ensureConfigured` が引かれた機能キー */
  features: [] as string[],
  /** AIへ送った内容 */
  sent: [] as string[],
  /** AIの応答（JSON文字列） */
  response: "",
  /** AIを呼んだ回数 */
  calls: 0,
  logged: [] as string[],
  plot: "",
  episodes: [] as Array<{
    filePath: string;
    fileName: string;
    chapterStart: number | null;
    chapterEnd: number | null;
    hasConflictMarkers?: boolean;
  }>,
  /** ファイルごとの本文。無い鍵は「読めない」ものとして投げる */
  sources: {} as Record<string, string>,
}));

vi.mock("../../src/ai/registry", () => ({
  ensureConfigured: vi.fn(async (_registry: unknown, feature: string) => {
    state.features.push(feature);
    return {
      provider: {
        id: "ollama",
        displayName: "Ollama",
        isPaid: false,
        async testConnection() {
          return { ok: true };
        },
        async generate(request: { userPrompt: string }) {
          state.calls += 1;
          state.sent.push(request.userPrompt);
          return { text: state.response, truncated: false, elapsedMs: 1 };
        },
      },
      model: "test-model",
    };
  }),
}));

vi.mock("../../src/core/scanner", () => ({
  scanWork: vi.fn(async () => ({ episodes: state.episodes })),
}));

vi.mock("../../src/core/textFile", () => ({
  readTextFile: vi.fn(async (filePath: string) => {
    const text = state.sources[filePath];
    if (text === undefined) throw new Error("読めません（文字コード）");
    return { text, hasConflictMarkers: false };
  }),
  hashText: (text: string) => `hash-${text.length}`,
}));

vi.mock("../../src/core/plotFile", () => ({
  readPlotText: vi.fn(async () => state.plot),
}));

vi.mock("../../src/core/workFormatStore", () => ({
  readWorkFormat: vi.fn(async () => ({ kind: "novel" })),
}));

vi.mock("../../src/features/formatFitPrompt", () => ({
  confirmFormatFit: vi.fn(async () => true),
}));

vi.mock("../../src/core/synopsisStore", () => ({
  SynopsisStore: class {
    async load() {
      return { episodes: [] };
    }
  },
}));

vi.mock("../../src/core/chunkCache", () => ({
  ChunkCache: class {
    async load() {}
    get() {
      return undefined;
    }
    async set() {}
    async save() {}
  },
}));

// 順番待ちの札は、ここでは本体をそのまま走らせるだけでよい
vi.mock("../../src/features/aiTurn", () => ({
  withAiTurnProgress: async (
    _title: string,
    _options: unknown,
    task: (
      progress: { report: () => void },
      token: {
        isCancellationRequested: boolean;
        onCancellationRequested: (listener: () => void) => void;
      }
    ) => Promise<void>
  ) =>
    task(
      { report: vi.fn() },
      { isCancellationRequested: false, onCancellationRequested: vi.fn() }
    ),
}));

const { checkDeviations } = await import("../../src/features/checkDeviations");

const work: WorkEntry = {
  id: "w1",
  title: "試しの作品",
  folderPath: "C:/works/w",
  registeredAt: "2026-09-13T00:00:00.000Z",
};

function registry(): AIRegistry {
  return {
    resolveModelInfo: vi.fn(async () => ({
      contextWindow: 32768,
      tier: "high",
    })),
  } as unknown as AIRegistry;
}

/** 3話ぶんのプロット。第2話に「港へ着く」と書いてある */
const PLOT = [
  "# プロット",
  "",
  "## あらすじ",
  "",
  "少年が港町へ向かい、船に乗る。",
  "",
  "## 各話の流れ",
  "",
  "- 第1話　旅立ち。少年は村を出る",
  "- 第2話　到着。少年は港へ着く",
  "- 第3話　出航。少年は船に乗る",
].join("\n");

const EPISODES = [
  {
    filePath: "C:/works/w/001.txt",
    fileName: "001.txt",
    chapterStart: 1,
    chapterEnd: 1,
  },
  {
    filePath: "C:/works/w/002.txt",
    fileName: "002.txt",
    chapterStart: 2,
    chapterEnd: 2,
  },
];

const SOURCES: Record<string, string> = {
  "C:/works/w/001.txt": "　少年は村を出た。\n　背には何も無かった。",
  // **プロットと違う**：港ではなく山へ向かっている
  "C:/works/w/002.txt": "　少年は山へ登った。\n　港は遠ざかった。",
};

/**
 * 第2話の1行目が、プロットの「港へ着く」と食い違うという応答。
 *
 * **項目名は `DEVIATION_CHECK_SCHEMA` に合わせる。** ここを勝手な名前に
 * すると、検算が形で落とすだけになり、配線を確かめたことにならない
 * （書いている途中に実際に踏んだ：`quote`／`explanation`／`plot_reference`
 * と書いて、0件になった理由が分からなくなった）。
 */
function deviationFor(excerpt: string, plotRef: string): string {
  return JSON.stringify({
    deviations: [
      {
        lineStart: 1,
        lineEnd: 1,
        excerpt,
        type: "逸脱",
        reason: "プロットでは港へ着くが、本文では山へ登っている",
        plotReference: plotRef,
        severity: "中",
        confidence: "high",
      },
    ],
  });
}

beforeEach(() => {
  state.features = [];
  state.sent = [];
  state.logged = [];
  state.calls = 0;
  state.plot = PLOT;
  state.episodes = [...EPISODES];
  state.sources = { ...SOURCES };
  state.response = JSON.stringify({ deviations: [] });

  Object.assign(window, {
    showInformationMessage: vi.fn(async () => "実行"),
    showWarningMessage: vi.fn(async () => undefined),
    showErrorMessage: vi.fn(async () => undefined),
    createOutputChannel: () => ({
      appendLine: (line: string) => state.logged.push(line),
      show() {},
      dispose() {},
    }),
    withProgress: vi.fn(
      async (
        _options: unknown,
        task: (
          progress: { report: () => void },
          token: {
            isCancellationRequested: boolean;
            onCancellationRequested: () => void;
          }
        ) => Promise<unknown>
      ) =>
        task(
          { report: vi.fn() },
          { isCancellationRequested: false, onCancellationRequested: vi.fn() }
        )
    ),
  });
});

describe("端から端まで", () => {
  test("本文とプロットを送り、返ってきた指摘が提案の形になる", async () => {
    state.response = deviationFor("少年は山へ登った。", "第2話　到着。少年は港へ着く");

    const result = await checkDeviations(work, registry());

    expect(result).toBeDefined();
    // **話ごとに1回ずつ**。チャンクに割らない（切れ目で間延びの判定が壊れる）
    expect(state.calls).toBe(EPISODES.length);
    // 割り当ては `deviation`（ほかの機能の枠を使っていない）
    expect(state.features).toEqual(["deviation"]);

    // 送った中身に、**本文とプロットの両方**が入っている
    const sent = state.sent[1];
    expect(sent).toContain("少年は山へ登った");
    expect(sent).toContain("少年は港へ着く");

    expect(result?.issues.length).toBeGreaterThan(0);
    const issue = result?.issues[0];
    expect(issue?.filePath).toBe("C:/works/w/002.txt");
    expect(issue?.excerpt).toContain("少年は山へ登った");
  });

  test("**プロットが無ければ、AIを呼ばない**", async () => {
    // 照らし合わせる相手が無いのに問うと、AIは本文だけを見て
    // 「逸脱していそうなこと」を作り出す（設計書6.33）
    state.plot = "";

    const result = await checkDeviations(work, registry());

    expect(result).toBeUndefined();
    expect(state.calls).toBe(0);
    expect(state.features).toEqual([]);
  });

  test("**本文に無い引用は落とす**（AIの言い値を作者へ届けない）", async () => {
    state.response = deviationFor(
      "少年は海へ飛び込んだ。",
      "第2話　到着。少年は港へ着く"
    );

    const result = await checkDeviations(work, registry());

    expect(result?.issues).toHaveLength(0);
    expect(result?.rejectedCount).toBeGreaterThan(0);
  });

  test("**プロットに無い照らし先は落とし、件数を残す**", async () => {
    // 「プロットのここと違う」と言いながら、プロットにその記述が無いもの。
    // 黙って通すと、作者は在りもしない筋と比べられることになる
    state.response = deviationFor(
      "少年は山へ登った。",
      "第9話　決戦。少年は竜と戦う"
    );

    const result = await checkDeviations(work, registry());

    expect(result?.issues).toHaveLength(0);
    expect(result?.ungroundedCount).toBeGreaterThan(0);
  });

  test("**読めなかった話は、黙って消さずに数える**", async () => {
    // 文字コードの壊れた話が1つあると、その話だけ対象から抜けるのに、
    // 作者には「その話には何も無い」と見える
    delete state.sources["C:/works/w/002.txt"];

    const result = await checkDeviations(work, registry());

    expect(result?.unreadableEpisodes).toBe(1);
    // 読めた話だけは見ている
    expect(state.calls).toBe(1);
  });

  test("見る本文が1つも無ければ、AIを呼ばずに断る", async () => {
    state.episodes = [];

    const result = await checkDeviations(work, registry());

    expect(result).toBeUndefined();
    expect(state.calls).toBe(0);
    expect(window.showWarningMessage).toHaveBeenCalled();
  });
});
