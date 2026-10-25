import { beforeEach, describe, expect, test, vi } from "vitest";
import { window } from "../support/vscodeStub";
import { answerConfirms, type ConfirmPicker } from "../support/confirmPicker";
import type { AIRegistry } from "../../../src/ai/registry";
import type { WorkEntry } from "../../../src/models/types";
import { emptyCharacter } from "../../../src/models/character";
import { splitIntoChunks } from "../../../src/core/chunker";

/**
 * 矛盾検知の**確かめの段**（P-12b）も、レート上限（429）で待って送り直す。
 *
 * 実際に起きた（2026-10-26、さくらの Kimi）。検出の段は待ちに包まれていたが、
 * 確かめの段は素の `provider.generate` で、429 が返るとそのまま
 * 「検証できませんでした」で画面に残った。画面の誤検出7件のうち6件がこれだった。
 *
 * 待ちは実際には待たない（`sleepUnlessAborted` を差し替え、待った長さと
 * 中止の信号だけを控える）。
 */

const state = vi.hoisted(() => ({
  /** 確かめの段の呼び出し回数 */
  verifyCalls: 0,
  /** 確かめの段の最初の何回を 429 で弾くか */
  verifyRateLimited: 0,
  /** 待ちに入った長さ（ミリ秒） */
  sleeps: [] as number[],
  /** 待ちの最中に、作者が中止を押したことにする */
  cancelDuringSleep: false,
  settledAnswer: { contradictions: [] as unknown[] },
}));

vi.mock("../../../src/features/rateLimitRetry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/features/rateLimitRetry")>();
  return {
    ...actual,
    // 実際には待たない。待ちの最中の中止は、作者が中止ボタンを押したのと
    // 同じ道（`cancelRunningTask`）で写す
    sleepUnlessAborted: vi.fn(async (ms: number, signal: AbortSignal) => {
      state.sleeps.push(ms);
      if (state.cancelDuringSleep) {
        const { cancelRunningTask } = await import("../../../src/views/progress");
        await cancelRunningTask();
      }
      return !signal.aborted;
    }),
  };
});

vi.mock("../../../src/ai/registry", async () => {
  const { AIError: Err } = await import("../../../src/ai/types");
  return {
    ensureConfigured: vi.fn(async () => ({
      provider: {
        id: "sakura",
        displayName: "さくらのAI",
        isPaid: false,
        async testConnection() {
          return { ok: true };
        },
        async generate(request: { meta?: { feature?: string } }) {
          if (request.meta?.feature === "contradiction_verify") {
            state.verifyCalls++;
            if (state.verifyRateLimited > 0) {
              state.verifyRateLimited--;
              throw new Err("レート上限", "rate_limited", "", 60_000);
            }
            return {
              text: JSON.stringify({
                verdict: "採用",
                reason: "",
                explanation: "両立しない",
                confidence: "high",
              }),
              truncated: false,
              elapsedMs: 1,
            };
          }
          return { text: JSON.stringify({ contradictions: [] }), truncated: false, elapsedMs: 1 };
        },
      },
      model: "test-model",
    })),
  };
});

vi.mock("../../../src/features/chunkSettings", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveModelInfoOrWarn: vi.fn(async () => ({
    id: "test-model",
    displayName: "test-model",
    contextWindow: 32768,
    parameterSize: "31B",
    capabilities: [],
    tier: "high",
  })),
}));

const BODY = "ミナは今日も学校で授業を受け、放課後になると制服のまま瀬戸書房へ向かった。\n空は晴れていた。";

vi.mock("../../../src/features/manuscriptChunks", () => ({
  collectManuscriptChunks: vi.fn(async () => ({
    chunks: splitIntoChunks("C:/works/w/003.txt", BODY, 3, 3, { maxChars: 10_000 }),
    chapterLabelByFile: new Map([["C:/works/w/003.txt", "第3話"]]),
    chapterByFile: new Map([["C:/works/w/003.txt", 3]]),
    chunkNote: "",
    unreadableEpisodes: 0,
  })),
}));

vi.mock("../../../src/core/characterStore", () => ({
  CharacterStore: class {
    async loadAll() {
      return {
        characters: [
          {
            ...emptyCharacter("c1", "ミナ"),
            summary: "十七歳の少女。三ヶ月前に高校を退学している。",
            appearedChapters: [1, 2, 3],
          },
        ],
        errors: [],
      };
    }
  },
}));

vi.mock("../../../src/core/abilityStore", () => {
  const empty = () => ({ loadAll: async () => ({ records: [], errors: [] }) });
  return {
    createAbilityStore: empty,
    createLocationStore: empty,
    createOrganizationStore: empty,
    createWorldStore: empty,
  };
});

vi.mock("../../../src/core/synopsisStore", () => ({
  SynopsisStore: class {
    async load() {
      return { episodes: [] };
    }
  },
}));

vi.mock("../../../src/core/manuscriptSources", () => ({
  loadExcerptSources: vi.fn(async () => ({ sources: [] })),
}));

// 検出の段の答えは控えから返す（処理済み）。確かめの段だけを送らせる
vi.mock("../../../src/core/chunkCache", () => ({
  ChunkCache: class {
    async load() {}
    get(_hash: string, key: { feature: string }) {
      if (key.feature === "contradiction_check") return state.settledAnswer;
      return undefined;
    }
    async set() {}
    async save() {}
  },
}));

vi.mock("../../../src/features/aiTurn", () => ({
  withAiTurn: async (_options: unknown, run: () => Promise<void>) => run(),
}));

const { checkContradictions } = await import("../../../src/features/checkContradictions");

const work: WorkEntry = {
  id: "w1",
  title: "試しの作品",
  folderPath: "C:/works/w",
  registeredAt: "2026-10-26T00:00:00.000Z",
};
const registry = {} as AIRegistry;

let picker: ConfirmPicker | undefined;

beforeEach(() => {
  state.verifyCalls = 0;
  state.verifyRateLimited = 0;
  state.sleeps = [];
  state.cancelDuringSleep = false;
  state.settledAnswer = {
    contradictions: [
      {
        line: 1,
        excerpt: "ミナは今日も学校で授業を受け",
        settingSays: "ミナは退学している",
        textSays: "学校で授業を受けている",
        category: "人物",
        note: "",
      },
    ],
  };
  picker?.restore();
  picker = answerConfirms(() => "実行");
  Object.assign(window, {
    createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }),
    withProgress: vi.fn(
      async (
        _options: unknown,
        task: (progress: { report: () => void }) => Promise<unknown>
      ) => task({ report: vi.fn() })
    ),
  });
});

describe("確かめの段も、レート上限で待って送り直す", () => {
  test("1回目に 429 が返っても、待ってから送り直し、2回目の答えで判定される", async () => {
    state.verifyRateLimited = 1;

    const result = await checkContradictions(work, registry);

    // 送り直した（1回目の 429 ＋ 2回目）
    expect(state.verifyCalls).toBe(2);
    // 示された 60 秒より 1 秒長く待つ（`rateLimitWaitMs`）
    expect(state.sleeps).toEqual([61_000]);
    // 「検証できませんでした」で残らず、2回目の答え（採用）で残る
    expect(result?.issues).toHaveLength(1);
    expect(result?.issues[0].note ?? "").toContain("両立しない");
    expect(result?.verifyNote ?? "").not.toContain("検証できません");
  });

  test("待っている間に中止されたら、送り直さずに止まる", async () => {
    state.verifyRateLimited = 1;
    state.cancelDuringSleep = true;

    const result = await checkContradictions(work, registry);

    expect(state.sleeps).toEqual([61_000]);
    // 待ちのあとに送り直していない
    expect(state.verifyCalls).toBe(1);
    expect(result?.cancelled).toBe(true);
  });
});
