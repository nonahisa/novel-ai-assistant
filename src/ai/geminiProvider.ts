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
import { clampToModelLimit, resolveMaxOutputTokens } from "./outputLimit";

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

  private get requestTimeoutMs(): number {
    return (
      vscode.workspace
        .getConfiguration("novelai")
        .get<number>("gemini.timeoutSeconds", 180) * 1000
    );
  }

  private async headers(): Promise<Record<string, string>> {
    const apiKey = await this.getApiKey();
    if (!apiKey) {
      throw new AIError(
        "GeminiのAPIキーが設定されていません。「AIの設定」から登録してください。",
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
        message: `Geminiに接続しました（モデル ${models.length} 件）`,
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
    const support: GeminiSupport = { ...stored };

    const maxOutputTokens = clampToModelLimit(
      resolveMaxOutputTokens(),
      this.modelCache.get(params.model)?.maxOutputTokens
    );

    for (let attempt = 0; ; attempt++) {
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

      const body = {
        systemInstruction: { parts: [{ text: params.systemPrompt }] },
        contents: [{ role: "user", parts: [{ text: params.userPrompt }] }],
        generationConfig,
      };

      try {
        const response = await this.post(
          params.model,
          body,
          headers,
          params.signal
        );
        // 通った組み合わせだけを覚える
        this.rememberSupport(params.model, support);
        return response;
      } catch (error) {
        // 400以外（認証・上限・通信）は外して直る類ではない
        if (!isInvalidArgument(error)) throw error;

        const dropped = dropNextOption(support);
        if (!dropped) throw error;
        logLine(
          `Geminiが「${dropped}」の指定を受け付けなかったため、外して再試行します（モデル: ${params.model}）。`
        );
        if (attempt >= 3) throw error;
      }
    }
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

  private rememberSupport(model: string, support: GeminiSupport): void {
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
      timeoutMs: this.requestTimeoutMs,
      signal,
      label: LABEL,
    });
  }
}

/** v2 にしているのは、失敗から学んでいた頃の誤った記録を捨てるため */
function supportKey(model: string): string {
  return `novelai.gemini.support.v2.${model}`;
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

/**
 * 次に外す指定を決める。外せるものが無ければ undefined。
 *
 * 思考の指定から先に外す。JSONスキーマは抽出の質に直結するので、
 * できるだけ最後まで残す。
 */
export function dropNextOption(support: GeminiSupport): string | undefined {
  if (support.thinkingConfig) {
    support.thinkingConfig = false;
    return "思考の無効化";
  }
  if (support.responseSchema) {
    support.responseSchema = false;
    return "JSONスキーマ";
  }
  return undefined;
}
