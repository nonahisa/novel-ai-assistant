import { beforeEach, describe, expect, test, vi } from "vitest";
import { window, workspace } from "../support/vscodeStub";
import type { AIRegistry } from "../../../src/ai/registry";
import type {
  GenerateParams,
  GenerateResult,
  ProviderId,
} from "../../../src/ai/types";

/**
 * AIチューニングが終わったことと、その結果を記録へ残す
 * （作者の裁定、2026-09-19）。
 *
 * 実機では、測り終えて反映待ちのダイアログが出たまま止まっていたのに、
 * 誰も気づかないまま10分以上が過ぎた。**12分かけて測った値も、反映
 * しなかったことも、どこにも残っていなかった。** 知らせ（通知）は消える。
 *
 * ここで見張るのは2つ。
 *
 * - 測った値と、記録したかどうかの1行が**実際に出る**こと
 * - **反映しなかった回が「記録しました」と書かれない**こと（出ないことの確認）
 *
 * 文面そのものの形は `runLogLines.test.ts` が見ている。こちらは
 * 「呼ばれているか」を確かめる——`logStep` は書いたつもりで呼ばれて
 * いないことがあり、それでは今回の困りごとが解けない。
 */

const state = vi.hoisted(() => ({
  providerId: "ollama" as ProviderId,
  model: "gemma4:12b",
}));

const log = vi.hoisted(() => ({ steps: [] as string[] }));

vi.mock("../../../src/core/logger", () => ({
  logStep: vi.fn((message: string) => {
    log.steps.push(message);
  }),
  logLine: vi.fn((message: string) => {
    log.steps.push(message);
  }),
  logFailure: vi.fn(),
  showLog: vi.fn(),
  useLogFile: vi.fn(),
}));

vi.mock("../../../src/ai/registry", () => ({
  ensureConfigured: vi.fn(async () => ({
    provider: {
      id: state.providerId,
      displayName: "検査用",
      isPaid: false,
      generate: async (params: GenerateParams): Promise<GenerateResult> => {
        // 合言葉の測定：頼まれたとおり書き写す（＝どの長さも通る）
        const head =
          /ひとつ目の合言葉は『(.+?)』/.exec(params.userPrompt)?.[1] ?? "";
        const tail =
          /ふたつ目の合言葉は『(.+?)』/.exec(params.userPrompt)?.[1] ?? "";
        return {
          text: `${head} ${tail}`,
          usage: { inputTokens: 0, outputTokens: 0 },
          truncated: false,
          elapsedMs: 1,
        };
      },
    },
    model: state.model,
  })),
}));

vi.mock("../../../src/features/aiConnectivity", () => ({
  confirmPaidUsage: vi.fn(async () => true),
  confirmProviderReachable: vi.fn(async () => true),
  ollamaEndpoint: vi.fn(() => "http://127.0.0.1:11434"),
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

const { measureContext } = await import("../../../src/features/measureContext");
const { useMemoryTuningStore } = await import("../support/tuningStore");

const registry = {
  resolveModelInfo: async () => ({ contextWindow: 262144 }),
} as unknown as AIRegistry;

function installSettings(values: Record<string, unknown>): void {
  workspace.getConfiguration = () =>
    ({
      get: <T>(key: string, defaultValue?: T): T =>
        (key in values ? values[key] : defaultValue) as T,
      inspect: () => ({ workspaceValue: undefined }),
      update: async (key: string, value: unknown) => {
        values[key] = value;
      },
    }) as unknown as ReturnType<typeof workspace.getConfiguration>;
}

function answerWith(answer: string): void {
  Object.assign(window, {
    showInformationMessage: vi.fn(async () => answer),
    showWarningMessage: vi.fn(async () => undefined),
    showErrorMessage: vi.fn(async () => undefined),
  });
}

/** 測定の結果を残す行（「AIチューニング …」で始まるもの） */
function tuningLine(): string | undefined {
  return log.steps.find((line) => line.startsWith("AIチューニング "));
}

beforeEach(async () => {
  state.providerId = "ollama";
  state.model = "gemma4:12b";
  log.steps = [];
  await useMemoryTuningStore({});
  installSettings({});
});

describe("測った結果を、記録へ1行残す", () => {
  test("反映した回は、測った値と「記録しました」が残る", async () => {
    answerWith("設定に反映");

    await measureContext(registry, "default", undefined, "input");

    const line = tuningLine();
    expect(line).toBeDefined();
    expect(line).toContain("ollama/gemma4:12b");
    expect(line).toMatch(/読める長さ [\d,]+字（[\d,]+トークン）/);
    expect(line).toContain("記録しました");
  });

  test("Ollamaも、読める長さを記録したと残す（J3）", async () => {
    // 作者の裁定（2026-09-26 夕。残課題 J3）で、Ollama でも測った長さを台帳へ
    // 書き、申告より短いときに使うようになった。記録の行もそれに合わせる
    // （申告しか使わないプロバイダの断りは `core/runLog.ts` に残っている）
    answerWith("設定に反映");

    await measureContext(registry, "default", undefined, "input");

    expect(tuningLine()).toContain("記録しました（読める長さと待ち時間）");
    expect(tuningLine()).not.toContain("申告値を使うため記録しません");
  });

  test("反映しなかった回は「記録なし」と理由が残り、「記録しました」とは書かれない", async () => {
    answerWith("そのままにする");

    await measureContext(registry, "default", undefined, "input");

    const line = tuningLine();
    expect(line).toBeDefined();
    // 測った値は、反映しなくても残す（次に測る前に読める）
    expect(line).toMatch(/読める長さ [\d,]+字/);
    expect(line).toContain("記録なし（設定へ反映していません）");
    // **出ないことの確認。** ここが今回の困りごとの中心である
    expect(line).not.toContain("記録しました");
  });
});
