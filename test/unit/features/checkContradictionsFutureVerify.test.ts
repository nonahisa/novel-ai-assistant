import { beforeEach, describe, expect, test, vi } from "vitest";
import { window } from "../support/vscodeStub";
import { answerConfirms, type ConfirmPicker } from "../support/confirmPicker";
import type { AIRegistry } from "../../../src/ai/registry";
import type { WorkEntry } from "../../../src/models/types";
import { emptyCharacter } from "../../../src/models/character";
import { splitIntoChunks } from "../../../src/core/chunker";
import {
  VERIFY_FUTURE_SOURCE_NOTE,
  VERIFY_FUTURE_SOURCE_NOTE_WITH_FACTS,
  VERIFY_KNOWN_AT_NONE_FUTURE,
} from "../../../src/prompts/contradictionVerify";

/**
 * 「あとで判明する事実」（future）から来た指摘の確かめ（P-12b 1.3、作者の裁定
 * 2026-10-19 夜「A+C」）を、矛盾検知の入口から通す。
 *
 * 見るのは、確かめの段へ渡る文面（出どころの一文・「この設定が分かる話」）と、
 * 控えの鍵の版。本命（settled）の指摘は、直す前と同じ文面・同じ鍵のまま。
 *
 * AIは偽物。検出の段の答えは控えから返し（処理済み）、確かめの段だけを送らせる。
 */

const state = vi.hoisted(() => ({
  /** 確かめの段へ送った文面 */
  verifyPrompts: [] as string[],
  /** 確かめの段の控えを引いたときの鍵の版 */
  verifyKeyVersions: [] as string[],
  settledAnswer: { contradictions: [] as unknown[] },
  futureAnswer: { contradictions: [] as unknown[] },
  parameterSize: "31B",
}));

vi.mock("../../../src/ai/registry", () => ({
  ensureConfigured: vi.fn(async () => ({
    provider: {
      id: "ollama",
      displayName: "Ollama",
      isPaid: false,
      async testConnection() {
        return { ok: true };
      },
      async generate(request: { userPrompt: string; meta?: { feature?: string } }) {
        if (request.meta?.feature === "contradiction_verify") {
          state.verifyPrompts.push(request.userPrompt);
          return {
            text: JSON.stringify({ verdict: "採用", reason: "", explanation: "", confidence: "high" }),
            truncated: false,
            elapsedMs: 1,
          };
        }
        return { text: JSON.stringify({ contradictions: [] }), truncated: false, elapsedMs: 1 };
      },
    },
    model: "test-model",
  })),
}));

vi.mock("../../../src/features/chunkSettings", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveModelInfoOrWarn: vi.fn(async () => ({
    id: "test-model",
    displayName: "test-model",
    contextWindow: 32768,
    parameterSize: state.parameterSize,
    capabilities: [],
    tier: "high",
  })),
}));

/** 台の第3話の1行目（T1）。ミナの名前が出るので、材料が載る */
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

const MINA_LATER = "十七歳の少女。三ヶ月前に高校を退学している。";

vi.mock("../../../src/core/characterStore", () => ({
  CharacterStore: class {
    async loadAll() {
      return {
        characters: [
          {
            ...emptyCharacter("c1", "ミナ"),
            summary: "十七歳の少女。三ヶ月前に高校を退学している。",
            appearedChapters: [1, 2, 3, 4],
            changes: [
              {
                field: "summary",
                value: "十七歳の少女。",
                chapters: [1],
                timepointId: null,
                note: null,
                evidence: null,
                source: "author",
              },
              {
                field: "summary",
                value: "十七歳の少女。三ヶ月前に高校を退学している。",
                chapters: [4],
                timepointId: null,
                note: null,
                evidence: null,
                source: "author",
              },
            ],
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

vi.mock("../../../src/core/chunkCache", () => ({
  ChunkCache: class {
    async load() {}
    get(_hash: string, key: { feature: string; promptVersion?: string }) {
      if (key.feature === "contradiction_verify") {
        state.verifyKeyVersions.push(key.promptVersion ?? "");
        return undefined;
      }
      if (key.feature === "contradiction_check") return state.settledAnswer;
      if (key.feature === "contradiction_future") return state.futureAnswer;
      return undefined;
    }
    async set() {}
    async save() {}
  },
}));

vi.mock("../../../src/features/aiTurn", () => ({
  withAiTurn: async (_options: unknown, run: () => Promise<void>) => run(),
}));

vi.mock("../../../src/features/largerModelOffer", () => ({
  findLargerModelOffer: vi.fn(async () => undefined),
}));

const { checkContradictions } = await import("../../../src/features/checkContradictions");

const work: WorkEntry = {
  id: "w1",
  title: "試しの作品",
  folderPath: "C:/works/w",
  registeredAt: "2026-10-19T00:00:00.000Z",
};
const registry = {} as AIRegistry;

let picker: ConfirmPicker | undefined;

/** T1 型の指摘。AI は頭に「あとの話で判明する事実：」を付けて書いてくる */
function t1(settingSays: string): unknown {
  return {
    line: 1,
    excerpt: "ミナは今日も学校で授業を受け",
    settingSays,
    textSays: "学校で授業を受けている",
    category: "人物",
    note: "",
  };
}

beforeEach(() => {
  state.verifyPrompts = [];
  state.verifyKeyVersions = [];
  state.settledAnswer = { contradictions: [] };
  state.futureAnswer = { contradictions: [] };
  state.parameterSize = "31B";
  picker?.restore();
  picker = answerConfirms(() => "実行");
  Object.assign(window, {
    createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }),
    withProgress: vi.fn(
      async (
        _options: unknown,
        task: (
          progress: { report: () => void },
          token: { isCancellationRequested: boolean; onCancellationRequested: () => void }
        ) => Promise<unknown>
      ) =>
        task(
          { report: vi.fn() },
          { isCancellationRequested: false, onCancellationRequested: vi.fn() }
        )
    ),
  });
});

describe("future から来た指摘の確かめ（P-12b 1.3）", () => {
  test.each(["31B", "8B"])(
    "%s：出どころの一文と、事実の一覧から引いた話数（第4話）と、照らした事実の文（1.4）が渡る。「まだ明かされていない」は無い",
    async (size) => {
      state.parameterSize = size;
      state.futureAnswer = {
        contradictions: [t1(`あとの話で判明する事実：ミナの紹介（第4話で判明）: ${MINA_LATER}`)],
      };

      await checkContradictions(work, registry);

      expect(state.verifyPrompts).toHaveLength(1);
      const prompt = state.verifyPrompts[0];
      // 1.4：照らした事実の文を渡すので、出どころの一文はそちらを指す形になる
      expect(prompt).toContain(VERIFY_FUTURE_SOURCE_NOTE_WITH_FACTS);
      expect(prompt).toContain(`【照らした事実（あとの話で判明）】\n- ミナの紹介（第4話で判明）: ${MINA_LATER}`);
      expect(prompt).toContain("- この設定が分かる話: 第4話");
      expect(prompt).not.toContain("まだ明かされていない");
      expect(state.verifyKeyVersions.every((version) => version.startsWith("1.4:"))).toBe(true);
      expect(state.verifyKeyVersions.every((version) => version.includes("future:"))).toBe(true);
    }
  );

  test("言い換えた settingSays（話数の書き写し無し）でも、名前で絞って第4話を渡す", async () => {
    state.futureAnswer = { contradictions: [t1("ミナは退学して学校には通っていない")] };

    await checkContradictions(work, registry);

    expect(state.verifyPrompts[0]).toContain("- この設定が分かる話: 第4話");
  });

  test("引けないときは、事実と逆の案内も「（不明）」も使わない", async () => {
    state.parameterSize = "8B";
    // 名前がどの欄にも出ない指摘（引用も本文の欄も2行目）。人物で絞れない
    state.futureAnswer = {
      contradictions: [
        {
          line: 2,
          excerpt: "空は晴れていた。",
          settingSays: "学校には通っていない",
          textSays: "晴れていた",
          category: "状態",
          note: "",
        },
      ],
    };

    await checkContradictions(work, registry);

    expect(state.verifyPrompts[0]).toContain(`- この設定が分かる話: ${VERIFY_KNOWN_AT_NONE_FUTURE}`);
    expect(state.verifyPrompts[0]).not.toContain("この話より後で明かされる設定だという記録はありません");
    expect(state.verifyPrompts[0]).not.toContain("（不明）");
  });

  test("本命（settled）の指摘は、出どころの一文なし・鍵は 1.2 のまま", async () => {
    state.settledAnswer = { contradictions: [t1("ミナは十七歳の少女")] };

    await checkContradictions(work, registry);

    expect(state.verifyPrompts).toHaveLength(1);
    expect(state.verifyPrompts[0]).not.toContain(VERIFY_FUTURE_SOURCE_NOTE);
    expect(state.verifyPrompts[0]).not.toContain(VERIFY_FUTURE_SOURCE_NOTE_WITH_FACTS);
    expect(state.verifyPrompts[0]).not.toContain("【照らした事実");
    expect(state.verifyPrompts[0]).toContain("1. **まだ明かされていない**");
    expect(state.verifyKeyVersions.length).toBeGreaterThan(0);
    for (const version of state.verifyKeyVersions) {
      expect(version).toMatch(/^1\.2:/);
      expect(version).not.toContain("future:");
    }
  });
});
