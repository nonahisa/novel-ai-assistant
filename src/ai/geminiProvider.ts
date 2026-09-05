import * as vscode from "vscode";
import {
  AIError,
  ApiKeyHelp,
  ApiKeyProvider,
  ConnectionTestResult,
  GenerateParams,
  GenerateResult,
  ModelInfo,
  inferTier,
  validateApiKeyFormat,
} from "./types";
import { fetchJson } from "./httpClient";
import { toGeminiSchema } from "./jsonSchema";
import { forgetSecret, logLine, registerSecret } from "../core/logger";
import { resolveTimeoutMs } from "../core/modelTuning";
import { customEndpointNotice } from "../core/endpointNotice";
import { clampToModelLimit, resolveMaxOutputTokens } from "./outputLimit";
import { buildAttemptPlan, type OptionAttempt } from "./optionFallback";

const SECRET_KEY = "novelai.gemini.apiKey";
const DEFAULT_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta";
const LABEL = "Gemini";

/** 応答が途中で終わった理由のうち、作者に説明が要るもの */
const BLOCKED_FINISH_REASONS: Record<string, string> = {
  SAFETY: "安全性の判定により応答が止められました。",
  PROHIBITED_CONTENT: "禁止されている内容と判定されました。",
  RECITATION: "既存の著作物の引用と判定され、応答が止められました。",
  BLOCKLIST: "禁止語の判定により応答が止められました。",
  SPII: "個人情報を含むと判定され、応答が止められました。",
};

interface ModelListResponse {
  models?: Array<{
    name?: string;
    displayName?: string;
    inputTokenLimit?: number;
    outputTokenLimit?: number;
    supportedGenerationMethods?: string[];
  }>;
  nextPageToken?: string;
}

interface GenerateContentResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    finishReason?: string;
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    /**
     * 入力のうち、キャッシュから読めた分。
     *
     * **Geminiは条件を満たすと自動でキャッシュする**（明示の指定は要らない）。
     * 効かなかった回や対応していないモデルでは項目ごと返らないので、
     * 省略可能にしてある。
     */
    cachedContentTokenCount?: number;
  };
  promptFeedback?: { blockReason?: string };
}

/**
 * Gemini（Google AI Studio API）アダプタ。
 *
 * Ollamaと違いクラウド実行で、無料枠を超えると課金される。
 * 自動フォールバックはせず、使うかどうかは常に作者が明示的に選ぶ。
 */
export class GeminiProvider implements ApiKeyProvider {
  readonly id = "gemini" as const;
  readonly displayName = "Gemini（クラウド・無料枠あり）";
  readonly isPaid = true;

  readonly apiKeyHelp: ApiKeyHelp = {
    title: "GeminiのAPIキーを入力してください",
    prompt:
      "aistudio.google.com の「Get API key」で発行できます。入力内容は資格情報ストアに保存され、settings.jsonには書き込まれません。",
    placeHolder: "APIキーを貼り付けてください",
    validate: validateApiKeyFormat,
  };

  private modelCache = new Map<string, ModelInfo>();

  constructor(private readonly context: vscode.ExtensionContext) {}

  async getApiKey(): Promise<string | undefined> {
    const key = await this.context.secrets.get(SECRET_KEY);
    // 万一ログへ流れても伏せ字になるようにする
    registerSecret(key);
    return key;
  }

  async setApiKey(key: string): Promise<void> {
    await this.context.secrets.store(SECRET_KEY, key.trim());
    registerSecret(key);
    this.modelCache.clear();
  }

  async clearApiKey(): Promise<void> {
    forgetSecret(await this.context.secrets.get(SECRET_KEY));
    await this.context.secrets.delete(SECRET_KEY);
    this.modelCache.clear();
  }

  private get endpoint(): string {
    return vscode.workspace
      .getConfiguration("novelai")
      .get<string>("gemini.endpoint", DEFAULT_ENDPOINT)
      .replace(/\/+$/, "");
  }

  /**
   * 1回の呼び出しで待つミリ秒。台帳（AIチューニング）→ 設定 → 既定 の順。
   *
   * **上限のほうは台帳を見ない。** Geminiはモデル一覧が
   * `inputTokenLimit` を返すので、測った値で上書きすると
   * 「取れている正しい値」を潰すことになる（設計書6.49）。
   */
  private requestTimeoutMs(model: string): number {
    return resolveTimeoutMs(this.id, model, 180);
  }

  private async headers(): Promise<Record<string, string>> {
    const apiKey = await this.getApiKey();
    if (!apiKey) {
      throw new AIError(
        "GeminiのAPIキーが設定されていません。「AI設定」から登録してください。",
        "authentication_failed"
      );
    }
    // URLのクエリに載せるとログや履歴へ残りやすいのでヘッダーで送る
    return { "x-goog-api-key": apiKey };
  }

  async isConfigured(): Promise<boolean> {
    return (await this.getApiKey()) !== undefined;
  }

  async testConnection(): Promise<ConnectionTestResult> {
    if (!(await this.getApiKey())) {
      return {
        ok: false,
        message:
          "GeminiのAPIキーが未設定です。aistudio.google.com で発行したキーを登録してください。",
      };
    }
    try {
      const models = await this.listModels();
      if (models.length === 0) {
        return {
          ok: true,
          message:
            "Geminiに接続できましたが、文章生成に使えるモデルが見つかりません。",
          modelCount: 0,
        };
      }
      return {
        ok: true,
        message:
          `Geminiに接続しました（モデル ${models.length} 件）` +
          customEndpointNotice(this.endpoint, DEFAULT_ENDPOINT),
        modelCount: models.length,
      };
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * 利用可能なモデルをAPIから取得する。
   * Geminiはコンテキスト長（inputTokenLimit）も返すので、設定に頼らずに済む。
   */
  async listModels(): Promise<ModelInfo[]> {
    const headers = await this.headers();
    const infos: ModelInfo[] = [];
    let pageToken: string | undefined;

    // ページ送りが壊れて無限に回らないよう上限を設ける
    for (let page = 0; page < 10; page++) {
      const query = new URLSearchParams({ pageSize: "200" });
      if (pageToken) query.set("pageToken", pageToken);

      const response = await fetchJson<ModelListResponse>({
        url: `${this.endpoint}/models?${query.toString()}`,
        headers,
        timeoutMs: 15000,
        label: LABEL,
      });

      for (const entry of response.models ?? []) {
        if (!entry.name) continue;
        // 埋め込み専用モデルなどを除く
        if (!entry.supportedGenerationMethods?.includes("generateContent")) {
          continue;
        }
        const id = entry.name.replace(/^models\//, "");
        const info: ModelInfo = {
          id,
          displayName: entry.displayName ?? id,
          contextWindow: entry.inputTokenLimit ?? 32768,
          parameterSize: null,
          capabilities: ["JSON強制"],
          tier: inferTier(null, "gemini"),
          maxOutputTokens: entry.outputTokenLimit,
        };
        this.modelCache.set(id, info);
        infos.push(info);
      }

      pageToken = response.nextPageToken;
      if (!pageToken) break;
    }

    infos.sort((a, b) => a.id.localeCompare(b.id));
    return infos;
  }

  async getModel(id: string): Promise<ModelInfo | undefined> {
    const cached = this.modelCache.get(id);
    if (cached) return cached;
    try {
      await this.listModels();
    } catch {
      return undefined;
    }
    return this.modelCache.get(id);
  }

  async generate(params: GenerateParams): Promise<GenerateResult> {
    const started = Date.now();
    const headers = await this.headers();
    const response = await this.generateWithFallback(params, headers);

    // 入力そのものが弾かれた場合、candidates が空で返る
    const blockReason = response.promptFeedback?.blockReason;
    if (blockReason) {
      throw new AIError(
        `AIが入力を受け付けませんでした（${blockReason}）。`,
        "bad_response"
      );
    }

    const candidate = response.candidates?.[0];
    if (!candidate) {
      throw new AIError(
        "Geminiから形式が不正な応答が返りました。",
        "bad_response"
      );
    }

    const blocked =
      candidate.finishReason && BLOCKED_FINISH_REASONS[candidate.finishReason];
    if (blocked) {
      throw new AIError(blocked, "bad_response", candidate.finishReason);
    }

    const text = (candidate.content?.parts ?? [])
      .map((part) => part.text ?? "")
      .join("");

    if (!text.trim()) {
      throw new AIError(
        "AIから空の応答が返りました。",
        "bad_response",
        `finishReason=${candidate.finishReason ?? "unknown"}`
      );
    }

    return {
      text,
      usage: {
        inputTokens: response.usageMetadata?.promptTokenCount ?? 0,
        outputTokens: response.usageMetadata?.candidatesTokenCount ?? 0,
        // 返ってこなければ undefined のまま（`?? 0` にしない）。
        // 0にすると「対応しているが効かなかった」と読めてしまう
        cachedInputTokens: response.usageMetadata?.cachedContentTokenCount,
      },
      truncated: candidate.finishReason === "MAX_TOKENS",
      elapsedMs: Date.now() - started,
    };
  }

  /**
   * 対応していない指定を外しながら送る。
   *
   * Geminiは受け付けられない指定があっても
   * 「Request contains an invalid argument.」としか返さず、
   * **どの項目が悪いのかを教えてくれない。**
   * そのためエラー文から原因を当てにいくのではなく、
   * 任意の指定を1つずつ外して試す。
   *
   * 何が通ったかはモデルごとに覚えておき、次回から最初から外す。
   * 覚えないと毎回むだな呼び出しが増え、無料枠をすぐ使い切ってしまう。
   */
  private async generateWithFallback(
    params: GenerateParams,
    headers: Record<string, string>
  ): Promise<GenerateContentResponse> {
    // 外す判断は複製に対して行い、通ったときだけ記憶する。
    // 失敗しただけで書き換えると、原因が別だったときに
    // 対応している機能まで永久に使わなくなる（Claudeで実際に起きた）
    const stored = this.supportFor(params.model);

    // **呼び出し側の見込みを尊重する**（設計書6.77の第2段）。渡されない
    // 呼び出しはこれまでどおり設定値。丸め（モデルの申告上限）は最後に掛ける
    const maxOutputTokens = clampToModelLimit(
      params.maxOutputTokens ?? resolveMaxOutputTokens(),
      this.modelCache.get(params.model)?.maxOutputTokens
    );

    // この呼び出しで実際に送る指定だけを、外す候補にする。
    // 送ってもいない指定を「非対応」と覚えると、次に必要になったとき失う
    const applicable: GeminiOptionKey[] = [];
    if (params.disableThinking) applicable.push("thinkingConfig");
    if (params.jsonSchema) applicable.push("responseSchema");

    const buildBody = (support: GeminiSupport) => {
      const generationConfig: Record<string, unknown> = {
        temperature: params.temperature,
        maxOutputTokens,
      };
      if (params.jsonSchema && support.responseSchema) {
        generationConfig.responseMimeType = "application/json";
        generationConfig.responseSchema = toGeminiSchema(params.jsonSchema);
      } else if (params.jsonSchema) {
        // スキーマは無理でも、JSONで返させるところまでは効くことがある
        generationConfig.responseMimeType = "application/json";
      }
      if (params.disableThinking && support.thinkingConfig) {
        generationConfig.thinkingConfig = { thinkingBudget: 0 };
      }
      return {
        systemInstruction: { parts: [{ text: params.systemPrompt }] },
        contents: [{ role: "user", parts: [{ text: params.userPrompt }] }],
        generationConfig,
      };
    };

    let lastError: unknown;

    for (const attempt of geminiAttemptPlan(stored, applicable)) {
      try {
        const response = await this.post(
          params.model,
          buildBody(attempt.support),
          headers,
          params.signal
        );
        // 通った組み合わせだけを覚える
        this.rememberSupport(params.model, attempt.support);
        if (attempt.dropped.length > 0) {
          logLine(
            `Geminiは「${describeDroppedGeminiOptions(attempt.dropped)}」を外すと通りました` +
              `（モデル: ${params.model}）。以後この組み合わせで呼び出します。`
          );
        }
        return response;
      } catch (error) {
        // 400以外（認証・上限・通信）は外して直る類ではない
        if (!isInvalidArgument(error)) throw error;
        lastError = error;
        // **何を外したときに何と言われたのかを残す。**
        // Geminiの本文は「invalid argument」だけのことが多いが、
        // 別の理由（スキーマの作りなど）を書いてくることもある
        logLine(
          `Geminiが要求を受け付けませんでした（モデル: ${params.model} / ` +
            `外した指定: ${describeDroppedGeminiOptions(attempt.dropped)}）。` +
            `応答: ${
              error instanceof AIError ? error.detail ?? "（本文なし）" : "（本文なし）"
            }`
        );
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new AIError("Geminiが要求を受け付けませんでした。", "bad_response");
  }

  /**
   * モデルごとの対応状況。分からないうちは対応している前提で始める。
   *
   * **VS Codeを閉じても覚えておく。** 覚えないと再起動のたびに
   * 必ず1回は400で弾かれる呼び出しが発生し、
   * 毎分5回しかない無料枠を1つ無駄にする。
   */
  private supportFor(model: string): GeminiSupport {
    const cached = this.supportCache.get(model);
    if (cached) return cached;

    const stored = this.context.globalState.get<GeminiSupport>(
      supportKey(model)
    );
    const support: GeminiSupport = {
      thinkingConfig: stored?.thinkingConfig ?? true,
      responseSchema: stored?.responseSchema ?? true,
    };
    this.supportCache.set(model, support);
    return support;
  }

  /**
   * 通った組み合わせを覚える。
   *
   * **記憶と手元の控えの両方を書き換える。** 保存先だけを更新していたため、
   * 同じ実行の次のチャンクでまた同じ指定を送り、毎チャンク400を1回もらってから
   * 通るという動きになっていた（実データのログで確認）。
   * 無料枠は毎分の呼び出し回数が少なく、この1回が上限を早める。
   */
  private rememberSupport(model: string, support: GeminiSupport): void {
    this.supportCache.set(model, { ...support });
    void this.context.globalState.update(supportKey(model), { ...support });
  }

  private readonly supportCache = new Map<string, GeminiSupport>();

  private async post(
    model: string,
    body: Record<string, unknown>,
    headers: Record<string, string>,
    signal: AbortSignal | undefined
  ): Promise<GenerateContentResponse> {
    return fetchJson<GenerateContentResponse>({
      url: `${this.endpoint}/models/${encodeURIComponent(
        model
      )}:generateContent`,
      method: "POST",
      headers,
      body,
      timeoutMs: this.requestTimeoutMs(model),
      signal,
      label: LABEL,
    });
  }
}

/**
 * v2 にしたのは、失敗から学んでいた頃の誤った記録を捨てるため。
 *
 * v3 にしたのは、積み上げ式に外していた頃の記録を捨てるため。
 * 原因がJSONスキーマ1つでも、先に外した思考の無効化まで
 * 「非対応」として記録されていた可能性がある。
 */
function supportKey(model: string): string {
  return `novelai.gemini.support.v3.${model}`;
}

/** モデルごとに、任意の指定が使えるか */
export interface GeminiSupport {
  thinkingConfig: boolean;
  responseSchema: boolean;
}

/**
 * 引数が不正だと言われたか。
 *
 * Geminiは項目名を教えてくれないので、`thinking` のような
 * 語がエラー文に含まれることを当てにしてはいけない。
 * 実際、思考の指定を拒否されたときも本文は
 * 「Request contains an invalid argument.」だけだった。
 */
export function isInvalidArgument(error: unknown): boolean {
  if (!(error instanceof AIError)) return false;
  if (error.kind !== "bad_response") return false;
  const detail = error.detail ?? "";
  return (
    detail.includes("INVALID_ARGUMENT") ||
    /invalid argument/i.test(detail) ||
    /HTTP 400/.test(error.message)
  );
}

export type GeminiOptionKey = keyof GeminiSupport;

/**
 * 外す順。思考の指定から先に外す。
 * JSONスキーマは抽出の質に直結するので、できるだけ最後まで残す。
 */
export const GEMINI_OPTION_ORDER: GeminiOptionKey[] = [
  "thinkingConfig",
  "responseSchema",
];

export const GEMINI_OPTION_LABELS: Record<GeminiOptionKey, string> = {
  thinkingConfig: "思考の無効化",
  responseSchema: "JSONスキーマ",
};

/**
 * 試す組み合わせを順に並べる。
 * 並べ方は Claude と共通（`optionFallback.ts`）。外す順だけこちらで決める。
 */
export function geminiAttemptPlan(
  support: GeminiSupport,
  applicable: GeminiOptionKey[]
): Array<OptionAttempt<GeminiOptionKey>> {
  return buildAttemptPlan(
    support,
    GEMINI_OPTION_ORDER.filter((key) => applicable.includes(key))
  );
}

export function describeDroppedGeminiOptions(
  dropped: GeminiOptionKey[]
): string {
  if (dropped.length === 0) return "なし（すべて付けたまま）";
  return dropped.map((key) => GEMINI_OPTION_LABELS[key]).join("・");
}
