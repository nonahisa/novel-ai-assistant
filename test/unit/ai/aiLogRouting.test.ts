import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { workspace } from "../support/vscodeStub";

// 送信量の記録（usage.md）は別の話なので、ここでは捨てる
vi.mock("../../../src/core/usageLog", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  appendUsageLog: () => {},
}));

import { setFallbackLogRoot, useLogFile } from "../../../src/core/logger";
import { MeteredProvider } from "../../../src/ai/meteredProvider";
import { SakuraProvider } from "../../../src/ai/sakuraProvider";
import type {
  AIProvider,
  GenerateParams,
  GenerateResult,
  ModelInfo,
} from "../../../src/ai/types";
import { useMemoryTuningStore } from "../support/tuningStore";

/**
 * AIの層（プロバイダー・関所）のログも、呼び出した作品のログへ届くこと
 * （2026-10-11 作者の指示。0.101.15 の残り）。
 *
 * 0.101.15 で、長い処理（抽出・誤字脱字など）は始めた作品のログへ書き続ける
 * ようにした（`workLog`）。ところがその処理の中で呼ばれるAIの層は、まだ
 * 共有の書き先（`useLogFile`）へ書いていた。AIの応答を待っているあいだに作者が
 * 別の作品の画面を開くと、「思考を止める指定を外して再試行します」のような
 * 行が開いた作品のログへ入り、本来の作品のログから抜ける。
 *
 * 呼び出しは `meta.workFolder` で作品を持っているので、それへ書く。
 */

let written: { path: string; text: string }[] = [];

beforeEach(() => {
  written = [];
  Object.assign(workspace, {
    fs: {
      createDirectory: async () => undefined,
      readFile: async () => {
        throw new Error("まだ無い");
      },
      writeFile: async (uri: { path?: string; fsPath?: string }, data: Uint8Array) => {
        written.push({
          path: uri.fsPath ?? uri.path ?? "",
          text: new TextDecoder().decode(data),
        });
      },
    },
  });
  setFallbackLogRoot("C:/storage");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** 書き込みは順番待ちの列に乗るので、何周か待ってから読む */
async function settle(): Promise<void> {
  for (let i = 0; i < 40; i++) await Promise.resolve();
}

const HIGH_ELF = "C:/works/ハイエルフ";
const NIKUHEN = "C:/works/肉片";

function linesIn(folder: string): string {
  const target = `${folder}/.aiwriter/logs/actions.log`.toLowerCase();
  return written
    .filter((entry) => entry.path.replace(/\\/g, "/").toLowerCase() === target)
    .map((entry) => entry.text)
    .join("");
}

/* ── さくら（プロバイダーの層） ── */

function fakeContext(): ConstructorParameters<typeof SakuraProvider>[0] {
  return {
    secrets: {
      get: async () => "test-api-key-0123456789",
      store: async () => undefined,
      delete: async () => undefined,
    },
  } as unknown as ConstructorParameters<typeof SakuraProvider>[0];
}

function stubFetchSequence(responses: Array<{ status: number; body: unknown }>): void {
  let index = 0;
  vi.stubGlobal("fetch", async () => {
    const next = responses[Math.min(index, responses.length - 1)];
    index++;
    return new Response(JSON.stringify(next.body), {
      status: next.status,
      headers: { "Content-Type": "application/json" },
    });
  });
}

const OK = {
  choices: [{ message: { content: "{}" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 100, completion_tokens: 20 },
};
const REJECTED = { error: { message: "Bad Request", code: 400 } };

function sakuraParams(overrides: Partial<GenerateParams> = {}): GenerateParams {
  return {
    systemPrompt: "指示",
    userPrompt: "本文",
    model: "preview/Qwen3.6-35B-A3B",
    temperature: 0,
    disableThinking: true,
    ...overrides,
  };
}

describe("プロバイダーのログ", () => {
  test("待っているあいだに別の作品が開かれても、呼び出した作品のログへ入る", async () => {
    stubFetchSequence([
      { status: 400, body: REJECTED },
      { status: 200, body: OK },
    ]);
    const provider = new SakuraProvider(fakeContext());
    // 窓で「肉片」の画面を開いている（共有の書き先は肉片）
    useLogFile(NIKUHEN);

    await provider.generate(
      sakuraParams({ meta: { feature: "typo_check", workFolder: HIGH_ELF } })
    );
    await settle();

    expect(linesIn(HIGH_ELF)).toContain("思考を止める指定を付けた要求が受け付けられなかった");
    expect(linesIn(HIGH_ELF)).toContain("外すと通りました");
    expect(linesIn(NIKUHEN)).toBe("");
  });

  test("作品に属さない呼び出し（接続確認など）は、今までどおり共有の書き先へ", async () => {
    stubFetchSequence([
      { status: 400, body: REJECTED },
      { status: 200, body: OK },
    ]);
    const provider = new SakuraProvider(fakeContext());
    useLogFile(NIKUHEN);

    await provider.generate(sakuraParams());
    await settle();

    expect(linesIn(NIKUHEN)).toContain("思考を止める指定を付けた要求が受け付けられなかった");
    // 作品が分からないからといって保管庫へ固定しない（`workLog(undefined)` と違う）
    expect(linesIn("C:/storage")).toBe("");
  });
});

/* ── 関所（MeteredProvider） ── */

function smallModel(): AIProvider {
  return {
    id: "sakura",
    displayName: "さくらのAI",
    isPaid: true,
    isConfigured: async () => true,
    testConnection: async () => ({ ok: true, message: "" }),
    listModels: async () => [],
    generate: async (): Promise<GenerateResult> => ({
      text: "{}",
      truncated: false,
      elapsedMs: 1,
    }),
    getModel: async (id: string): Promise<ModelInfo | undefined> => ({
      id,
      displayName: id,
      contextWindow: 4096,
      parameterSize: null,
      capabilities: [],
      tier: "light",
    }),
  };
}

describe("関所のログ", () => {
  test("出力の上限を縮めた知らせは、呼び出した作品のログへ入る", async () => {
    await useMemoryTuningStore({});
    // 台帳の下ごしらえは workspace.fs を差し替えるので、ログの書き込みだけ横取りし直す
    const memoryFs = workspace.fs as unknown as Record<string, unknown>;
    Object.assign(workspace, {
      fs: {
        ...memoryFs,
        createDirectory: async () => undefined,
        writeFile: async (uri: { path?: string; fsPath?: string }, data: Uint8Array) => {
          const target = uri.fsPath ?? uri.path ?? "";
          if (target.endsWith("actions.log")) {
            written.push({ path: target, text: new TextDecoder().decode(data) });
            return;
          }
          await (memoryFs.writeFile as (u: unknown, d: Uint8Array) => Promise<void>)(uri, data);
        },
      },
    });
    const wrapped = new MeteredProvider(smallModel());
    useLogFile(NIKUHEN);

    await wrapped.generate({
      systemPrompt: "あ".repeat(700),
      userPrompt: "い".repeat(700),
      model: "まだ測っていない小さいモデル",
      temperature: 0,
      maxOutputTokens: 11264,
      plannedOutputTokens: 11264,
      meta: { feature: "typo_check", workFolder: HIGH_ELF },
    });
    await settle();

    expect(linesIn(HIGH_ELF)).toContain("縮めて送ります");
    expect(linesIn(NIKUHEN)).not.toContain("縮めて送ります");
  });
});
