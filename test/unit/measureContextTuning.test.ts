import { beforeEach, describe, expect, test, vi } from "vitest";
import { window, workspace } from "./support/vscodeStub";
import type { AIRegistry } from "../../src/ai/registry";
import { AIError, type GenerateParams, type GenerateResult } from "../../src/ai/types";

/**
 * AIチューニングが**設定へ手を出す範囲**（設計書6.49）。
 *
 * 測り直しのために待ち時間を一時的に延ばすのは構わない——`generate` に
 * 秒数を渡す口が無いので、プロバイダの読む値を変えるしかない。
 * **だが、作者が「設定に反映」を押さなかったら、設定は測る前のままへ戻す。**
 * 押していないのに値が変わっているのは、この作品の原則
 * （作者が押したときだけ書く）に反する。
 */

const state = vi.hoisted(() => ({
  /** 次の1回だけ時間切れにする */
  failNextWithTimeout: false,
  generateCalls: 0,
}));

vi.mock("../../src/ai/registry", () => ({
  ensureConfigured: vi.fn(async () => ({
    provider: {
      id: "ollama" as const,
      displayName: "Ollama（ローカル）",
      isPaid: false,
      generate: async (params: GenerateParams): Promise<GenerateResult> => {
        state.generateCalls += 1;
        if (state.failNextWithTimeout) {
          state.failNextWithTimeout = false;
          throw new AIError("応答がタイムアウトしました。", "timeout");
        }
        // **合言葉をそのまま返す。** 判定（`judgeProbeAnswer`）を通したいので、
        // 送られた指示から読み取って書き写す——実際のAIと同じ振る舞いにする
        const head = /最初の合言葉は『(.+?)』/.exec(params.userPrompt)?.[1] ?? "";
        const tail = /最後の合言葉は『(.+?)』/.exec(params.userPrompt)?.[1] ?? "";
        return {
          text: `${head} ${tail}`,
          usage: { inputTokens: 0, outputTokens: 0 },
          truncated: false,
          elapsedMs: 1,
        };
      },
    },
    model: "gemma4:26b",
  })),
}));

vi.mock("../../src/features/aiConnectivity", () => ({
  confirmPaidUsage: vi.fn(async () => true),
}));

vi.mock("../../src/views/progress", () => ({
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

import { measureContext } from "../../src/features/measureContext";
import { recommendTimeoutSeconds } from "../../src/core/modelTuning";

const KEY = "ollama/gemma4:26b";

/**
 * `novelai.*` の設定を持つ入れ物。`update` はそのまま書き換える。
 *
 * 台帳へ書かれた履歴も残す——**「一度は延ばした」ことを確かめたい**。
 * 最後の状態だけを見ると、そもそも延ばさなかった場合と区別が付かず、
 * 「戻せている」テストが空振りしていても気づけない。
 */
function installSettings(values: Record<string, unknown>): {
  tuningWrites: Record<string, unknown>[];
} {
  const tuningWrites: Record<string, unknown>[] = [];
  workspace.getConfiguration = () =>
    ({
      get: <T>(key: string, defaultValue?: T): T =>
        (key in values ? values[key] : defaultValue) as T,
      update: async (key: string, value: unknown) => {
        values[key] = value;
        if (key === "modelTuning") {
          tuningWrites.push(value as Record<string, unknown>);
        }
      },
    }) as unknown as ReturnType<typeof workspace.getConfiguration>;
  return { tuningWrites };
}

/** 台帳へ書かれた履歴のどこかで、この鍵の待ち時間が延びていたか */
function raisedTo(
  writes: Record<string, unknown>[],
  seconds: number
): boolean {
  return writes.some(
    (table) =>
      (table[KEY] as { timeoutSeconds?: number } | undefined)?.timeoutSeconds ===
      seconds
  );
}

/** いまの台帳（`novelai.modelTuning`）を読み出す */
function tuningTable(values: Record<string, unknown>): Record<string, unknown> {
  return (values.modelTuning ?? {}) as Record<string, unknown>;
}

/** 上限は取れる想定（Ollamaは `/api/show` から読める） */
const registry = {
  resolveModelInfo: async () => ({ contextWindow: 8192 }),
} as unknown as AIRegistry;

describe("測り直しのために延ばした待ち時間", () => {
  beforeEach(() => {
    state.failNextWithTimeout = true;
    state.generateCalls = 0;
  });

  test("反映しなければ、元から欄が無かった台帳は元どおり空に戻る", async () => {
    const values: Record<string, unknown> = { "ollama.timeoutSeconds": 180 };
    const { tuningWrites } = installSettings(values);
    Object.assign(window, {
      // 作者が「そのままにする」を選んだ場面
      showInformationMessage: vi.fn(async () => "そのままにする"),
      showErrorMessage: vi.fn(async () => undefined),
    });

    await measureContext(registry);

    // 時間切れを1回起こしたので、180秒が倍の360秒まで延びているはず
    expect(state.failNextWithTimeout).toBe(false);
    expect(raisedTo(tuningWrites, 360)).toBe(true);
    // **そのうえで、鍵ごと消えていること。** 中身の無い項目を残すと、
    // 作者には「測ったのに何も入っていない」と読める
    expect(tuningTable(values)[KEY]).toBeUndefined();
  });

  test("反映しなければ、元の待ち時間へ戻す（ほかの欄は残す）", async () => {
    const values: Record<string, unknown> = {
      "ollama.timeoutSeconds": 180,
      modelTuning: {
        [KEY]: { contextWindow: 8192, timeoutSeconds: 200 },
        // ほかのモデルの項目は、いかなる場合も触らない
        "ollama/gemma4:e4b": { timeoutSeconds: 240 },
      },
    };
    const { tuningWrites } = installSettings(values);
    Object.assign(window, {
      showInformationMessage: vi.fn(async () => "そのままにする"),
      showErrorMessage: vi.fn(async () => undefined),
    });

    await measureContext(registry);

    // **台帳の200秒のほうを倍にする**（設定の180秒ではない）。
    // 台帳が設定に勝つのだから、延ばす元も台帳の値でなければ辻褄が合わない
    expect(raisedTo(tuningWrites, 400)).toBe(true);
    expect(tuningTable(values)[KEY]).toEqual({
      contextWindow: 8192,
      timeoutSeconds: 200,
    });
    expect(tuningTable(values)["ollama/gemma4:e4b"]).toEqual({
      timeoutSeconds: 240,
    });
  });

  test("反映すれば、見立てた秒数が入る（倍にした値は残さない）", async () => {
    const values: Record<string, unknown> = { "ollama.timeoutSeconds": 180 };
    const { tuningWrites } = installSettings(values);
    Object.assign(window, {
      showInformationMessage: vi.fn(async () => "設定に反映"),
      showErrorMessage: vi.fn(async () => undefined),
    });

    await measureContext(registry);

    expect(raisedTo(tuningWrites, 360)).toBe(true);
    const entry = tuningTable(values)[KEY] as Record<string, unknown>;
    // 応答は一瞬で返る作りなので、見立ては下限（180秒）に落ち着く。
    // **測り直しのために書いた360秒が残っていないこと**が要点である
    expect(entry.timeoutSeconds).toBe(recommendTimeoutSeconds(0));
    expect(entry.timeoutSeconds).not.toBe(360);
    expect(entry.measuredChars).toBeGreaterThan(0);
    expect(typeof entry.measuredAt).toBe("string");
    // Ollamaは上限を `/api/show` から取れるので、測った値で潰さない
    expect(entry.contextWindow).toBeUndefined();
  });
});
