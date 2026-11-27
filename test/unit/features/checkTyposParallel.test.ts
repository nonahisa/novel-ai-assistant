import { beforeEach, describe, expect, test, vi } from "vitest";
import { window } from "../support/vscodeStub";
import type { AIRegistry } from "../../../src/ai/registry";
import type { WorkEntry } from "../../../src/models/types";

/**
 * 誤字脱字検知で、**クラウドのAIへはチャンクを3つまで同時に送る**（設計書6.76.3）。
 *
 * 見張ること：
 * - 後ろのチャンクが先に返ってきても、**結果の受け取り（控えへの書き込み）はチャンクの順**
 * - クラウドは同時に3つまで。**手元のAI（Ollama）は1つずつのまま**
 * - 中止したら新しく送らない。送信中の分は捨て、**終わっている分の控えは残す**
 *
 * AIは偽物。返す早さをテストが決める（先頭ほど遅く返す）。
 */

const state = vi.hoisted(() => ({
  /** AIへ送ったプロンプト（送った順） */
  sent: [] as string[],
  providerId: "sakura" as string,
  running: 0,
  maxRunning: 0,
  /** 何回目の送信のあとで中止を押すか（0なら押さない） */
  cancelAfterSends: 0,
  /** 何回目の送信の答えだけ、中止の前に返すか */
  quickCalls: new Set<number>(),
  cancel: undefined as (() => void) | undefined,
  /** 控えへ書いたチャンクのハッシュ（書いた順） */
  cached: [] as string[],
  logged: [] as string[],
  sources: {} as Record<string, string>,
}));

/** 正しく読める「指摘なし」の応答（`parseTypoCheckResult` が受ける形） */
const EMPTY_RESULT = JSON.stringify({ issues: [] });

vi.mock("../../../src/core/memoMarkerStore", () => import("../support/memoMarkerStoreStub"));

vi.mock("../../../src/ai/registry", async () => {
  const { AIError: AIErrorClass } = await import("../../../src/ai/types");
  return {
  ensureConfigured: vi.fn(async () => ({
    provider: {
      id: state.providerId,
      displayName: "試しのAI",
      isPaid: true,
      async testConnection() {
        return { ok: true };
      },
      async generate(request: { userPrompt: string; signal?: AbortSignal }) {
        state.sent.push(request.userPrompt);
        const call = state.sent.length;
        state.running++;
        state.maxRunning = Math.max(state.maxRunning, state.running);
        try {
          if (state.cancelAfterSends > 0 && call === state.cancelAfterSends) {
            setTimeout(() => state.cancel?.(), 15);
          }
          // 先頭ほど遅く返す（後ろのチャンクが先に終わる形）。中止なら投げる
          const wait = state.quickCalls.has(call) ? 1 : 40 - call * 5;
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(resolve, Math.max(wait, 1));
            request.signal?.addEventListener("abort", () => {
              clearTimeout(timer);
              reject(new AIErrorClass("処理が中止されました。", "aborted"));
            });
          });
          return { text: EMPTY_RESULT, truncated: false, elapsedMs: 1 };
        } finally {
          state.running--;
        }
      },
    },
    model: "test-model",
  })),
  };
});

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
      mergeChars: 1,
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
    async set(hash: string) {
      state.cached.push(hash);
    }
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
  ) => {
    const listeners: Array<() => void> = [];
    const token = {
      isCancellationRequested: false,
      onCancellationRequested: (listener: () => void) => {
        listeners.push(listener);
        return { dispose() {} };
      },
    };
    state.cancel = () => {
      token.isCancellationRequested = true;
      for (const listener of listeners) listener();
    };
    return task({ report: vi.fn() }, token);
  },
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

/** 話ごとの印。1話＝同じ字が300字並ぶ1行。6話あれば3本ずつ2巡になる */
const MARKS = ["え", "お", "か", "き", "く", "け"];

beforeEach(() => {
  state.sent = [];
  state.providerId = "sakura";
  state.running = 0;
  state.maxRunning = 0;
  state.cancelAfterSends = 0;
  state.quickCalls = new Set();
  state.cancel = undefined;
  state.cached = [];
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

/**
 * 1つずつ送ったとき（手元のAIの道）の、控えへ書くチャンクの順。
 * **チャンクのハッシュは本物の計算なので、印からは引けない。** 1つずつの道で
 * 送った順が話の順であることを確かめ、そのときの書き込み順を正とする
 */
async function sequentialOrder(): Promise<string[]> {
  state.providerId = "ollama";
  await checkTypos(work, registry);
  expect(state.sent.map(marksIn)).toEqual(MARKS.map((mark) => [mark]));
  const order = [...state.cached];
  state.sent = [];
  state.cached = [];
  state.maxRunning = 0;
  state.providerId = "sakura";
  return order;
}

describe("クラウドのAIへは3つまで同時に送る", () => {
  test("前提：1話ずつ6チャンクに分かれて送られる", async () => {
    const result = await checkTypos(work, registry);
    expect(result?.failedChunks).toBe(0);
    expect(state.sent).toHaveLength(6);
  });

  test("手元のAI（Ollama）は1つずつのまま、話の順に受け取る", async () => {
    state.providerId = "ollama";
    await checkTypos(work, registry);
    expect(state.maxRunning).toBe(1);
    expect(state.cached).toHaveLength(6);
  });

  test("同時に3つまで送り、後ろが先に返っても受け取りはチャンクの順", async () => {
    const expected = await sequentialOrder();
    await checkTypos(work, registry);
    expect(state.maxRunning).toBe(3);
    expect(state.cached).toEqual(expected);
  });
});

describe("中止したとき", () => {
  test("新しく送らない。送信中の分は捨て、終わっていた分の控えは残す", async () => {
    const order = await sequentialOrder();
    // 3つ送った少しあとに中止を押す。2つ目だけは中止の前に返ってきて、
    // 空いた枠へ4つ目が送られる
    state.cancelAfterSends = 3;
    state.quickCalls = new Set([2]);

    const result = await checkTypos(work, registry);

    expect(result?.cancelled).toBe(true);
    // 中止のあとは新しく送らない（5つ目・6つ目は送っていない）
    expect(state.sent).toHaveLength(4);
    // 終わっていた2つ目の答えは控えに残る。中止で捨てた1・3・4つ目は書かない
    expect(state.cached).toEqual([order[1]]);
    // 中止で捨てた分を失敗に数えない
    expect(result?.failedChunks ?? 0).toBe(0);
  });
});
