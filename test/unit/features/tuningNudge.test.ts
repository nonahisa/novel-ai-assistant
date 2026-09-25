import { beforeEach, describe, expect, test, vi } from "vitest";

/**
 * 測っていないモデルに切り替えたら、AIチューニングを一言勧める
 * （設計書6.49.8）——選択が変わった合図から知らせまでの配線。
 *
 * 決まり（誰に言うか・何と言うか）は `test/unit/core/tuningNudge.test.ts`。
 * ここは**実際に合図を鳴らして**、知らせが何回出るか・ボタンが何をするかを見る。
 */

const shown: Array<{ message: string; buttons: string[] }> = [];
let answer: string | undefined;
const executed: unknown[][] = [];

vi.mock("vscode", () => ({
  window: {
    showInformationMessage: vi.fn(async (message: string, ...buttons: string[]) => {
      shown.push({ message, buttons });
      return answer;
    }),
  },
  commands: {
    executeCommand: vi.fn(async (...args: unknown[]) => {
      executed.push(args);
    }),
  },
}));

/** 作者の台帳。鍵ごとに読める長さの実測を持つか */
const tuned = new Set<string>();
vi.mock("../../../src/core/modelTuning", () => ({
  modelTuningRaw: (providerId: string, model: string) =>
    tuned.has(`${providerId}/${model}`) ? { measuredChars: 90000 } : undefined,
}));

vi.mock("../../../src/core/logger", () => ({
  logLine: vi.fn(),
}));

import { registerTuningNudge } from "../../../src/features/tuningNudge";
import type { AIRegistry } from "../../../src/ai/registry";
import type * as vscode from "vscode";

/** 偽の登録簿。選択を変えたら `change()` で合図を鳴らす */
function fakeRegistry() {
  let listener: (() => void) | undefined;
  const state = {
    providerId: "ollama" as string | undefined,
    model: "gemma4:e4b" as string | undefined,
    assignments: {} as Record<string, { provider: string; model: string }>,
  };
  const registry = {
    get selectedProviderId() {
      return state.providerId;
    },
    get selectedModel() {
      return state.model;
    },
    assignments: () => state.assignments,
    getProvider: (id: string) =>
      id === "claude"
        ? { displayName: "Claude", isPaid: true }
        : { displayName: "Ollama", isPaid: false },
    onDidChangeSelection: (fn: () => void) => {
      listener = fn;
      return { dispose: () => undefined };
    },
  } as unknown as AIRegistry;
  return { registry, state, change: () => listener?.() };
}

function fakeContext(): vscode.ExtensionContext {
  const store = new Map<string, unknown>();
  return {
    globalState: {
      get: (key: string) => store.get(key),
      update: async (key: string, value: unknown) => {
        store.set(key, value);
      },
    },
  } as unknown as vscode.ExtensionContext;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
  shown.length = 0;
  executed.length = 0;
  answer = undefined;
  tuned.clear();
});

describe("切り替えたときに、一度だけ勧める", () => {
  test("測っていないモデルへ切り替えると、ボタン付きで勧める", async () => {
    const { registry, state, change } = fakeRegistry();
    registerTuningNudge(fakeContext(), registry);

    state.model = "gemma4:12b";
    change();
    await settle();

    expect(shown).toHaveLength(1);
    expect(shown[0].message).toContain("gemma4:12b");
    expect(shown[0].buttons).toEqual(["AIチューニングで測る", "今後出さない"]);
  });

  test("同じモデルへ切り替え直しても、二度目は出さない", async () => {
    const { registry, state, change } = fakeRegistry();
    registerTuningNudge(fakeContext(), registry);

    state.model = "gemma4:12b";
    change();
    await settle();
    state.model = "gemma4:e4b";
    change();
    await settle();
    state.model = "gemma4:12b";
    change();
    await settle();

    // 12b は一度だけ。e4b へ戻したのも「測っていないモデルへ切り替えた」
    // ので一度言う（起動時から使っていたことは、測ったことにならない）
    expect(
      shown.map((entry) =>
        entry.message.includes("gemma4:12b") ? "12b" : "e4b"
      )
    ).toEqual(["12b", "e4b"]);
  });

  test("起動しただけでは出さない（前から使っているモデル）", async () => {
    const { registry, change } = fakeRegistry();
    registerTuningNudge(fakeContext(), registry);

    change();
    await settle();

    expect(shown).toEqual([]);
  });

  test("測ってあるモデルには出さない", async () => {
    tuned.add("ollama/gemma4:12b");
    const { registry, state, change } = fakeRegistry();
    registerTuningNudge(fakeContext(), registry);

    state.model = "gemma4:12b";
    change();
    await settle();

    expect(shown).toEqual([]);
  });

  test("「今後出さない」を押したら、別のモデルでも出さない", async () => {
    answer = "今後出さない";
    const { registry, state, change } = fakeRegistry();
    registerTuningNudge(fakeContext(), registry);

    state.model = "gemma4:12b";
    change();
    await settle();
    state.model = "qwen3:8b";
    change();
    await settle();

    expect(shown).toHaveLength(1);
  });
});

describe("ボタンと断り", () => {
  test("「測る」は、その機能の割当先を測る", async () => {
    answer = "AIチューニングで測る";
    const { registry, state, change } = fakeRegistry();
    registerTuningNudge(fakeContext(), registry);

    state.assignments = { typo: { provider: "ollama", model: "gemma4:12b" } };
    change();
    await settle();

    expect(executed).toEqual([["novelai.measureContext", "typo"]]);
  });

  test("有料のAIでは、料金がかかることを添える", async () => {
    const { registry, state, change } = fakeRegistry();
    registerTuningNudge(fakeContext(), registry);

    state.providerId = "claude";
    state.model = "claude-sonnet";
    change();
    await settle();

    expect(shown[0].message).toContain("Claude は有料です");
  });
});
