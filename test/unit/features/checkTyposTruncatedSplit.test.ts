import { beforeEach, describe, expect, test, vi } from "vitest";
import { window } from "../support/vscodeStub";
import type { AIRegistry } from "../../../src/ai/registry";
import type { WorkEntry } from "../../../src/models/types";

/**
 * 誤字脱字検知で、**まとめたチャンクが出力上限で切り詰められたら、話ごとに戻して
 * 試し直す**（`features/checkTypos.ts` の `if (res.truncated || !res.text.trim())`）。
 *
 * 実機確認リスト「さくらのAI Engine」節の「出力が上限で切り詰められたとき、話ごとに
 * 戻して試し直す道が通るか」（2026-10-15）。抽出の側は
 * `extractCharactersFlow.test.ts`「まとめたチャンクを先に分けるときも、半分ではなく
 * 話ごとに戻す」が見ていたが、**誤字脱字の側の戻しを見張るテストが無かった。**
 *
 * 見張ること：
 * - 4話をまとめたチャンクが切り詰められたら、**4話それぞれを1話まるごと**送り直す
 *   （半分に割ると2話ずつのまとまりがまた送られ、出力も2話ぶんのままで同じ上限に当たりうる。
 *   誤字脱字の道は「話ごとに戻す」と書いてあり、それを固定する）
 * - 2話をまたいだまま送り直さない
 * - 試し直して通ったら**失敗に数えない**（数えると、検査は済んだのに「失敗 1件」と出る）
 * - 本文が空で返ってきたとき（上限に当たって何も返らない形）も同じ道を通る
 *
 * AIは偽物。返す JSON はテストが決める。チャンクの結合と分け直しは本物を通す
 * （テストで作った話が実際にどうまとめられ、どう戻されるかまで見たいため）。
 */

const state = vi.hoisted(() => ({
  /** AIへ送ったプロンプト（送った順） */
  sent: [] as string[],
  /** 何回目の呼び出しを切り詰めるか（1始まり） */
  truncateCalls: new Set<number>(),
  /** 切り詰めたときに返す本文（"" なら何も返らない形） */
  truncatedText: "",
  /** 切り詰めの印を立てるか（false なら空の本文だけで切り詰めを表す） */
  truncatedFlag: true,
  logged: [] as string[],
  sources: {} as Record<string, string>,
}));

/** 正しく読める「指摘なし」の応答（`parseTypoCheckResult` が受ける形） */
const EMPTY_RESULT = JSON.stringify({ issues: [] });

vi.mock("../../../src/ai/registry", () => ({
  ensureConfigured: vi.fn(async () => ({
    provider: {
      id: "sakura",
      displayName: "さくらのAI Engine",
      isPaid: true,
      async testConnection() {
        return { ok: true };
      },
      async generate(request: { userPrompt: string }) {
        state.sent.push(request.userPrompt);
        const call = state.sent.length;
        if (state.truncateCalls.has(call)) {
          return { text: state.truncatedText, truncated: state.truncatedFlag, elapsedMs: 1 };
        }
        return { text: EMPTY_RESULT, truncated: false, elapsedMs: 1 };
      },
    },
    model: "test-model",
  })),
}));

// 疎通の確かめと「大きいモデルの案内」は、ここで見ることではない
vi.mock("../../../src/features/aiConnectivity", () => ({
  confirmProviderReachable: vi.fn(async () => true),
}));
vi.mock("../../../src/features/largerModelOffer", () => ({
  findLargerModelOffer: vi.fn(async () => undefined),
}));

/**
 * **まとめる大きさだけを決め打ちにする。** 本物は台帳と設定から決まり、4話（各300字）が
 * 1つにまとまるとは限らない。まとめたものが切り詰められる形を確実に作るため
 */
vi.mock("../../../src/features/chunkSettings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/features/chunkSettings")>();
  return {
    ...actual,
    resolveModelInfoOrWarn: vi.fn(async () => ({
      contextWindow: 32768,
      tier: "high",
      parameterSize: "120B",
    })),
    readChunkSettings: vi.fn(() => ({
      chunk: { chars: 1000, from: "model" },
      mergeChars: 5000,
    })),
    describeChunkSettings: vi.fn(() => "（テストの決め打ち）"),
  };
});

vi.mock("../../../src/views/notify", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/views/notify")>();
  return {
    ...actual,
    confirmRunOrChoose: vi.fn(async () => ({ kind: "run" })),
    notifyDone: vi.fn(),
    suggestAction: vi.fn(async () => "run"),
  };
});

vi.mock("../../../src/core/scanner", () => ({
  scanWork: vi.fn(async () => ({
    episodes: Object.keys(state.sources).map((filePath, index) => ({
      filePath,
      fileName: filePath.split("/").pop(),
      chapterStart: index + 1,
      chapterEnd: index + 1,
    })),
  })),
}));

vi.mock("../../../src/core/textFile", () => ({
  readTextFile: vi.fn(async (filePath: string) => ({
    text: state.sources[filePath] ?? "",
    hasConflictMarkers: false,
  })),
  // 分け直しでハッシュを取り直す。中身が違えば違う値になることだけ守る
  hashText: (text: string) => `hash-${text.length}-${text.slice(0, 1)}`,
}));

// 固有名詞の辞書・直さない語・無視の履歴は空でよい（ここで見るのは戻し方だけ）
vi.mock("../../../src/core/characterStore", () => ({
  CharacterStore: class {
    async loadAll() {
      return { characters: [], errors: [] };
    }
  },
}));
vi.mock("../../../src/core/abilityStore", () => {
  const empty = () => ({ loadAll: async () => ({ records: [], errors: [] }) });
  return {
    createAbilityStore: empty,
    createLocationStore: empty,
    createOrganizationStore: empty,
  };
});
vi.mock("../../../src/core/keepWordStore", () => ({
  KeepWordStore: class {
    async loadWords() {
      return [];
    }
  },
}));
vi.mock("../../../src/core/workStyle", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/core/workStyle")>();
  return { ...actual, readNarrativePerson: vi.fn(async () => "") };
});
vi.mock("../../../src/core/typoIssueHistory", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/core/typoIssueHistory")>();
  return {
    ...actual,
    TypoDismissedHistory: class {
      async load() {
        return new Set<string>();
      }
    },
    loadAppliedFixKeys: vi.fn(async () => new Set<string>()),
  };
});

// 控えは毎回空（すべて送る）。書いた分は捨てる
vi.mock("../../../src/core/chunkCache", () => ({
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
vi.mock("../../../src/features/aiTurn", () => ({
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

vi.mock("../../../src/core/logger", () => ({
  logStep: vi.fn((message: string) => state.logged.push(message)),
  logLine: vi.fn((message: string) => state.logged.push(message)),
  logFailure: vi.fn(),
  showLog: vi.fn(),
  useLogFile: vi.fn(),
  workLog: vi.fn(() => {
    const write = (message: string): void => {
      state.logged.push(message);
    };
    return { line: write, step: write, failure: vi.fn() };
  }),
}));

const { checkTypos } = await import("../../../src/features/checkTypos");

const work: WorkEntry = {
  id: "w1",
  title: "試しの作品",
  folderPath: "C:/works/w",
  registeredAt: "2026-10-15T00:00:00.000Z",
};

const registry = {} as unknown as AIRegistry;

/**
 * 話ごとの印。1話＝同じ字が300字並ぶ1行。
 *
 * **4話にしてある。** 3話だと「半分に割る」（`halveMergedChunk`）でも1話ずつに分かれ、
 * 話ごとに戻したのか半分に割ったのかを見分けられない（書いている途中に実際に踏んだ）
 */
const MARKS = ["え", "お", "か", "き"];

beforeEach(() => {
  state.sent = [];
  state.truncateCalls = new Set();
  state.truncatedText = "";
  state.truncatedFlag = true;
  state.logged = [];
  state.sources = Object.fromEntries(
    MARKS.map((mark, index) => [`C:/works/w/00${index + 1}.txt`, `${mark.repeat(300)}\n`])
  );
  Object.assign(window, {
    showInformationMessage: vi.fn(async () => undefined),
    showWarningMessage: vi.fn(async () => undefined),
    showErrorMessage: vi.fn(async () => undefined),
  });
});

/** プロンプトに丸ごと入っている話の印。指示文にも字は出るので、100字の連なりで見る */
function marksIn(prompt: string): string[] {
  return MARKS.filter((mark) => prompt.includes(mark.repeat(100)));
}

describe("切り詰められたまとめたチャンクを、話ごとに戻す", () => {
  test("前提：切り詰められなければ、4話は1つにまとめて1回で送る", async () => {
    // ここが崩れると、下の件は「まとめていないものを送っただけ」になり何も見ていない
    const result = await checkTypos(work, registry);

    expect(result?.failedChunks).toBe(0);
    expect(state.sent).toHaveLength(1);
    expect(marksIn(state.sent[0])).toEqual(MARKS);
  });

  test("まとめたチャンクが切り詰められたら、半分ではなく話ごとに1話まるごと送り直す", async () => {
    state.truncateCalls = new Set([1]);

    const result = await checkTypos(work, registry);

    // 1回目（4話まとめ・切り詰め）＋ 話ごとの4回。半分割りなら 1＋2 になる
    expect(state.sent).toHaveLength(5);
    expect(marksIn(state.sent[0])).toEqual(MARKS);
    const retried = state.sent.slice(1);
    // 2話をまたいだまま送り直していない
    expect(retried.filter((prompt) => marksIn(prompt).length !== 1)).toEqual([]);
    // 4話がそれぞれ、1話まるごと（300字）として送られている
    for (const mark of MARKS) {
      expect(retried.filter((prompt) => prompt.includes(mark.repeat(300)))).toHaveLength(1);
    }
    // 試し直して通ったので、失敗に数えない
    expect(result?.failedChunks).toBe(0);
    expect(result?.cancelled).toBe(false);
    const log = state.logged.join("\n");
    expect(log).toContain("切り詰められたため 4 話に分けて試し直します");
    expect(log).toContain("入り切らず 4回に分けた");
    expect(log).toContain("失敗 0件");
  });

  test("本文が空で返ってきた（上限に当たって何も返らない）ときも、話ごとに戻す", async () => {
    // 提供元によっては切り詰めの印を立てずに空を返す。印だけを見ると、この形を取りこぼす
    state.truncateCalls = new Set([1]);
    state.truncatedFlag = false;
    state.truncatedText = "   ";

    const result = await checkTypos(work, registry);

    expect(state.sent).toHaveLength(5);
    expect(state.sent.slice(1).map(marksIn)).toEqual(MARKS.map((mark) => [mark]));
    expect(result?.failedChunks).toBe(0);
  });

  test("1話だけのチャンクが切り詰められたら、それ以上は割らずに失敗として数える", async () => {
    // 戻した先の1話がまた切り詰められた形。黙って飛ばさず、失敗に数える
    state.truncateCalls = new Set([1, 2]);

    const result = await checkTypos(work, registry);

    expect(state.sent).toHaveLength(5);
    expect(result?.failedChunks).toBe(1);
  });
});
