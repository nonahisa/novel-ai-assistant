import { beforeEach, describe, expect, test, vi } from "vitest";
import { window, workspace } from "../support/vscodeStub";
import type { AIRegistry } from "../../../src/ai/registry";
import {
  AIRefusalError,
  type GenerateParams,
  type GenerateResult,
} from "../../../src/ai/types";

/**
 * 読める長さの測定（詰め物を送る測定）を、**APIが読める長さを教えてくれる
 * モデルでは走らせない**こと、そして**安全装置に止められたら何も学ばない**
 * こと（設計書6.49.10。2026-10-08）。
 *
 * 実機では、Claude（申告 1,000,000 トークン）で「両方まとめて測る」を押すと、
 * 約70万字の詰め物が AI の安全装置に止められ（`stop_reason: "refusal"`）、
 * チューニングがそこで終わった。仕事に近い形の測定は走らなかった。
 */

const state = vi.hoisted(() => ({
  generateCalls: 0,
  /** この回数目の送信で、安全装置に止められたことにする（1始まり） */
  refuseAt: undefined as number | undefined,
  assigned: { providerId: "claude", model: "claude-opus-5-5", isPaid: true },
  workTuningCalls: [] as Array<{ providerId: string; model: string }>,
}));

vi.mock("../../../src/ai/registry", () => ({
  ensureConfigured: vi.fn(async () => ({
    provider: {
      id: state.assigned.providerId,
      displayName: state.assigned.providerId,
      isPaid: state.assigned.isPaid,
      generate: async (params: GenerateParams): Promise<GenerateResult> => {
        state.generateCalls += 1;
        if (state.refuseAt === state.generateCalls) {
          throw new AIRefusalError(
            "AIが安全上の理由でこの内容の処理を拒否しました。",
            JSON.stringify({ type: "refusal", category: "cyber" })
          );
        }
        // 合言葉をそのまま書き写す（実際のAIと同じ振る舞い）
        const head = /ひとつ目の合言葉は『(.+?)』/.exec(params.userPrompt)?.[1] ?? "";
        const tail = /ふたつ目の合言葉は『(.+?)』/.exec(params.userPrompt)?.[1] ?? "";
        return {
          text: `${head} ${tail}`,
          usage: { inputTokens: 0, outputTokens: 0 },
          truncated: false,
          elapsedMs: 1,
        };
      },
    },
    model: state.assigned.model,
  })),
}));

vi.mock("../../../src/features/aiConnectivity", () => ({
  confirmPaidUsage: vi.fn(async () => true),
  confirmProviderReachable: vi.fn(async () => true),
}));

/**
 * 仕事に近い形の測定は、**呼ばれたかどうか**だけを見る。中身は
 * `tuningStageRunners.test.ts` が見張っている
 */
vi.mock("../../../src/features/tuningStageRunners", () => ({
  runWorkTuning: vi.fn(async (provider: { id: string }, model: string) => {
    state.workTuningCalls.push({ providerId: provider.id, model });
  }),
}));

vi.mock("../../../src/views/progress", () => ({
  withCancellableProgress: vi.fn(
    async (
      _title: string,
      task: (
        progress: { report: (value: unknown) => void },
        token: {
          isCancellationRequested: boolean;
          onCancellationRequested: (listener: () => void) => void;
        }
      ) => Promise<unknown>
    ) =>
      task(
        { report: () => {} },
        { isCancellationRequested: false, onCancellationRequested: () => {} }
      )
  ),
}));

import { measureContext } from "../../../src/features/measureContext";
import {
  tuningStoreContents,
  useMemoryTuningStore,
} from "../support/tuningStore";

function installSettings(): void {
  workspace.getConfiguration = () =>
    ({
      get: <T>(_key: string, defaultValue?: T): T => defaultValue as T,
      inspect: () => ({ workspaceValue: undefined }),
      update: async () => {},
    }) as unknown as ReturnType<typeof workspace.getConfiguration>;
}

/** 申告を返すレジストリ（Claude は `/v1/models/{id}` の `max_input_tokens`） */
function registryDeclaring(contextWindow: number | undefined): AIRegistry {
  return {
    resolveModelInfo: async () =>
      contextWindow === undefined ? undefined : { contextWindow },
  } as unknown as AIRegistry;
}

interface Notices {
  info: ReturnType<typeof vi.fn>;
  warning: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
}

function captureNotices(): Notices {
  const notices: Notices = {
    info: vi.fn(async () => undefined),
    warning: vi.fn(async () => undefined),
    error: vi.fn(async () => undefined),
  };
  Object.assign(window, {
    showInformationMessage: notices.info,
    showWarningMessage: notices.warning,
    showErrorMessage: notices.error,
  });
  return notices;
}

/** 出したすべての知らせの文を1つにつなぐ */
function allNoticeText(notices: Notices): string {
  return [notices.info, notices.warning, notices.error]
    .flatMap((fn) => fn.mock.calls.map((call) => String(call[0])))
    .join("\n");
}

beforeEach(async () => {
  state.generateCalls = 0;
  state.refuseAt = undefined;
  state.workTuningCalls = [];
  state.assigned = { providerId: "claude", model: "claude-opus-5-5", isPaid: true };
  installSettings();
  await useMemoryTuningStore({});
});

describe("APIが読める長さを教えてくれるモデル", () => {
  test("「両方まとめて測る」でも詰め物を1回も送らず、仕事に近い形の測定へ進む", async () => {
    captureNotices();
    await measureContext(registryDeclaring(1_000_000), "default", undefined, "both");

    expect(state.generateCalls).toBe(0);
    expect(state.workTuningCalls).toEqual([
      { providerId: "claude", model: "claude-opus-5-5" },
    ]);
  });

  test("「読める長さだけ測る」でも詰め物は送らない（申告を使うと知らせる）", async () => {
    const notices = captureNotices();
    await measureContext(registryDeclaring(1_000_000), "default", undefined, "input");

    expect(state.generateCalls).toBe(0);
    expect(allNoticeText(notices)).toContain("API の申告");
  });

  test("Gemini も同じ扱い（API から申告を取れる）", async () => {
    state.assigned = { providerId: "gemini", model: "gemini-3-pro", isPaid: true };
    captureNotices();
    await measureContext(registryDeclaring(1_048_576), "default", undefined, "both");

    expect(state.generateCalls).toBe(0);
    expect(state.workTuningCalls).toHaveLength(1);
  });

  test("申告が取れなかったときは、これまでどおり測る", async () => {
    captureNotices();
    await measureContext(registryDeclaring(undefined), "default", undefined, "input");

    expect(state.generateCalls).toBeGreaterThan(0);
    expect(state.workTuningCalls).toHaveLength(0);
  });

  test("作者が設定に書く申告（さくら）は、これまでどおり測る", async () => {
    state.assigned = { providerId: "sakura", model: "gpt-oss-120b", isPaid: true };
    captureNotices();
    await measureContext(registryDeclaring(128_000), "default", undefined, "input");

    expect(state.generateCalls).toBeGreaterThan(0);
  });
});

describe("測定の途中で安全装置に止められたとき", () => {
  /**
   * 申告を自分で出すが測った値も台帳へ書く Ollama で、2回目に止められる
   * ことにする（実際に安全装置で止めるのはクラウドだが、測定の道筋を通す
   * ために、測る側のプロバイダで再現する）。
   */
  test("台帳に何も書かず、知らせに「安全装置」と「API の申告」を入れる", async () => {
    state.assigned = { providerId: "ollama", model: "gemma4:26b", isPaid: false };
    state.refuseAt = 2;
    const before = {
      "ollama/gemma4:26b": { measuredChars: 5000, contextWindow: 7000 },
    };
    await useMemoryTuningStore(before);
    const notices = captureNotices();

    await measureContext(registryDeclaring(8192), "default", undefined, "both");

    // 1回目は通っている（低い側は分かっている）が、それも覚えない
    expect(state.generateCalls).toBe(2);
    expect(tuningStoreContents()).toEqual(before);
    const text = allNoticeText(notices);
    expect(text).toContain("安全装置");
    expect(text).toContain("API の申告");
    // 丸ごとの失敗（エラーの知らせ）にはしない
    expect(notices.error).not.toHaveBeenCalled();
  });

  /**
   * ChatGPT は申告が作者の設定なので測る側にいる。拒否を「入らない」と
   * 数えると、読める長さとして学んでしまう
   */
  test("ChatGPT が途中で拒否しても「入らない」と学ばず、設定の値を使うと知らせる", async () => {
    state.assigned = { providerId: "openai", model: "gpt-5", isPaid: true };
    state.refuseAt = 2;
    const notices = captureNotices();

    await measureContext(registryDeclaring(128_000), "default", undefined, "input");

    expect(state.generateCalls).toBe(2);
    expect(tuningStoreContents()).toEqual({});
    const text = allNoticeText(notices);
    expect(text).toContain("安全装置");
    expect(text).toContain("設定の値");
  });

  test("知らせのボタンを押すと、仕事に近い形の測定だけを回す", async () => {
    state.assigned = { providerId: "ollama", model: "gemma4:26b", isPaid: false };
    state.refuseAt = 1;
    const notices = captureNotices();
    notices.warning.mockImplementation(async (...args: unknown[]) =>
      args.find((arg) => typeof arg === "string" && arg.includes("仕事に近い形"))
    );

    await measureContext(registryDeclaring(8192), "default", undefined, "both");

    expect(state.generateCalls).toBe(1);
    expect(state.workTuningCalls).toEqual([
      { providerId: "ollama", model: "gemma4:26b" },
    ]);
  });
});
