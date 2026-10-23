import { beforeEach, describe, expect, test, vi } from "vitest";
import { window } from "../support/vscodeStub";
import type { AIRegistry } from "../../../src/ai/registry";
import type { WorkEntry } from "../../../src/models/types";

/**
 * 誤字脱字検知の時間切れのうち、**Node の上限（約300秒）で切れたもの**
 * （`AIFetchCeilingTimeoutError`）を、AIチューニングへの誘いに数えない
 * （作者の裁定「壁のときは勧めない」、2026-10-23）。
 *
 * この時間切れは待ち時間の設定を延ばしても変わらないので、測って待ち時間を
 * 合わせる「AIチューニング」を勧めても直らない。壁でない時間切れは今までどおり数える。
 *
 * 道具立て（偽のAI・決め打ちのチャンク）は `checkTyposTruncatedSplit.test.ts` と同じ。
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
  /** 何回目の呼び出しで、どの時間切れを投げるか（1始まり） */
  throwCalls: new Map<number, "ceiling" | "plain">(),
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
        const failure = state.throwCalls.get(call);
        if (failure) {
          const { AIError, AIFetchCeilingTimeoutError } = await import(
            "../../../src/ai/types"
          );
          throw failure === "ceiling"
            ? new AIFetchCeilingTimeoutError("壁で切れた", undefined, 302, 900)
            : new AIError("待ち時間で切れた", "timeout");
        }
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
    // まとめない（1話＝1チャンク）。話ごとに別の時間切れを起こすため
    readChunkSettings: vi.fn(() => ({
      chunk: { chars: 1000, from: "model" },
      mergeChars: 0,
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
  registeredAt: "2026-10-23T00:00:00.000Z",
};

const registry = {} as unknown as AIRegistry;

beforeEach(() => {
  state.sent = [];
  state.truncateCalls = new Set();
  state.throwCalls = new Map();
  state.logged = [];
  state.sources = Object.fromEntries(
    ["え", "お", "か"].map((mark, index) => [`C:/works/w/00${index + 1}.txt`, `${mark.repeat(300)}
`])
  );
  Object.assign(window, {
    showInformationMessage: vi.fn(async () => undefined),
    showWarningMessage: vi.fn(async () => undefined),
    showErrorMessage: vi.fn(async () => undefined),
  });
});

describe("Node の上限で切れた時間切れを、チューニングの誘いに数えない", () => {
  test("前提：3話は別々のチャンクとして3回送る", async () => {
    // ここが崩れると、下の件は「1回目の失敗で全部止まった」形になり何も見ていない
    const result = await checkTypos(work, registry);

    expect(state.sent).toHaveLength(3);
    expect(result?.failedChunks).toBe(0);
  });

  test("壁で切れたチャンクは、時間切れには数えるが、壁の数にも入る", async () => {
    state.throwCalls = new Map([[1, "ceiling"]]);

    const result = await checkTypos(work, registry);

    expect(result?.failedChunks).toBe(1);
    expect(result?.timedOutChunks).toBe(1);
    expect(result?.ceilingTimedOutChunks).toBe(1);
  });

  test("壁でない時間切れは、今までどおり壁の数に入らない", async () => {
    state.throwCalls = new Map([
      [1, "plain"],
      [2, "ceiling"],
    ]);

    const result = await checkTypos(work, registry);

    expect(result?.failedChunks).toBe(2);
    expect(result?.timedOutChunks).toBe(2);
    expect(result?.ceilingTimedOutChunks).toBe(1);
  });
});
