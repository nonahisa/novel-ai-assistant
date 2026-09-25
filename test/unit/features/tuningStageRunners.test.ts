import { beforeEach, describe, expect, test, vi } from "vitest";
import { window, workspace } from "../support/vscodeStub";
import {
  AIError,
  type AIProvider,
  type GenerateParams,
  type GenerateResult,
  type ProviderId,
} from "../../../src/ai/types";

/**
 * AIチューニング「仕事に近い形で測る」の走らせ方（設計書6.49.9。作者の判断、
 * 2026-09-26）。
 *
 * 守ること：
 *
 * 1. **製品の誤字脱字と同じ形で送る**（プロンプト・形式の強制・機能名）
 * 2. **測った値を台帳へ覚える**——1000字あたりの秒数と考えるモデルかは
 *    押さなくても、待ち時間と読める長さは「反映」を押したときだけ
 * 3. **手元のAIは読み込みの1回を測りから外す**
 * 4. **失敗から学習しない**（規則5）——止める指定の回が失敗しても「効かない」と
 *    書かない。断られた文から読んだ長さも、収まる要求が通ってから
 * 5. **壊れた台帳は直さない**（規則2）
 * 6. **有料AIでは、測る前に回数を示す**
 * 7. **同梱より作者の実測が勝つ**
 */

const confirmCalls = vi.hoisted(() => ({
  list: [] as Array<{ calls?: number; detail?: string }>,
  answer: true,
}));

vi.mock("../../../src/features/aiConnectivity", () => ({
  confirmPaidUsage: vi.fn(
    async (provider: { isPaid: boolean }, options: { calls?: number; detail?: string }) => {
      // 無料のAIには確認を出さない（製品と同じ）
      if (!provider.isPaid) return true;
      confirmCalls.list.push(options);
      return confirmCalls.answer;
    }
  ),
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

import {
  runTuningStages,
  runWorkTuning,
  type StageContext,
} from "../../../src/features/tuningStageRunners";
import {
  modelTuningKey,
  modelTuningRaw,
  recommendTimeoutFromWorkRate,
  resolveContextWindow,
  LOCAL_MAX_TIMEOUT_SECONDS,
} from "../../../src/core/modelTuning";
import {
  TUNING_WORK_FEATURE,
  plannedCallCount,
  plannedStages,
} from "../../../src/core/tuningStages";
import {
  TUNING_WORK_LONG,
  TUNING_WORK_PARAGRAPHS,
  TUNING_WORK_SHORT,
  TUNING_WORK_WARMUP,
} from "../../../src/core/tuningWorkSample";
import {
  TYPO_CHECK_SCHEMA,
  TYPO_CHECK_SYSTEM_PROMPT,
} from "../../../src/prompts/typoCheck";
import { SAKURA_CONTEXT_WINDOW } from "../../../src/ai/sakuraProvider";
import {
  tuningWrites,
  useBrokenTuningStore,
  useMemoryTuningStore,
} from "../support/tuningStore";

/** 作り物のAIの振る舞い */
interface FakeBehavior {
  /** 思考を止める指定を送らないとき考えるか */
  thinks: boolean;
  /** 止める指定が効くか */
  offWorks: boolean;
  /** 1回ごとに決まってかかるミリ秒 */
  fixedMs: number;
  /** 本文1字あたりのミリ秒 */
  perCharMs: number;
  /** 読める長さ（出力の上限がこれを超えたら断る）。無ければ断らない */
  declaredLimit?: number;
  /** 確かめの回も断るか（読み違いの再現） */
  rejectConfirm?: boolean;
  /** 先頭から数えて何回目までを失敗させるか、その失敗 */
  failFirst?: { count: number; error: () => AIError };
  /** 止める指定を送った回だけ失敗させる */
  failWhenThinkingOff?: () => AIError;
  /** 1回目だけ、この時間がかかる（読み込みの再現） */
  firstCallMs?: number;
}

const LLM_JP_TEXT =
  "This model's maximum context length is 4096 tokens and your request has 16 input tokens (11264 > 4096 - 16).";

function fakeProvider(
  id: ProviderId,
  isPaid: boolean,
  behavior: FakeBehavior,
  calls: GenerateParams[]
): AIProvider {
  return {
    id,
    displayName: id,
    isPaid,
    isConfigured: async () => true,
    testConnection: async () => ({ ok: true, message: "" }),
    listModels: async () => [],
    generate: async (params: GenerateParams): Promise<GenerateResult> => {
      calls.push(params);
      const index = calls.length;
      if (behavior.failFirst && index <= behavior.failFirst.count) {
        throw behavior.failFirst.error();
      }
      // 読める長さの申告の回
      if (params.userPrompt.includes("「はい」とだけ")) {
        const limit = behavior.declaredLimit;
        const asked = params.maxOutputTokens ?? 0;
        const isConfirm = asked < 2_000_000;
        if (limit !== undefined && (asked > limit || (isConfirm && behavior.rejectConfirm))) {
          // llm-jp の実際の文の形で、数字だけこのAIの長さにする
          throw new AIError(
            "読める長さを超えました。",
            "context_overflow",
            LLM_JP_TEXT.replaceAll("4096", String(limit))
          );
        }
        return { text: "はい", truncated: false, elapsedMs: 100 };
      }
      if (params.disableThinking && behavior.failWhenThinkingOff) {
        throw behavior.failWhenThinkingOff();
      }
      // 長い回は2〜4段落目、読み込ませる回は3段落目だけ、短い回は1段落目
      const body = params.userPrompt.includes(TUNING_WORK_PARAGRAPHS[1])
        ? TUNING_WORK_LONG
        : params.userPrompt.includes(TUNING_WORK_WARMUP)
          ? TUNING_WORK_WARMUP
          : TUNING_WORK_SHORT;
      const thinking =
        behavior.thinks && (!params.disableThinking || !behavior.offWorks)
          ? "考えています。".repeat(200)
          : undefined;
      const answer = '{"issues":[{"line":1,"original":"名前を読んだ","target":"読んだ","suggestion":"呼んだ","reason":"誤変換","confidence":"high"}]}';
      const elapsedMs =
        index === 1 && behavior.firstCallMs !== undefined
          ? behavior.firstCallMs
          : behavior.fixedMs + behavior.perCharMs * body.length;
      return {
        text: answer,
        ...(thinking !== undefined ? { thinking } : {}),
        usage: {
          inputTokens: 1000,
          outputTokens: answer.length + (thinking?.length ?? 0),
        },
        truncated: false,
        elapsedMs,
      };
    },
  };
}

function context(provider: AIProvider, model: string): StageContext {
  return {
    provider,
    model,
    target: {
      providerId: provider.id,
      local: provider.id === "ollama" || provider.id === "lmstudio",
    },
    signal: new AbortController().signal,
    report: () => {},
  };
}

function answerWith(answer: string | undefined): ReturnType<typeof vi.fn> {
  const showInformationMessage = vi.fn(async () => answer);
  Object.assign(window, {
    showInformationMessage,
    showWarningMessage: vi.fn(async () => undefined),
    showErrorMessage: vi.fn(async () => undefined),
  });
  return showInformationMessage;
}

beforeEach(async () => {
  confirmCalls.list = [];
  confirmCalls.answer = true;
  // 作者は何も設定に書いていない（`inspect` が値を返さない）。書いてあると
  // 読み順で設定が同梱より先に来るので、同梱と実測の比べにならない
  workspace.getConfiguration = () =>
    ({
      get: <T>(_key: string, defaultValue: T): T => defaultValue,
      inspect: () => ({}),
    }) as unknown as ReturnType<typeof workspace.getConfiguration>;
  await useMemoryTuningStore({});
});

describe("製品の誤字脱字と同じ形で送る", () => {
  test("指示・形式の強制・機能名が製品と同じ", async () => {
    const calls: GenerateParams[] = [];
    const provider = fakeProvider(
      "ollama",
      false,
      { thinks: false, offWorks: true, fixedMs: 1000, perCharMs: 5 },
      calls
    );
    await runTuningStages(context(provider, "gemma4:e4b"));
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.systemPrompt).toBe(TYPO_CHECK_SYSTEM_PROMPT);
      expect(call.jsonSchema).toBe(TYPO_CHECK_SCHEMA);
      // 関所は素通りさせない（製品と同じ検査を通す）
      expect(call.meta?.feature).toBe(TUNING_WORK_FEATURE);
      expect(call.userPrompt).toContain("誤字・脱字・変換ミス");
      // 作者の作品ではなく、同梱の文を送る
      expect(call.userPrompt).toContain("澪");
    }
  });
});

describe("測った値を覚える", () => {
  test("1000字あたりの秒数と考えるモデルかは、押さなくても台帳へ入る", async () => {
    const calls: GenerateParams[] = [];
    // 1回ごとに5秒＋1字あたり10ミリ秒（＝1000字あたり10秒）
    const provider = fakeProvider(
      "ollama",
      false,
      { thinks: true, offWorks: true, fixedMs: 5000, perCharMs: 10 },
      calls
    );
    const result = await runTuningStages(context(provider, "gemma4:e4b"));

    const ledger = modelTuningRaw("ollama", "gemma4:e4b");
    expect(ledger?.workFixedSeconds).toBe(5);
    expect(ledger?.workSecondsPer1000Chars).toBe(10);
    expect(ledger?.thinkingSeen).toBe(true);
    expect(ledger?.thinkingOffWorks).toBe(true);
    expect(ledger?.thinkingOverheadTokens).toBeUndefined();
    // 待ち時間は**提案だけ**で、台帳にはまだ入っていない
    expect(ledger?.timeoutSeconds).toBeUndefined();
    expect(result.proposal.timeoutSeconds).toBe(
      recommendTimeoutFromWorkRate(
        { fixedSeconds: 5, secondsPer1000Chars: 10 },
        LOCAL_MAX_TIMEOUT_SECONDS
      )
    );
    expect(result.recorded).toBe(true);
    // 思考の見分け2回＋測る形で読み込ませる1回＋短い・長い2回
    expect(calls).toHaveLength(5);
  });

  test("止める指定が効かないモデルは、思考のぶんを台帳に残す", async () => {
    const provider = fakeProvider(
      "sakura",
      false,
      { thinks: true, offWorks: false, fixedMs: 3000, perCharMs: 2 },
      []
    );
    await runTuningStages(context(provider, "preview/Kimi-K2.6"));
    const ledger = modelTuningRaw("sakura", "preview/Kimi-K2.6");
    expect(ledger?.thinkingOffWorks).toBe(false);
    expect(ledger?.thinkingOverheadTokens).toBeGreaterThan(0);
  });

  test("効くと分かったら、前に残した「効かない」と思考のぶんは消える", async () => {
    await useMemoryTuningStore({
      [modelTuningKey("sakura", "preview/Qwen3.6-35B-A3B")]: {
        thinkingSeen: true,
        thinkingOffWorks: false,
        thinkingOverheadTokens: 2560,
      },
    });
    const provider = fakeProvider(
      "sakura",
      false,
      { thinks: true, offWorks: true, fixedMs: 3000, perCharMs: 2 },
      []
    );
    await runTuningStages(context(provider, "preview/Qwen3.6-35B-A3B"));
    const ledger = modelTuningRaw("sakura", "preview/Qwen3.6-35B-A3B");
    expect(ledger?.thinkingOffWorks).toBe(true);
    expect(ledger?.thinkingOverheadTokens).toBeUndefined();
  });
});

describe("手元のAIは、読み込みの1回を測りから外す", () => {
  test("前の段が載せていても、測る形の1回を先に入れる（読み込み直しを測りに混ぜない）", async () => {
    // 実接続（gemma4:e4b）では、思考の段の「止めない回」と文脈の長さが違い、
    // 時間の段の1回目で読み込み直しが起きて17秒かかった。その再現
    const calls: GenerateParams[] = [];
    const provider = fakeProvider(
      "ollama",
      false,
      { thinks: true, offWorks: true, fixedMs: 5000, perCharMs: 10 },
      calls
    );
    const original = provider.generate.bind(provider);
    provider.generate = async (params) => {
      const result = await original(params);
      // 3回目（思考の段のあと、最初の止める指定ありの回）だけ読み込み直しで遅い
      return calls.length === 3 ? { ...result, elapsedMs: 17_000 } : result;
    };
    await runTuningStages(context(provider, "gemma4:e4b"));
    const ledger = modelTuningRaw("ollama", "gemma4:e4b");
    expect(ledger?.workFixedSeconds).toBe(5);
    expect(ledger?.workSecondsPer1000Chars).toBe(10);
    // 読み込ませる回（3回目）は、測る回（4・5回目）と本文が違う
    // （同じだと読み込みの使い回しで、測る回の時間から読み込みが消える）
    expect(calls[2].userPrompt).not.toBe(calls[3].userPrompt);
    expect(calls[2].userPrompt).not.toBe(calls[4].userPrompt);
  });

  test("クラウドには読み込みの1回を入れない（回数を増やさない）", async () => {
    const calls: GenerateParams[] = [];
    const provider = fakeProvider(
      "sakura",
      false,
      { thinks: false, offWorks: true, fixedMs: 3000, perCharMs: 2 },
      calls
    );
    await runTuningStages(context(provider, "preview/gemma-4-31B-it"));
    const typoCalls = calls.filter((call) => call.userPrompt.includes("誤字・脱字"));
    // 思考の見分け2回＋短い・長い2回
    expect(typoCalls).toHaveLength(4);
  });

  test("前の段が失敗して載っていなければ、時間の段が1回読み込ませてから測る", async () => {
    const calls: GenerateParams[] = [];
    const provider = fakeProvider(
      "ollama",
      false,
      {
        thinks: false,
        offWorks: true,
        fixedMs: 5000,
        perCharMs: 10,
        // 思考の見分けの2回が失敗（続けられる失敗）
        failFirst: {
          count: 2,
          error: () => new AIError("形式が不正です", "bad_response"),
        },
      },
      calls
    );
    // 3回目（＝時間の段の読み込み）だけ60秒かかる
    const slowFirst = provider.generate.bind(provider);
    let seen = 0;
    provider.generate = async (params) => {
      const result = await slowFirst(params);
      seen += 1;
      return seen === 1 ? { ...result, elapsedMs: 60_000 } : result;
    };

    await runTuningStages(context(provider, "gemma4:26b"));
    // 思考2（失敗）＋読み込み1＋短い・長い2
    expect(calls).toHaveLength(5);
    const ledger = modelTuningRaw("ollama", "gemma4:26b");
    // 読み込みの60秒は混ざっていない
    expect(ledger?.workFixedSeconds).toBe(5);
    expect(ledger?.workSecondsPer1000Chars).toBe(10);
  });
});

describe("測ったときに載っていたモデルの印（Ollama）", () => {
  test("ほかのモデルが居たら印を付けて言う。下ろしはしない", async () => {
    const provider = fakeProvider(
      "ollama",
      false,
      { thinks: false, offWorks: true, fixedMs: 5000, perCharMs: 10 },
      []
    );
    const result = await runTuningStages({
      ...context(provider, "gemma4:12b"),
      readLoadedModels: async () => [
        // 測るモデルは GPU に入りきらず、CPU と分けて載っていた
        { name: "gemma4:12b", sizeBytes: 9_000_000_000, sizeVramBytes: 7_000_000_000 },
        // 前に使ったモデルが居残っていた
        { name: "gemma4:26b", sizeBytes: 1_200_000_000, sizeVramBytes: 900_000_000 },
      ],
    });
    const ledger = modelTuningRaw("ollama", "gemma4:12b");
    expect(ledger?.workOtherModelsLoaded).toBe(true);
    expect(ledger?.workSplitAcrossCpu).toBe(true);
    const text = result.summaries.join("");
    expect(text).toContain("gemma4:26b");
    expect(text).toContain("長めに");
    expect(text).toContain("下ろしていません");
    expect(text).toContain("CPU");
  });

  test("測るモデルだけが GPU に全部載っていれば、印は false（前の印は残さない）", async () => {
    await useMemoryTuningStore({
      [modelTuningKey("ollama", "gemma4:12b")]: {
        workOtherModelsLoaded: true,
        workSplitAcrossCpu: true,
      },
    });
    const provider = fakeProvider(
      "ollama",
      false,
      { thinks: false, offWorks: true, fixedMs: 5000, perCharMs: 10 },
      []
    );
    const result = await runTuningStages({
      ...context(provider, "gemma4:12b"),
      readLoadedModels: async () => [
        { name: "gemma4:12b", sizeBytes: 7_000_000_000, sizeVramBytes: 7_000_000_000 },
      ],
    });
    const ledger = modelTuningRaw("ollama", "gemma4:12b");
    expect(ledger?.workOtherModelsLoaded).toBe(false);
    expect(ledger?.workSplitAcrossCpu).toBe(false);
    expect(result.summaries.join("")).not.toContain("ほかのモデル");
  });

  test("見られなければ印を付けない（前の印も消す）", async () => {
    await useMemoryTuningStore({
      [modelTuningKey("ollama", "gemma4:12b")]: { workOtherModelsLoaded: true },
    });
    const provider = fakeProvider(
      "ollama",
      false,
      { thinks: false, offWorks: true, fixedMs: 5000, perCharMs: 10 },
      []
    );
    await runTuningStages({
      ...context(provider, "gemma4:12b"),
      readLoadedModels: async () => undefined,
    });
    expect(modelTuningRaw("ollama", "gemma4:12b")?.workOtherModelsLoaded).toBeUndefined();
  });
});

describe("失敗から学習しない（規則5）", () => {
  test("止める指定を送った回が失敗しても、「効かない」とは書かない", async () => {
    const provider = fakeProvider(
      "sakura",
      false,
      {
        thinks: true,
        offWorks: true,
        fixedMs: 3000,
        perCharMs: 2,
        failWhenThinkingOff: () => new AIError("400", "bad_response"),
      },
      []
    );
    await runTuningStages(context(provider, "preview/Qwen3.6-35B-A3B"));
    const ledger = modelTuningRaw("sakura", "preview/Qwen3.6-35B-A3B");
    expect(ledger?.thinkingSeen).toBe(true);
    expect(ledger?.thinkingOffWorks).toBeUndefined();
  });

  test("鍵が効かないような失敗では、残りの段を試さない", async () => {
    const calls: GenerateParams[] = [];
    const provider = fakeProvider(
      "sakura",
      true,
      {
        thinks: false,
        offWorks: true,
        fixedMs: 3000,
        perCharMs: 2,
        failFirst: {
          count: 99,
          error: () => new AIError("鍵が違います", "authentication_failed"),
        },
      },
      calls
    );
    const result = await runTuningStages(context(provider, "gpt-oss-120b"));
    expect(calls).toHaveLength(1);
    expect(result.fatal?.kind).toBe("authentication_failed");
    expect(modelTuningRaw("sakura", "gpt-oss-120b")).toBeUndefined();
  });
});

describe("壊れた台帳は直さない（規則2）", () => {
  test("書き込みを断られたら「記録できません」と言い、ファイルに触らない", async () => {
    await useBrokenTuningStore();
    const provider = fakeProvider(
      "ollama",
      false,
      { thinks: false, offWorks: true, fixedMs: 5000, perCharMs: 10 },
      []
    );
    const result = await runTuningStages(context(provider, "gemma4:e4b"));
    expect(result.recorded).toBe(false);
    expect(result.summaries.join("")).toContain("記録できませんでした");
    // 壊れた上から書くと、作者の実測がその場で消える
    expect(tuningWrites).toHaveLength(0);
  });
});

describe("読める長さを、断られた文から覚える", () => {
  test("有料AIでは測る前に回数を示し、反映を押すと読める長さと待ち時間が入る", async () => {
    const calls: GenerateParams[] = [];
    const provider = fakeProvider(
      "sakura",
      true,
      {
        thinks: false,
        offWorks: true,
        fixedMs: 3000,
        perCharMs: 2,
        declaredLimit: 4096,
      },
      calls
    );
    answerWith("設定に反映");
    await runWorkTuning(provider, "llm-jp-test");

    // 測る前に、回数の合計と内訳を示した
    const target = { providerId: "sakura", local: false };
    expect(confirmCalls.list).toHaveLength(1);
    expect(confirmCalls.list[0].calls).toBe(plannedCallCount(target));
    expect(confirmCalls.list[0].detail).toContain(
      `合わせて最大 ${plannedCallCount(target)} 回`
    );
    expect(plannedStages(target).map((stage) => stage.id)).toContain("declaredLimit");
    // 実際の回数は見せた数を超えない
    expect(calls.length).toBeLessThanOrEqual(plannedCallCount(target));

    const ledger = modelTuningRaw("sakura", "llm-jp-test");
    expect(ledger?.contextWindow).toBe(4096);
    expect(ledger?.contextDeclared).toContain("4096");
    expect(ledger?.timeoutSeconds).toBeGreaterThanOrEqual(180);
    // 断らせる回は関所を素通りし、確かめの回は読んだ長さに収まる上限で送った
    const declaredCalls = calls.filter((call) => call.userPrompt.includes("「はい」とだけ"));
    expect(declaredCalls).toHaveLength(2);
    expect(declaredCalls[1].maxOutputTokens).toBeLessThan(4096);
  });

  test("有料AIで確認を断れば、1回も送らない", async () => {
    confirmCalls.answer = false;
    const calls: GenerateParams[] = [];
    const provider = fakeProvider(
      "sakura",
      true,
      { thinks: false, offWorks: true, fixedMs: 3000, perCharMs: 2 },
      calls
    );
    answerWith(undefined);
    await runWorkTuning(provider, "gpt-oss-120b");
    expect(calls).toHaveLength(0);
  });

  test("反映を押さなければ、待ち時間も読める長さも入らない", async () => {
    const provider = fakeProvider(
      "sakura",
      true,
      { thinks: false, offWorks: true, fixedMs: 3000, perCharMs: 2, declaredLimit: 4096 },
      []
    );
    answerWith("そのままにする");
    await runWorkTuning(provider, "llm-jp-test");
    const ledger = modelTuningRaw("sakura", "llm-jp-test");
    expect(ledger?.contextWindow).toBeUndefined();
    expect(ledger?.timeoutSeconds).toBeUndefined();
    // 参考値（1000字あたり）は押さなくても入っている
    expect(ledger?.workSecondsPer1000Chars).toBeGreaterThan(0);
  });

  test("収まるはずの要求まで断られたら、読んだ長さを覚えない", async () => {
    const provider = fakeProvider(
      "sakura",
      true,
      {
        thinks: false,
        offWorks: true,
        fixedMs: 3000,
        perCharMs: 2,
        declaredLimit: 4096,
        rejectConfirm: true,
      },
      []
    );
    const showInformationMessage = answerWith("設定に反映");
    await runWorkTuning(provider, "llm-jp-test");
    expect(modelTuningRaw("sakura", "llm-jp-test")?.contextWindow).toBeUndefined();
    const shown = showInformationMessage.mock.calls.map((call) => String(call[0])).join("\n");
    expect(shown).toContain("覚えません");
  });

  test("同梱の初期値より、作者の機械で確かめた値が勝つ", async () => {
    // gpt-oss-120b の同梱は 138,597トークン。サーバーが 131,072 と述べた
    const provider = fakeProvider(
      "sakura",
      true,
      { thinks: false, offWorks: true, fixedMs: 3000, perCharMs: 2, declaredLimit: 131072 },
      []
    );
    expect(resolveContextWindow("sakura", "gpt-oss-120b", SAKURA_CONTEXT_WINDOW)).toBe(
      138597
    );
    answerWith("設定に反映");
    await runWorkTuning(provider, "gpt-oss-120b");
    expect(resolveContextWindow("sakura", "gpt-oss-120b", SAKURA_CONTEXT_WINDOW)).toBe(
      131072
    );
  });
});
