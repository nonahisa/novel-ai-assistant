import { beforeEach, describe, expect, test, vi } from "vitest";
import { window } from "../support/vscodeStub";
import type { AIRegistry } from "../../../src/ai/registry";
import type { WorkEntry } from "../../../src/models/types";
import { emptyCharacter } from "../../../src/models/character";
import { splitIntoChunks } from "../../../src/core/chunker";
import { WHOLE_READ_CONSENT_LABEL } from "../../../src/core/wholeReadConsent";

/**
 * **確認を通らずに送る道を塞ぐ**（2026-09-23）。矛盾検知を入口から通す。
 *
 * 矛盾検知は1つの区切りについてAIを2回呼ぶ（本命と、「あとで判明する事実」
 * との突き合わせ）。確認を出すかどうかを**処理済みでない本命の件数**で
 * 決めていたので、本命が全部処理済みで2回目だけが残っている状態（前回
 * 2回目の途中で中止したときなど）では、確認を出さないまま2回目を送って
 * いた。クラウドの「まるごと読む」では、毎回取るはずの同意も出なかった。
 *
 * 作者の決まり：**確認を通らずに送る道があってはならない。**
 *
 * AIは偽物。見るのは「送ったか」と「その前に確認（同意）を出したか」だけ。
 */

const state = vi.hoisted(() => ({
  providerId: "ollama",
  /** AIへ送った呼び出しの機能名 */
  sent: [] as string[],
  /** 確認・同意を出した時点で、既に送っていた呼び出しの数 */
  sentBeforeDialog: [] as number[],
  /** 処理済み（キャッシュにある）とみなす機能名 */
  cachedFeatures: new Set<string>(),
  /** 検証の答えを覚えているか */
  verifyCached: false,
  /** 本命の処理済みの答え */
  settledAnswer: { contradictions: [] as unknown[] },
  logged: [] as string[],
}));

vi.mock("../../../src/ai/registry", () => ({
  ensureConfigured: vi.fn(async () => ({
    provider: {
      id: state.providerId,
      displayName: state.providerId === "ollama" ? "Ollama" : "クラウドAI",
      isPaid: false,
      async testConnection() {
        return { ok: true };
      },
      async generate(request: { meta?: { feature?: string } }) {
        state.sent.push(request.meta?.feature ?? "");
        return {
          text: JSON.stringify({ contradictions: [] }),
          truncated: false,
          elapsedMs: 1,
        };
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
    parameterSize: "31B",
    capabilities: [],
    tier: "high",
  })),
}));

/** 本文。人物の名前が出るので、材料が載る（送る対象になる） */
const BODY = "文佳は城の門をくぐった。\n空は晴れていた。";

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
        characters: [{ ...emptyCharacter("c1", "文佳"), role: "侍女" }],
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

// 「あとで判明する事実」を1つ持たせる（2回目の呼び出しが要る形）
vi.mock("../../../src/core/settingsAsOf", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  factsRevealedAfter: vi.fn(() => [{ field: "role", chapter: 9, value: "王女" }]),
}));

vi.mock("../../../src/core/chunkCache", () => ({
  ChunkCache: class {
    async load() {}
    get(_hash: string, key: { feature: string }) {
      if (key.feature === "contradiction_verify") {
        return state.verifyCached
          ? JSON.stringify({ verdict: "採用", reason: "", explanation: "", confidence: "high" })
          : undefined;
      }
      if (!state.cachedFeatures.has(key.feature)) return undefined;
      return key.feature === "contradiction_check"
        ? state.settledAnswer
        : { contradictions: [] };
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

const { checkContradictions } = await import(
  "../../../src/features/checkContradictions"
);

const work: WorkEntry = {
  id: "w1",
  title: "試しの作品",
  folderPath: "C:/works/w",
  registeredAt: "2026-09-23T00:00:00.000Z",
};

const registry = {} as AIRegistry;

/** 確認・同意の窓。取りやめる（閉じる）答えを返す */
function declineDialogs(): void {
  const decline = vi.fn(async () => {
    state.sentBeforeDialog.push(state.sent.length);
    return undefined;
  });
  Object.assign(window, {
    showInformationMessage: decline,
    showWarningMessage: decline,
  });
}

beforeEach(() => {
  state.providerId = "ollama";
  state.sent = [];
  state.sentBeforeDialog = [];
  state.cachedFeatures = new Set();
  state.verifyCached = false;
  state.settledAnswer = { contradictions: [] };
  state.logged = [];
  declineDialogs();
  Object.assign(window, {
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

describe("本命が処理済みで、2回目だけが残っているとき", () => {
  beforeEach(() => {
    state.cachedFeatures = new Set(["contradiction_check"]);
  });

  test("分けて読む（手元のAI）：確認を出す。取りやめたら何も送らない", async () => {
    await checkContradictions(work, registry);

    expect(window.showInformationMessage).toHaveBeenCalledTimes(1);
    expect(state.sentBeforeDialog).toEqual([0]);
    expect(state.sent).toEqual([]);
  });

  test("確認の文面は、2回目だけを送ることを言う", async () => {
    await checkContradictions(work, registry);

    const calls = (window.showInformationMessage as ReturnType<typeof vi.fn>).mock
      .calls as unknown[][];
    const detail = (calls[0][1] as { detail?: string }).detail ?? "";
    expect(detail).toContain("1チャンク中 1件を処理します");
    expect(detail).toContain("「あとで判明する事実」との突き合わせだけを送ります");
  });

  test("まるごと読む（クラウド）：毎回の同意を出す。取りやめたら何も送らない", async () => {
    state.providerId = "gemini";

    await checkContradictions(work, registry, { readMode: "whole" });

    expect(window.showWarningMessage).toHaveBeenCalledTimes(1);
    const calls = (window.showWarningMessage as ReturnType<typeof vi.fn>).mock
      .calls as unknown[][];
    // 同意のボタン（「送る」）で訊いている
    expect(calls[0]).toContain(WHOLE_READ_CONSENT_LABEL);
    // 同意の文面が言う本文の量は、実際に送る区切りのもの（0字ではない）
    const detail = (calls[0][1] as { detail?: string }).detail ?? "";
    expect(detail).toContain("本文がまるごと");
    expect(detail).not.toMatch(/本文 約0字/);
    expect(state.sent).toEqual([]);
  });

  test("確認で「実行」を押せば、2回目だけを送る", async () => {
    Object.assign(window, { showInformationMessage: vi.fn(async () => "実行") });

    await checkContradictions(work, registry);

    expect(state.sent).toEqual(["contradiction_future"]);
  });
});

describe("本文を読む段が全部処理済みで、検証だけが残っているとき", () => {
  test("確認を出す。取りやめたら何も送らない", async () => {
    state.cachedFeatures = new Set(["contradiction_check", "contradiction_future"]);
    // 処理済みの本命の答えに、指摘が1件ある（検証はまだ）
    state.settledAnswer = {
      contradictions: [
        {
          line: 1,
          excerpt: "文佳は城の門をくぐった。",
          settingSays: "文佳は侍女",
          textSays: "文佳は城の門をくぐった",
          category: "人物",
          note: "",
        },
      ],
    };

    await checkContradictions(work, registry);

    expect(window.showInformationMessage).toHaveBeenCalledTimes(1);
    expect(state.sent).toEqual([]);
  });
});

describe("何も残っていないとき", () => {
  test("確認を出さず、何も送らない", async () => {
    state.cachedFeatures = new Set(["contradiction_check", "contradiction_future"]);
    state.verifyCached = true;

    await checkContradictions(work, registry);

    expect(window.showInformationMessage).not.toHaveBeenCalled();
    expect(window.showWarningMessage).not.toHaveBeenCalled();
    expect(state.sent).toEqual([]);
  });
});
