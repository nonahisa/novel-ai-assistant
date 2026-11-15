import { beforeEach, describe, expect, test, vi } from "vitest";
import { window } from "../support/vscodeStub";
import type { AIRegistry } from "../../../src/ai/registry";
import type { WorkEntry } from "../../../src/models/types";

/**
 * 「もろちん」（「もちろん」の隣どうしの仮名の入れ替わり）を、誤字脱字の
 * 検知が指摘する（作者の依頼、2026-11-15「「もろちん」で「もちろん」と誤字検知しない。」）。
 *
 * 手元のAI（gemma4:e4b）は、この形を拾わなかった（直す前の測り）。
 * そこで、よく使う語の入れ替わりをコードで照合する（`core/kanaSwapCheck.ts`）。
 * ここでは、**AIが何も返さなくても、パネルへ渡る指摘の一覧に入る**ことを、
 * 製品の入口（`checkTypos`）から確かめる。
 *
 * 道具立て（偽のAI・決め打ちのチャンク）は `checkTyposCeilingTimeout.test.ts` と同じ。
 */

const state = vi.hoisted(() => ({
  /** AIへ送ったプロンプト（送った順） */
  sent: [] as string[],
  /** AIが返す本文（`parseTypoCheckResult` が受ける形） */
  aiText: "",
  /** 作者が「直さない」と決めた語 */
  keepWords: [] as string[],
  logged: [] as string[],
  sources: {} as Record<string, string>,
}));

/** 正しく読める「指摘なし」の応答 */
const EMPTY_RESULT = JSON.stringify({ issues: [] });

vi.mock("../../../src/core/memoMarkerStore", () => import("../support/memoMarkerStoreStub"));

vi.mock("../../../src/ai/registry", () => ({
  ensureConfigured: vi.fn(async () => ({
    provider: {
      id: "ollama",
      displayName: "Ollama",
      isPaid: false,
      async testConnection() {
        return { ok: true };
      },
      async generate(request: { userPrompt: string }) {
        state.sent.push(request.userPrompt);
        return { text: state.aiText, truncated: false, elapsedMs: 1 };
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

vi.mock("../../../src/features/chunkSettings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/features/chunkSettings")>();
  return {
    ...actual,
    resolveModelInfoOrWarn: vi.fn(async () => ({
      contextWindow: 32768,
      tier: "high",
      parameterSize: "120B",
    })),
    // まとめない（1話＝1チャンク）
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
  hashText: (text: string) => `hash-${text.length}-${text.slice(0, 1)}`,
}));

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
      return state.keepWords.map((word) => ({ word, note: "", addedAt: "2026-11-15" }));
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

// 控えは毎回空（すべて送る）
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
  registeredAt: "2026-11-15T00:00:00.000Z",
};

const registry = {} as unknown as AIRegistry;

const FILE = "C:/works/w/001.txt";

beforeEach(() => {
  state.sent = [];
  state.aiText = EMPTY_RESULT;
  state.keepWords = [];
  state.logged = [];
  state.sources = {
    [FILE]: "　朝の市場は、いつもより人が多かった。\n「もろちん、鮮度は保証する」\n",
  };
  Object.assign(window, {
    showInformationMessage: vi.fn(async () => undefined),
    showWarningMessage: vi.fn(async () => undefined),
    showErrorMessage: vi.fn(async () => undefined),
  });
});

function swapIssuesOf(
  result: Awaited<ReturnType<typeof checkTypos>>
): { line: number; target: string; suggestion: string }[] {
  if (!result) throw new Error("結果が返っていない");
  return result.issues.filter((issue) => issue.target.includes("もろちん"));
}

describe("「もろちん」を、AIが拾わなくても指摘する", () => {
  test("AIが何も返さなくても、「もちろん」への直しが一覧に入る", async () => {
    const result = await checkTypos(work, registry);

    // 前提：AIへは送っている（AIの道を飛ばしたから出た、ではない）
    expect(state.sent).toHaveLength(1);
    const found = swapIssuesOf(result);
    expect(found).toHaveLength(1);
    expect(found[0].suggestion).toBe("もちろん");
    // 台詞の行（2行目）を指す。**元のファイルの行番号**に戻っていること
    expect(found[0].line).toBe(2);
  });

  test("AIも同じ直しを返したときは、一覧に2件並べない", async () => {
    state.aiText = JSON.stringify({
      issues: [
        {
          line: 2,
          original: "「もろちん、鮮度は保証する」",
          target: "もろちん",
          suggestion: "もちろん",
          reason: "仮名の入れ替わり",
          confidence: "high",
        },
      ],
    });

    const result = await checkTypos(work, registry);

    expect(swapIssuesOf(result)).toHaveLength(1);
  });

  test("作者が「直さない語」に登録していれば、指摘しない", async () => {
    // わざと書いた台詞（言葉遊び）を、作者が守れるようにする
    state.keepWords = ["もろちん"];

    const result = await checkTypos(work, registry);

    expect(swapIssuesOf(result)).toHaveLength(0);
  });
});
