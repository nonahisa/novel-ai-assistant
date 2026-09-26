import { beforeEach, describe, expect, test, vi } from "vitest";
import { window, workspace } from "../support/vscodeStub";
import type { AIRegistry } from "../../../src/ai/registry";
import type { GenerateParams, GenerateResult } from "../../../src/ai/types";

/**
 * AIチューニングの結果が**台帳へ入ったのかどうか**を、作者に正しく伝える
 * （作者の報告、2026-09-19）。
 *
 * 手元の Ollama（`gemma4:26b`）で「読める長さだけ測る」を12分かけて走らせ、
 * 「この結果は…の設定として覚えます」という確認に「設定に反映」を押したのに、
 * 台帳（`model-tuning.json`）は**1バイトも変わらなかった。**
 *
 * 台帳への書き込み（`core/modelTuningStore.ts` の `writeTuningEntry`）は、
 * 書けなかったときに**例外を投げずにログへ1行残すだけ**で戻る。
 * `offerToSave` はその戻りを見ずに「覚えました」と言い切っていたので、
 * **書けていないのに書けたと報告する**ことになっていた。
 */

const state = vi.hoisted(() => ({
  assignment: { providerId: "ollama", model: "gemma4:26b", isPaid: false },
}));

vi.mock("../../../src/ai/registry", () => ({
  ensureConfigured: vi.fn(async () => ({
    provider: {
      id: state.assignment.providerId,
      displayName: state.assignment.providerId,
      isPaid: state.assignment.isPaid,
      generate: async (params: GenerateParams): Promise<GenerateResult> => {
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
    model: state.assignment.model,
  })),
}));

vi.mock("../../../src/features/aiConnectivity", () => ({
  confirmPaidUsage: vi.fn(async () => true),
  confirmProviderReachable: vi.fn(async () => true),
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
  useBrokenTuningStore,
  useMemoryTuningStore,
} from "../support/tuningStore";

const KEY = "ollama/gemma4:26b";

/** 作者の台帳（2026-09-19の報告そのまま）。09-13に測った記録が入っている */
const LEDGER_2026_09_13 = {
  timeoutSeconds: 600,
  measuredChars: 160_834,
  measuredAt: "2026-09-13T04:32:06.069Z",
  outputTokensPerSecond: 9.3,
  charsPerToken: 1.383,
  charsPerTokenSamples: 6,
};

/** 出した通知・警告・エラーの本文を、順に集めておく */
const shown: string[] = [];

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

/** 確認には `answer` で答える。ほかの通知はすべて記録するだけ */
function answerWith(answer: string): void {
  shown.length = 0;
  Object.assign(window, {
    showInformationMessage: vi.fn(async (message: string, ...items: string[]) => {
      shown.push(message);
      return items.includes(answer) ? answer : undefined;
    }),
    showWarningMessage: vi.fn(async (message: string) => {
      shown.push(message);
      return undefined;
    }),
    showErrorMessage: vi.fn(async (message: string) => {
      shown.push(message);
      return undefined;
    }),
  });
}

/** 出した文面のうち、その言葉を含むもの */
function messagesWith(word: string): string[] {
  return shown.filter((message) => message.includes(word));
}

/** 上限は `/api/show` から取れる想定（Ollamaは申告値を持っている） */
const registry = {
  resolveModelInfo: async () => ({ contextWindow: 131_072 }),
} as unknown as AIRegistry;

beforeEach(() => {
  state.assignment = { providerId: "ollama", model: "gemma4:26b", isPaid: false };
});

describe("測った結果が台帳へ入ったかどうか", () => {
  test("書けたときは、測った長さが台帳へ入る", async () => {
    installSettings({ "ollama.timeoutSeconds": 900 });
    await useMemoryTuningStore({ [KEY]: { ...LEDGER_2026_09_13 } });
    answerWith("設定に反映");

    await measureContext(registry, "default", undefined, "input");

    const entry = tuningStoreContents()[KEY] as Record<string, unknown>;
    // **今回の測定で置き換わること。** 09-13 の値が残っているなら、
    // 作者の報告と同じ「押したのに何も変わらない」である
    expect(entry.measuredAt).not.toBe(LEDGER_2026_09_13.measuredAt);
    expect(entry.measuredChars).not.toBe(LEDGER_2026_09_13.measuredChars);
  });

  /**
   * **書けなかったのに「覚えました」と言わない**（作者の報告、2026-09-19）。
   *
   * 台帳が壊れていると `writeTuningEntry` は書き込みを断る（実装ルール2。
   * 作者の実測を空の表で潰さないため）。断ったことはログにしか残らず、
   * 画面には「覚えました」とだけ出ていた——**12分測った結果が消えたことに
   * 作者が気づけない。**
   */
  test("台帳へ書けなかったときは「覚えました」と言わず、書けなかったと伝える", async () => {
    installSettings({ "ollama.timeoutSeconds": 900 });
    await useBrokenTuningStore();
    answerWith("設定に反映");

    await measureContext(registry, "default", undefined, "input");

    expect(messagesWith("覚えました")).toEqual([]);
    // 書けなかったことと、そのせいで測った値が残っていないことを言う
    expect(messagesWith("記録できません").length).toBeGreaterThan(0);
  });

  /**
   * **別の窓と取り合って入らなかったときも同じ**（作者の報告、2026-09-19）。
   *
   * 台帳は3回までやり直して、それでも残らなければ諦める。諦めたことは
   * ログにしか残っていなかった——作者には「押したのに変わらない」としか
   * 見えない。**打つ手（窓を1つにする）まで伝える。**
   */
  test("別の窓に消されて入らなかったときも、覚えたと言わない", async () => {
    installSettings({ "ollama.timeoutSeconds": 900 });
    await useMemoryTuningStore({ [KEY]: { ...LEDGER_2026_09_13 } });
    // 書き込みを黙って捨てる装置にする（外から同時に書かれ続ける状況）
    const fs = workspace.fs as { rename: unknown };
    const original = fs.rename;
    fs.rename = async (): Promise<void> => undefined;
    answerWith("設定に反映");

    await measureContext(registry, "default", undefined, "input");
    fs.rename = original;

    expect(messagesWith("覚えました")).toEqual([]);
    expect(messagesWith("窓を1つに").length).toBeGreaterThan(0);
    // 09-13 の記録は、そのまま残っている（消してはいない）
    const entry = tuningStoreContents()[KEY] as Record<string, unknown>;
    expect(entry.measuredChars).toBe(LEDGER_2026_09_13.measuredChars);
  });

  /**
   * **Ollama では、測った長さは申告より短いときだけ使う**
   * （作者の裁定、2026-09-26 夕。J3。それまでは申告だけを使っていた）。
   *
   * それを断らずに「設定として覚えます」とだけ言うと、作者は測った
   * 138,714字がそのまま効くと読む。**申告との関係を確認の文面で先に言う。**
   */
  test("確認の文面が、記録する欄と記録しない欄を分けて伝える", async () => {
    installSettings({ "ollama.timeoutSeconds": 900 });
    await useMemoryTuningStore({ [KEY]: { ...LEDGER_2026_09_13 } });
    answerWith("そのままにする");

    await measureContext(registry, "default", undefined, "input");

    const confirm = messagesWith("そのままにする").concat(
      shown.filter((message) => message.includes("反映するのは"))
    );
    expect(confirm.length).toBeGreaterThan(0);
    // 申告値を持つ相手では、申告より長くは使わないことを断る
    expect(
      confirm.some((message) => message.includes("申告より長くは使いません"))
    ).toBe(true);
  });
});
