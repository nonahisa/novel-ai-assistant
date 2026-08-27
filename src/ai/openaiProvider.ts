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
import { toOpenAIJsonSchema } from "./jsonSchema";
import { resolveMaxOutputTokens } from "./outputLimit";
import { forgetSecret, registerSecret } from "../core/logger";

/** APIキーの保存先。settings.json ではなくOSの資格情報ストア */
const SECRET_KEY = "novelai.openai.apiKey";
const DEFAULT_ENDPOINT = "https://api.openai.com/v1";
const LABEL = "ChatGPT";

/**
 * 会話に使えないモデルを一覧から外すための語。
 *
 * モデル名そのものではなく**用途を表す語**で判定する。
 * 「gpt-4o」のような個別の名前で許可リストを作ると、
 * 新しいモデルが出るたびに一覧へ現れなくなるため。
 * 判断が付かないものは残す（取りこぼしのほうが害が大きい）。
 */
const NON_CHAT_HINTS = [
  "embedding",
  "tts",
  "whisper",
  "audio",
  "transcribe",
  "realtime",
  "dall-e",
  "image",
  "moderation",
  "sora",
  "codex",
];

interface ModelListResponse {
  data?: Array<{ id?: string; owned_by?: string }>;
}

interface ChatResponse {
  choices?: Array<{
    message?: { content?: string | null; refusal?: string | null };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    /**
     * プロンプトキャッシュの内訳。**OpenAIは自動でキャッシュする**ので、
     * こちらから何かを送る必要はなく、返ってきた数を読むだけでよい。
     * 古いモデル・古い口では返らないことがあるので省略可能にしてある。
     */
    prompt_tokens_details?: { cached_tokens?: number };
  };
}

/**
 * ChatGPT（OpenAI API）アダプタ。
 *
 * Ollamaと違いクラウド実行なので**呼ぶたびに課金される**。
 * 自動フォールバックはせず、使うかどうかは常に作者が明示的に選ぶ。
 */
export class OpenAIProvider implements ApiKeyProvider {
  readonly id = "openai" as const;
  readonly displayName = "ChatGPT（クラウド・有料）";
  readonly isPaid = true;

  readonly apiKeyHelp: ApiKeyHelp = {
    title: "ChatGPTのAPIキーを入力してください",
    prompt:
      "platform.openai.com の API keys で発行できます。入力内容は資格情報ストアに保存され、settings.jsonには書き込まれません。",
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
    // キーが変わればアカウントも変わりうるので、モデル情報を捨てる
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
      .get<string>("openai.endpoint", DEFAULT_ENDPOINT)
      .replace(/\/+$/, "");
  }

  private get requestTimeoutMs(): number {
    return (
      vscode.workspace
        .getConfiguration("novelai")
        .get<number>("openai.timeoutSeconds", 180) * 1000
    );
  }

  /**
   * コンテキスト長。
   *
   * OpenAIのモデル一覧APIはコンテキスト長を返さない。
   * モデルごとの表を持つと新モデルが出るたびに古くなるため、
   * 設定値を使う。チャンク分割の基準になるので、
   * 実際より大きいと入力が黙って切り捨てられる。
   */
  private get contextWindow(): number {
    const configured = vscode.workspace
      .getConfiguration("novelai")
      .get<number>("openai.contextWindow", 128000);
    return configured >= 1024 ? configured : 128000;
  }

  private async headers(): Promise<Record<string, string>> {
    const apiKey = await this.getApiKey();
    if (!apiKey) {
      throw new AIError(
        "ChatGPTのAPIキーが設定されていません。「AI設定」から登録してください。",
        "authentication_failed"
      );
    }
    return { Authorization: `Bearer ${apiKey}` };
  }

  async isConfigured(): Promise<boolean> {
    return (await this.getApiKey()) !== undefined;
  }

  async testConnection(): Promise<ConnectionTestResult> {
    if (!(await this.getApiKey())) {
      return {
        ok: false,
        message:
          "ChatGPTのAPIキーが未設定です。platform.openai.com で発行したキーを登録してください。",
      };
    }
    try {
      const models = await this.listModels();
      if (models.length === 0) {
        return {
          ok: true,
          message:
            "ChatGPTに接続できましたが、利用できるモデルが見つかりません。アカウントの利用権限を確認してください。",
          modelCount: 0,
        };
      }
      return {
        ok: true,
        message: `ChatGPTに接続しました（モデル ${models.length} 件）`,
        modelCount: models.length,
      };
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    const response = await fetchJson<ModelListResponse>({
      url: `${this.endpoint}/models`,
      headers: await this.headers(),
      timeoutMs: 15000,
      label: LABEL,
    });

    const infos: ModelInfo[] = [];
    for (const entry of response.data ?? []) {
      const id = entry.id;
      if (!id || !isChatModel(id)) continue;
      const info: ModelInfo = {
        id,
        displayName: id,
        contextWindow: this.contextWindow,
        // クラウドモデルはパラメータ数を公開していない
        parameterSize: null,
        capabilities: ["JSON強制"],
        tier: inferTier(null, "openai"),
      };
      this.modelCache.set(id, info);
      infos.push(info);
    }
    infos.sort((a, b) => a.id.localeCompare(b.id));
    return infos;
  }

  async getModel(id: string): Promise<ModelInfo | undefined> {
    const cached = this.modelCache.get(id);
    if (cached) {
      // 設定でコンテキスト長を変えた場合に古い値を返さない
      return { ...cached, contextWindow: this.contextWindow };
    }
    // 一覧に出ないモデルでも作者が明示的に選んでいれば使えるようにする
    return {
      id,
      displayName: id,
      contextWindow: this.contextWindow,
      parameterSize: null,
      capabilities: [],
      tier: inferTier(null, "openai"),
    };
  }

  async generate(params: GenerateParams): Promise<GenerateResult> {
    const started = Date.now();
    const headers = await this.headers();

    const body: Record<string, unknown> = {
      model: params.model,
      messages: [
        { role: "system", content: params.systemPrompt },
        { role: "user", content: params.userPrompt },
      ],
      temperature: params.temperature,
      // 新しいモデルは max_tokens を受け付けず、こちらの名前を要求する
      max_completion_tokens: resolveMaxOutputTokens(),
    };

    if (params.jsonSchema) {
      body.response_format = {
        type: "json_schema",
        json_schema: {
          name: "novelai_result",
          strict: true,
          schema: toOpenAIJsonSchema(params.jsonSchema),
        },
      };
    }

    // 拒否された指定だけを外して1回やり直す（プロバイダの切替はしない）。
    // どれが拒否されたかはエラー本文に項目名が入るので、それを見て外す。
    let response: ChatResponse | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        response = await this.post(body, headers, params.signal);
        break;
      } catch (error) {
        // 推論系モデルは temperature の指定自体を拒否する
        if (body.temperature !== undefined &&
            isUnsupportedParameter(error, "temperature")) {
          delete body.temperature;
          continue;
        }
        // 古いモデルは max_completion_tokens を知らず max_tokens を要求する
        if (
          body.max_completion_tokens !== undefined &&
          isUnsupportedParameter(error, "max_completion_tokens")
        ) {
          body.max_tokens = body.max_completion_tokens;
          delete body.max_completion_tokens;
          continue;
        }
        throw error;
      }
    }
    if (!response) {
      throw new AIError(
        "ChatGPTへの要求が受け付けられませんでした。",
        "bad_response"
      );
    }

    const choice = response.choices?.[0];
    if (!choice) {
      throw new AIError(
        "ChatGPTから形式が不正な応答が返りました。",
        "bad_response"
      );
    }

    if (choice.message?.refusal) {
      throw new AIError(
        `AIが安全上の理由でこの内容の処理を拒否しました。（${choice.message.refusal}）`,
        "bad_response"
      );
    }

    const text = choice.message?.content ?? "";
    if (!text.trim()) {
      throw new AIError(
        "AIから空の応答が返りました。",
        "bad_response",
        `finish_reason=${choice.finish_reason ?? "unknown"}`
      );
    }

    return {
      text,
      usage: {
        inputTokens: response.usage?.prompt_tokens ?? 0,
        outputTokens: response.usage?.completion_tokens ?? 0,
        // **`?? 0` にしない。** 返ってこなかった回は undefined のままにして、
        // 「数えられない」と「数えて0だった」を分ける（types.ts の説明のとおり）
        cachedInputTokens: response.usage?.prompt_tokens_details?.cached_tokens,
      },
      truncated: choice.finish_reason === "length",
      elapsedMs: Date.now() - started,
    };
  }

  private async post(
    body: Record<string, unknown>,
    headers: Record<string, string>,
    signal: AbortSignal | undefined
  ): Promise<ChatResponse> {
    return fetchJson<ChatResponse>({
      url: `${this.endpoint}/chat/completions`,
      method: "POST",
      headers,
      body,
      timeoutMs: this.requestTimeoutMs,
      signal,
      label: LABEL,
    });
  }
}

/**
 * 会話に使えるモデルか。
 * 判断が付かないものは true（新しいモデルを隠さないため）。
 */
export function isChatModel(id: string): boolean {
  const lower = id.toLowerCase();
  return !NON_CHAT_HINTS.some((hint) => lower.includes(hint));
}

/** そのパラメータが未対応だと言われたか */
export function isUnsupportedParameter(
  error: unknown,
  parameter: string
): boolean {
  if (!(error instanceof AIError)) return false;
  if (error.kind !== "bad_response") return false;
  const detail = error.detail ?? "";
  return (
    detail.includes(parameter) &&
    /unsupported|not supported|does not support/i.test(detail)
  );
}
