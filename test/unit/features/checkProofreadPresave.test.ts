import { beforeEach, describe, expect, test, vi } from "vitest";
import { window } from "../support/vscodeStub";
import type { AIRegistry } from "../../../src/ai/registry";
import type { WorkEntry } from "../../../src/models/types";

const state = vi.hoisted(() => ({
  /** AIへ送ったプロンプト（送った順） */
  sent: [] as string[],
  /** 何回目の呼び出しを切り詰めるか（1始まり） */
  truncateCalls: new Set<number>(),
  /** 何回目の呼び出しで、切り詰めの印を立てずに空の本文を返すか（1始まり） */
  emptyCalls: new Set<number>(),
  /** 何回目の呼び出しで、空でないが読めない本文を返すか（1始まり） */
  brokenCalls: new Set<number>(),
  logged: [] as string[],
  failures: [] as string[],
  sources: {} as Record<string, string>,
  /** 確認が呼ばれたときの選択肢 */
  confirms: [] as Array<{ presave?: { count: number; save(): Promise<boolean> } }>,
  /** 確認で［実行］を押すか */
  confirmAnswer: true,
  /** 控えに全部あるふりをする（処理済みばかり） */
  allCached: false,
}));

/** 正しく読める「指摘なし」の応答（`parseProofreadResult` が受ける形） */
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
          // 上限で切られて、読める JSON にならなかった形
          return { text: '{"issues": [{"original": "', truncated: true, elapsedMs: 1 };
        }
        if (state.emptyCalls.has(call)) {
          // 提供元によっては、上限に当たっても印を立てずに空（空白だけ）を返す
          return { text: "  \n", truncated: false, elapsedMs: 1 };
        }
        if (state.brokenCalls.has(call)) {
          return { text: "指摘はありません", truncated: false, elapsedMs: 1 };
        }
        return { text: EMPTY_RESULT, truncated: false, elapsedMs: 1 };
      },
    },
    model: "test-model",
  })),
}));

// 疎通の確かめは、ここで見ることではない
vi.mock("../../../src/features/aiConnectivity", () => ({
  confirmProviderReachable: vi.fn(async () => true),
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
    // 本物の確認と同じく、［実行］なら保存の口を呼ぶ（`views/notify.ts` の `savedBeforeRun`）
    confirmRun: vi.fn(async (_message: string, _label: string, options: { presave?: { count: number; save(): Promise<boolean> } } = {}) => {
      state.confirms.push(options);
      if (!state.confirmAnswer) return false;
      if (options.presave && options.presave.count > 0) return options.presave.save();
      return true;
    }),
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

// 人物の資料・直さない語は空でよい（ここで見るのは戻し方だけ。語り手が決まらないので
// 語り手の名前の確認も黙る）
vi.mock("../../../src/core/characterStore", () => ({
  CharacterStore: class {
    async loadAll() {
      return { characters: [], errors: [] };
    }
  },
}));
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

// 控えは毎回空（すべて送る）。書いた分は捨てる
vi.mock("../../../src/core/chunkCache", () => ({
  ChunkCache: class {
    async load() {}
    get() {
      return state.allCached ? { issues: [] } : undefined;
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
  responseExcerptForLog: (text: string) => text.slice(0, 40),
  workLog: vi.fn(() => {
    const write = (message: string): void => {
      state.logged.push(message);
    };
    return {
      line: write,
      step: write,
      failure: (_label: string, detail: Record<string, string>) => {
        state.failures.push(JSON.stringify(detail));
      },
    };
  }),
}));

const { checkProofread } = await import("../../../src/features/checkProofread");

/**
 * 推敲の前の未保存を、**実行の確認の窓で保存する**（作者の判断 2026-11-02）。
 *
 * 確認の前に本文を読む（見積もりに要る）ので、読んだのは保存前のファイルである。
 * ［実行］で保存したら、**保存した本文で読み直してから**AIへ送る。見張ること：
 * - 確認は1回だけ（読み直しの2回目では出さない）
 * - AIへ送るのは保存したあとの本文
 * - 処理済みばかり（控えに全部ある）でも、未保存があれば確認を出す
 * - 取りやめたら保存もしないし、送りもしない
 *
 * AIは偽物。仕掛けは checkProofreadTruncatedSplit.test.ts を写した。
 */

const work: WorkEntry = {
  id: "w1",
  title: "試しの作品",
  folderPath: "C:/works/w",
  registeredAt: "2026-11-02T00:00:00.000Z",
};
const registry = {} as unknown as AIRegistry;
const FILE = "C:/works/w/001.txt";

/** 保存の口。保存すると、ファイルの中身が画面で打った字に変わる */
function presaveOf(count: number) {
  return {
    count,
    save: vi.fn(async () => {
      state.sources[FILE] = `${"保存した本文".repeat(40)}\n`;
      return true;
    }),
  };
}

beforeEach(() => {
  state.sent = [];
  state.truncateCalls = new Set();
  state.emptyCalls = new Set();
  state.brokenCalls = new Set();
  state.logged = [];
  state.failures = [];
  state.confirms = [];
  state.confirmAnswer = true;
  state.allCached = false;
  state.sources = { [FILE]: `${"保存前の本文".repeat(40)}\n` };
  Object.assign(window, {
    showInformationMessage: vi.fn(async () => undefined),
    showWarningMessage: vi.fn(async () => undefined),
    showErrorMessage: vi.fn(async () => undefined),
  });
});

describe("推敲：未保存は確認の窓で保存し、保存した本文で読み直す", () => {
  test("確認は1回、保存は1回、AIへ送るのは保存した本文", async () => {
    const presave = presaveOf(1);
    const result = await checkProofread(work, registry, { presave });

    expect(result).toBeDefined();
    expect(state.confirms).toHaveLength(1);
    expect(state.confirms[0].presave).toBe(presave);
    expect(presave.save).toHaveBeenCalledOnce();
    expect(state.sent).toHaveLength(1);
    expect(state.sent[0]).toContain("保存した本文");
    expect(state.sent[0]).not.toContain("保存前の本文");
    expect(state.logged.some((line) => line.includes("保存した本文で読み直しました"))).toBe(true);
  });

  test("処理済みばかりでも、未保存があれば確認を出して保存する", async () => {
    state.allCached = true;
    const presave = presaveOf(2);
    await checkProofread(work, registry, { presave });

    expect(state.confirms).toHaveLength(1);
    expect(presave.save).toHaveBeenCalledOnce();
  });

  test("処理済みばかりで未保存も無ければ、今までどおり確認を出さない", async () => {
    state.allCached = true;
    await checkProofread(work, registry, { presave: presaveOf(0) });
    expect(state.confirms).toHaveLength(0);
  });

  test("取りやめたら保存もせず、送りもしない", async () => {
    state.confirmAnswer = false;
    const presave = presaveOf(1);
    const result = await checkProofread(work, registry, { presave });

    expect(result).toBeUndefined();
    expect(presave.save).not.toHaveBeenCalled();
    expect(state.sent).toHaveLength(0);
  });

  test("保存できなければ、送らずに止める", async () => {
    const presave = { count: 1, save: vi.fn(async () => false) };
    const result = await checkProofread(work, registry, { presave });

    expect(result).toBeUndefined();
    expect(state.sent).toHaveLength(0);
  });
});
