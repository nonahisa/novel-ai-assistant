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
  /** `ensureConfigured` が受け取った機能キー */
  requestedFeatures: [] as unknown[],
  /** 機能キーごとの割当先。無ければ `default` を使う */
  assignments: {} as Record<
    string,
    { providerId: string; model: string; isPaid: boolean }
  >,
}));

vi.mock("../../src/ai/registry", () => ({
  ensureConfigured: vi.fn(async (_registry: unknown, feature: unknown) => {
    state.requestedFeatures.push(feature);
    // **機能別割当（設計書6.28.9）を再現する。** 誤字脱字だけ別のAIへ
    // 割り当てている作者がいるので、既定と食い違うことがある
    const assigned =
      state.assignments[String(feature)] ?? state.assignments.default;
    return {
      provider: {
        id: assigned.providerId,
        displayName: assigned.providerId,
        isPaid: assigned.isPaid,
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
      model: assigned.model,
    };
  }),
}));

vi.mock("../../src/features/aiConnectivity", () => ({
  confirmPaidUsage: vi.fn(async () => true),
  // 疎通の確認は通ったものとして先へ進める（設計書6.51）。
  // ここで測っているのは待ち時間の台帳への書き込みであって、接続ではない
  confirmProviderReachable: vi.fn(async () => true),
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

const OLLAMA = { providerId: "ollama", model: "gemma4:26b", isPaid: false };
const SAKURA = { providerId: "sakura", model: "gpt-oss-120b", isPaid: true };
const KEY = "ollama/gemma4:26b";

/**
 * `novelai.*` の設定を持つ入れ物。`update` はそのまま書き換える。
 *
 * 台帳へ書かれた履歴も残す——**「一度は延ばした」ことを確かめたい**。
 * 最後の状態だけを見ると、そもそも延ばさなかった場合と区別が付かず、
 * 「戻せている」テストが空振りしていても気づけない。
 */
function installSettings(
  values: Record<string, unknown>,
  options: { failTuningWriteAt?: number } = {}
): { tuningWrites: Record<string, unknown>[] } {
  const tuningWrites: Record<string, unknown>[] = [];
  let tuningWriteCount = 0;
  workspace.getConfiguration = () =>
    ({
      get: <T>(key: string, defaultValue?: T): T =>
        (key in values ? values[key] : defaultValue) as T,
      inspect: () => ({ workspaceValue: undefined }),
      update: async (key: string, value: unknown) => {
        if (key === "modelTuning") {
          tuningWriteCount += 1;
          // 指定された順番の書き込みだけを失敗させる（設定が書けない環境の再現）
          if (tuningWriteCount === options.failTuningWriteAt) {
            throw new Error("設定を書き込めませんでした");
          }
          tuningWrites.push(value as Record<string, unknown>);
        }
        values[key] = value;
      },
    }) as unknown as ReturnType<typeof workspace.getConfiguration>;
  return { tuningWrites };
}

/** いまの台帳（`novelai.modelTuning`）を読み出す */
function tuningTable(values: Record<string, unknown>): Record<string, unknown> {
  return (values.modelTuning ?? {}) as Record<string, unknown>;
}

/** 台帳へ書かれた履歴のどこかで、この鍵の待ち時間が延びていたか */
function raisedTo(
  writes: Record<string, unknown>[],
  key: string,
  seconds: number
): boolean {
  return writes.some(
    (table) =>
      (table[key] as { timeoutSeconds?: number } | undefined)?.timeoutSeconds ===
      seconds
  );
}

/** 上限は取れる想定（Ollamaは `/api/show` から読める） */
const registry = {
  resolveModelInfo: async () => ({ contextWindow: 8192 }),
} as unknown as AIRegistry;

function answerWith(answer: string): { showErrorMessage: ReturnType<typeof vi.fn> } {
  const showErrorMessage = vi.fn(async () => undefined);
  Object.assign(window, {
    showInformationMessage: vi.fn(async () => answer),
    showWarningMessage: vi.fn(async () => undefined),
    showErrorMessage,
  });
  return { showErrorMessage };
}

beforeEach(() => {
  state.failNextWithTimeout = true;
  state.generateCalls = 0;
  state.requestedFeatures = [];
  state.assignments = { default: OLLAMA };
});

/**
 * **測るのは「時間切れになった機能が使うAI」でなければならない。**
 *
 * 誤字脱字だけ「さくら / gpt-oss-120b」を割り当て、既定は「Ollama」という
 * 作者がいる（設計書6.28.9）。さくらで時間切れになったのに既定のOllamaを
 * 測ると、台帳の鍵も `ollama/…` になり、**さくらの待ち時間は1秒も
 * 変わらない**。作者には「測ったのに直らない」としか見えない。
 */
describe("どのAIを測るか", () => {
  test("機能キーを渡すと、その機能の割当先を測る", async () => {
    state.assignments = { default: OLLAMA, typo: SAKURA };
    const values: Record<string, unknown> = {};
    installSettings(values);
    answerWith("設定に反映");

    await measureContext(registry, "typo");

    expect(state.requestedFeatures).toEqual(["typo"]);
    // 台帳の鍵も、その機能の割当先のものになる
    expect(Object.keys(tuningTable(values))).toEqual(["sakura/gpt-oss-120b"]);
  });

  test("機能キーを渡さなければ、これまでどおり既定を測る", async () => {
    state.assignments = { default: OLLAMA, typo: SAKURA };
    const values: Record<string, unknown> = {};
    installSettings(values);
    answerWith("設定に反映");

    await measureContext(registry);

    expect(state.requestedFeatures).toEqual(["default"]);
    expect(Object.keys(tuningTable(values))).toEqual([KEY]);
  });
});

describe("測り直しのために延ばした待ち時間", () => {
  test("反映しなければ、元から欄が無かった台帳は元どおり空に戻る", async () => {
    const values: Record<string, unknown> = { "ollama.timeoutSeconds": 180 };
    const { tuningWrites } = installSettings(values);
    // 作者が「そのままにする」を選んだ場面
    answerWith("そのままにする");

    await measureContext(registry);

    // 時間切れを1回起こしたので、180秒が倍の360秒まで延びているはず
    expect(state.failNextWithTimeout).toBe(false);
    expect(raisedTo(tuningWrites, KEY, 360)).toBe(true);
    // **そのうえで、鍵ごと消えていること。** 中身の無い項目を残すと、
    // 作者には「測ったのに何も入っていない」と読める
    expect(tuningTable(values)[KEY]).toBeUndefined();
  });

  test("反映しなければ、元の待ち時間へ戻す（ほかの欄は残す）", async () => {
    const values: Record<string, unknown> = {
      "ollama.timeoutSeconds": 180,
      modelTuning: {
        [KEY]: { contextWindow: 8192, timeoutSeconds: 200, memo: "作者の覚書" },
        // ほかのモデルの項目は、いかなる場合も触らない
        "ollama/gemma4:e4b": { timeoutSeconds: 240 },
      },
    };
    const { tuningWrites } = installSettings(values);
    answerWith("そのままにする");

    await measureContext(registry);

    // **台帳の200秒のほうを倍にする**（設定の180秒ではない）。
    // 台帳が設定に勝つのだから、延ばす元も台帳の値でなければ辻褄が合わない
    expect(raisedTo(tuningWrites, KEY, 400)).toBe(true);
    expect(tuningTable(values)[KEY]).toEqual({
      contextWindow: 8192,
      timeoutSeconds: 200,
      memo: "作者の覚書",
    });
    expect(tuningTable(values)["ollama/gemma4:e4b"]).toEqual({
      timeoutSeconds: 240,
    });
  });

  test("反映すれば、見立てた秒数が入る（倍にした値は残さない）", async () => {
    const values: Record<string, unknown> = { "ollama.timeoutSeconds": 180 };
    const { tuningWrites } = installSettings(values);
    answerWith("設定に反映");

    await measureContext(registry);

    expect(raisedTo(tuningWrites, KEY, 360)).toBe(true);
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

  /**
   * **例外で抜けても、倍にした値を残さない。**
   *
   * 戻す処理が「失敗・中止・非反映」の3経路にしか無いと、通知や設定の
   * 書き込みが投げた瞬間に360秒が残る。そのモデルの**全機能**が以後
   * 360秒待つようになり、しかも理由がどこにも残らない。
   */
  test("反映の書き込みが失敗しても、待ち時間は元へ戻り、失敗が報告される", async () => {
    const values: Record<string, unknown> = { "ollama.timeoutSeconds": 180 };
    // 1回目＝測り直しのために延ばす書き込み、2回目＝反映の書き込み
    installSettings(values, { failTuningWriteAt: 2 });
    const { showErrorMessage } = answerWith("設定に反映");

    await measureContext(registry);

    expect(showErrorMessage).toHaveBeenCalled();
    expect(tuningTable(values)[KEY]).toBeUndefined();
  });
});
