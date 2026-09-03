import { beforeEach, describe, expect, test, vi } from "vitest";
import { window, workspace } from "./support/vscodeStub";
import type { AIRegistry } from "../../src/ai/registry";
import {
  AIError,
  type GenerateParams,
  type GenerateResult,
  type ProviderId,
} from "../../src/ai/types";
import { CONTEXT_GUARD_EXEMPT_FEATURE } from "../../src/ai/contextGuard";
import { OUTPUT_PROBE_SYSTEM_PROMPT } from "../../src/core/outputProbe";

/**
 * AIチューニングは、読める長さのあとに**書ける量**も測る（設計書6.61）。
 *
 * チャンクの天井は当て推量だった。本当の縛りは「応答が出力上限に収まるか」
 * なのに、手元のAIには出力上限を**訊く口が無い**（Ollamaの `/api/show` にも
 * LM Studio にもその項目は無い）。**訊けないなら測るしかない。**
 *
 * ここで守るのは、中核（`core/outputProbe.ts`）が持たない4点である。
 *
 * 1. 入力の測定のあとに、続けて出力の測定が走ること
 * 2. 相手が書ける量に応じた値が報告されること
 * 3. **クラウドAIでは測らないこと**（申告値がAPIから取れるうえ、
 *    出力トークンは単価が高い）
 * 4. **出力の測定が失敗しても、入力の結果を捨てないこと**
 */

/** 0001 から n 行ぶんの、正しい返事 */
function perfect(n: number): string {
  return Array.from({ length: n }, (_, i) =>
    String(i + 1).padStart(4, "0")
  ).join("\n");
}

const state = vi.hoisted(() => ({
  /** どのAIとして振る舞うか */
  providerId: "ollama" as ProviderId,
  isPaid: false,
  /** 申告の文脈長 */
  declaredContextWindow: 262144 as number | undefined,
  /** このAIが1回の応答で本当に書ける行数 */
  trueLimit: 9999,
  /** 出力の測定の n 回目に投げるエラー（1始まり） */
  outputErrors: {} as Record<number, AIError>,
  /** `generate` が受け取った引数を、そのまま全部残す */
  calls: [] as GenerateParams[],
  /** 出力の測定として送られた回数 */
  outputRounds: 0,
}));

const log = vi.hoisted(() => ({
  steps: [] as string[],
  failures: [] as Array<[string, Record<string, unknown>]>,
}));

vi.mock("../../src/core/logger", () => ({
  logStep: vi.fn((message: string) => {
    log.steps.push(message);
  }),
  logLine: vi.fn((message: string) => {
    log.steps.push(message);
  }),
  logFailure: vi.fn((context: string, detail: Record<string, unknown>) => {
    log.failures.push([context, detail]);
  }),
  showLog: vi.fn(),
  useLogFile: vi.fn(),
}));

vi.mock("../../src/ai/registry", () => ({
  ensureConfigured: vi.fn(async () => ({
    provider: {
      id: state.providerId,
      displayName: "検査用",
      isPaid: state.isPaid,
      generate: async (params: GenerateParams): Promise<GenerateResult> => {
        state.calls.push(params);

        // 出力の測定：頼まれた行数まで（ただし本当に書ける量まで）番号を返す
        const asked = /0001 から順に (\d+) 行/.exec(params.userPrompt)?.[1];
        if (asked !== undefined) {
          state.outputRounds += 1;
          const failure = state.outputErrors[state.outputRounds];
          if (failure) throw failure;
          const lines = Math.min(Number(asked), state.trueLimit);
          return {
            text: perfect(lines),
            // **実際に使ったトークン数が応答に付いてくる**（Ollamaの
            // `eval_count`）。1行およそ3トークンとして返す
            usage: { inputTokens: 0, outputTokens: lines * 3 },
            truncated: lines < Number(asked),
            elapsedMs: 1,
          };
        }

        // 入力の測定：合言葉を書き写す
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
    model: "gemma4:12b",
  })),
}));

vi.mock("../../src/features/aiConnectivity", () => ({
  confirmPaidUsage: vi.fn(async () => true),
  confirmProviderReachable: vi.fn(async () => true),
  // 手元AIの判定（`ai/otherLocalAi.ts`）が同じ束に入るので、
  // 参照されている口は塞いでおく（呼ばれはしない）
  ollamaEndpoint: vi.fn(() => "http://127.0.0.1:11434"),
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

/** `novelai.*` の設定を持つ入れ物 */
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

const registry = {
  resolveModelInfo: async () =>
    state.declaredContextWindow === undefined
      ? undefined
      : { contextWindow: state.declaredContextWindow },
} as unknown as AIRegistry;

function answerWith(answer: string): {
  showInformationMessage: ReturnType<typeof vi.fn>;
  showErrorMessage: ReturnType<typeof vi.fn>;
} {
  const showInformationMessage = vi.fn(async () => answer);
  const showErrorMessage = vi.fn(async () => undefined);
  Object.assign(window, {
    showInformationMessage,
    showWarningMessage: vi.fn(async () => undefined),
    showErrorMessage,
  });
  return { showInformationMessage, showErrorMessage };
}

/** 通知に出た文（作者が実際に読むもの） */
function noticeText(
  showInformationMessage: ReturnType<typeof vi.fn>
): string {
  return showInformationMessage.mock.calls.map((call) => String(call[0])).join("\n");
}

/** 出力の測定として送られた呼び出し */
function outputCalls(): GenerateParams[] {
  return state.calls.filter((call) => call.userPrompt.includes("4桁の数字"));
}

beforeEach(() => {
  state.providerId = "ollama";
  state.isPaid = false;
  state.declaredContextWindow = 262144;
  state.trueLimit = 9999;
  state.outputErrors = {};
  state.calls = [];
  state.outputRounds = 0;
  log.steps = [];
  log.failures = [];
});

describe("手元のAIでは、読める長さのあとに書ける量も測る", () => {
  test("入力の測定に続けて出力の測定が走り、結果を同じ通知で見せる", async () => {
    const values: Record<string, unknown> = {};
    installSettings(values);
    const { showInformationMessage } = answerWith("そのままにする");

    await measureContext(registry);

    // 入力の測定のあとに送っている（先に合言葉、あとから数字）
    expect(outputCalls().length).toBeGreaterThan(0);
    expect(state.calls[0]?.userPrompt).toContain("合言葉");

    const probe = outputCalls()[0];
    expect(probe.systemPrompt).toBe(OUTPUT_PROBE_SYSTEM_PROMPT);
    // 書き写すだけの入力側と同じく、揺らす理由が無い
    expect(probe.temperature).toBe(0);
    expect(probe.disableThinking).toBe(true);
    /*
      **流し受信は断る**（作者の報告「F5でAIチューニングが終わりません」
      2026-09-03）。流す道は断片が届くたびに待ち時間を数え直すので、
      数千行の列挙を頼まれて繰り返しに崩れたモデルを**永遠に待つ**。
      時間切れを「その量は書けない」と数えて前へ進む設計（`outputProbe.ts`）
      なので、絶対の締め切りが要る。
    */
    expect(probe.disableStreaming).toBe(true);
    // **入力側も同じ。** 測るのは配布と同じ道の性能である
    expect(state.calls[0]?.disableStreaming).toBe(true);
    // 設定の出力上限をそのまま渡す（測っているのがこの上限だから）
    expect(probe.maxOutputTokens).toBe(16384);
    // **num_ctx は渡さない。** 送る長さから決めさせる（6.62.2）
    expect(probe.numCtx).toBeUndefined();
    // 関所は素通り（入力側と同じ。文字列を写さず定数で確かめる）
    expect(probe.meta?.feature).toBe(CONTEXT_GUARD_EXEMPT_FEATURE);
    // 作品に属さない呼び出しなので、どの作品の送信量にも混ぜない
    expect(probe.meta?.workFolder).toBeUndefined();
    /*
      **`capOutputTokens` は出力の測定だけが立てる**（設計書6.65.14の4）。
      入力側（合言葉を書き写すだけの呼び出し）まで立ててしまうと、
      その回の応答が短い上限で切られかねない。
    */
    expect(probe.capOutputTokens).toBe(true);
    expect(state.calls[0]?.capOutputTokens).not.toBe(true);

    // 入力の結果と出力の結果が、1つの通知に並ぶ
    const text = noticeText(showInformationMessage);
    expect(text).toContain("実効の上限");
    expect(text).toContain("書けたのは");

    // 1回ごとにログへ残す（あとから追えるように）
    expect(
      log.steps.some(
        (line) => line.includes("書ける量の測定") && line.includes("書き切った")
      )
    ).toBe(true);

    /*
      **測り終えたら台帳へ保存する**（設計書6.65.14の1）。ここは
      「参考値の報告だけ」（6.61）から、実際に繋がるところへ進んだ核心
      なので、通知の文言だけでなく台帳の中身そのものを確かめる。
    */
    const tuning = (values.modelTuning as Record<string, unknown> | undefined)?.[
      "ollama/gemma4:12b"
    ] as Record<string, unknown> | undefined;
    expect(tuning?.measuredOutputTokens).toBeGreaterThan(0);

    /*
      この場面（既定の `trueLimit=9999` で、上限8,192行＝約24,576トークン
      まで書き切る）では、まとめ送信の従来の上限（自動モードでチャンク
      いっぱいの20,000字）のほうがまだ小さいので、絞られない。
      「黙って変えない」の裏返しとして、絞らなかったこともきちんと言う。
    */
    expect(text).toContain("上限はそのまま");
    expect(text).not.toContain("まとめ送信の上限を");
  });

  test("書ける量が少ない相手では、その近くの値を報告する", async () => {
    state.trueLimit = 300;
    const values: Record<string, unknown> = {};
    installSettings(values);
    const { showInformationMessage } = answerWith("そのままにする");

    await measureContext(registry);

    const text = noticeText(showInformationMessage);
    const lines = Number(
      /（([\d,]+) 行）/.exec(text)?.[1].replace(/,/g, "") ?? "0"
    );
    // **本当の上限を超えて報告しない**（超えると、以後の抽出で応答が切れ続ける）
    expect(lines).toBeLessThanOrEqual(300);
    // 1割以内まで迫る（`OUTPUT_CONVERGENCE_RATIO`）
    expect(lines).toBeGreaterThan(300 * 0.8);
    // 「上限まで書き切った」とは言わない
    expect(text).not.toContain("これより長く書ける可能性があります");
    expect(
      log.steps.some(
        (line) => line.includes("書ける量の測定") && line.includes("行で止まった")
      )
    ).toBe(true);

    /*
      **書ける量が小さいモデルでは、まとめ送信の上限が実際に絞られる**
      （設計書6.65.14の2・3）。自動モードの従来の上限（20,000字）に対し、
      この場面の実測（300行前後 ≈ 900トークン以下）から出る上限は
      ずっと小さいので、「絞った」ことを言う一文が出るはずである。
    */
    const tuning = (values.modelTuning as Record<string, unknown> | undefined)?.[
      "ollama/gemma4:12b"
    ] as Record<string, unknown> | undefined;
    expect(tuning?.measuredOutputTokens).toBeGreaterThan(0);
    expect(tuning?.measuredOutputTokens).toBeLessThan(1000);
    expect(text).toContain("まとめ送信の上限を");
    expect(text).not.toContain("上限はそのまま");
  });

  test("時間切れは「その量は書けない」と数えて、探索を続ける", async () => {
    // 生成が遅すぎるのも、作者にとっては「その量は書けない」と同じである
    state.outputErrors = {
      1: new AIError("時間切れです。", "timeout"),
    };
    installSettings({});
    const { showInformationMessage, showErrorMessage } = answerWith("そのままにする");

    await measureContext(registry);

    // 1回目で打ち切らない
    expect(outputCalls().length).toBeGreaterThan(1);
    expect(showErrorMessage).not.toHaveBeenCalled();
    expect(noticeText(showInformationMessage)).toContain("書けたのは");
  });

  /**
   * **中止したときは、台帳へ書かない**（設計書6.65.14の1）。
   *
   * 途中までの `low` は「そこまでは確かめられた」であって「これが上限」
   * ではない。古い実測（あれば）のほうが信頼できるので、上書きしない。
   */
  test("中止したときは、台帳へ書かない（低い値でも上書きしない）", async () => {
    // 1回目は成功させて low>0 にしたあと、2回目で中止させる
    state.outputErrors = {
      2: new AIError("処理が中止されました。", "aborted"),
    };
    const values: Record<string, unknown> = {
      // 前回の実測が既にある、という場面を再現する
      modelTuning: { "ollama/gemma4:12b": { measuredOutputTokens: 12345 } },
    };
    installSettings(values);
    const { showInformationMessage } = answerWith("そのままにする");

    await measureContext(registry);

    const tuning = (values.modelTuning as Record<string, unknown>)[
      "ollama/gemma4:12b"
    ] as Record<string, unknown>;
    // 新しい値で上書きされていない。古い実測がそのまま残る
    expect(tuning.measuredOutputTokens).toBe(12345);
    // 出力側は「途中で終わった」ことを言う（新しい値を覚えたとは言わない）
    const text = noticeText(showInformationMessage);
    expect(text).toContain("書けたのは");
    expect(text).not.toContain("まとめ送信の上限を");
  });
});

describe("クラウドAIでは測らない", () => {
  test("さくらのAIでは、出力の測定を送らない", async () => {
    state.providerId = "sakura";
    state.isPaid = true;
    state.declaredContextWindow = 131072;
    installSettings({});
    const { showInformationMessage } = answerWith("そのままにする");

    await measureContext(registry);

    // 申告値がAPIから取れるうえ、出力トークンは単価が高い
    expect(outputCalls().length).toBe(0);
    const text = noticeText(showInformationMessage);
    expect(text).toContain("実効の上限");
    // **測っていないことを黙って混ぜない。** 何も言わない
    expect(text).not.toContain("書けたのは");
    expect(log.steps.some((line) => line.includes("書ける量の測定"))).toBe(false);
  });
});

describe("出力の測定が失敗しても", () => {
  test("入力の結果は捨てない", async () => {
    state.outputErrors = {
      1: new AIError("応答を解釈できません。", "bad_response", "unexpected"),
    };
    installSettings({});
    const { showInformationMessage, showErrorMessage } = answerWith("そのままにする");

    await measureContext(registry);

    // 入力側の結果は、これまでどおり出る
    const text = noticeText(showInformationMessage);
    expect(text).toContain("実効の上限");
    // 測れなかった出力の話は混ぜない
    expect(text).not.toContain("書けたのは");
    // 失敗そのもので測定を落とさない（作者には「測れた」ように見せる）
    expect(showErrorMessage).not.toHaveBeenCalled();
    // **エラーの本文は捨てない**（CLAUDE.md 規則5）
    expect(log.failures.some(([context]) => context.includes("書ける量"))).toBe(
      true
    );
  });
});
