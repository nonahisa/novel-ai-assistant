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
} from "./types";
import { fetchJson } from "./httpClient";
import { toOpenAIJsonSchema } from "./jsonSchema";
import { resolveMaxOutputTokens } from "./outputLimit";
import { forgetSecret, logLine, registerSecret } from "../core/logger";
import { isChatModel, isUnsupportedParameter } from "./openaiProvider";

/**
 * さくらのAI Engine アダプタ。
 *
 * **APIはOpenAI互換**（`/v1/chat/completions`、`Authorization: Bearer`）。
 * CIの疎通確認（`scripts/sakuraAiSmoke.mjs`）で使っている口と同じなので、
 * ChatGPTのアダプタとほぼ同じ形で作れる。
 *
 * **ただし「OpenAIと同じはず」と決めつけない。**
 * `response_format` を受けるかは確かめていないので、断られたら外して
 * 出し直す。この作品でクラウドAIに繰り返し起きてきたことである。
 *
 * **国内のサービスなので、原稿の送り先が国内で完結する。**
 * Ollamaほどではないが、海外のクラウドへ送るより作者の抵抗は小さい。
 */

const SECRET_KEY = "novelai.sakura.apiKey";
const DEFAULT_ENDPOINT = "https://api.ai.sakura.ad.jp/v1";
const LABEL = "さくらのAI Engine";

interface ModelListResponse {
  data?: Array<{ id?: string; owned_by?: string }>;
}

interface ChatResponse {
  choices?: Array<{
    message?: { content?: string | null };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    /**
     * プロンプトキャッシュの内訳（OpenAI互換の形）。
     *
     * **さくらが実際にこれを返すかは未確認である**（2026-08-27）。
     * 返さなければ undefined のままになるだけで、記録の欄が空くほかに
     * 害はない。返し始めたときに、こちらを直さなくても数字が出る。
     */
    prompt_tokens_details?: { cached_tokens?: number };
  };
}

export class SakuraProvider implements ApiKeyProvider {
  readonly id = "sakura" as const;
  readonly displayName = "さくらのAI（クラウド・無料枠あり）";

  /**
   * **無料枠はあるが、有料として扱う**（2026-08-23、作者の確認）。
   *
   * **超えれば課金される。** 少なく見積もって黙って使わせるより、
   * 実行前に一言出すほうがよい。Geminiも同じ扱いにしてある
   * （あちらにも無料枠がある）。
   *
   * この印は「実行前に処理量を示すか」と「独り言を出さないか」の
   * 判断に使われる。**枠の中かどうかは、こちらからは分からない**
   * ——APIは残りを教えてくれないので、常に断ってから使う。
   *
   * 無料枠があること自体は、AIを選ぶ画面の説明に書いてある。
   */
  readonly isPaid = true;

  readonly apiKeyHelp: ApiKeyHelp = {
    title: "さくらのAI EngineのAPIキーを入力してください",
    prompt:
      "さくらのクラウドのコントロールパネルで発行できます。" +
      "入力内容は資格情報ストアに保存され、settings.jsonには書き込まれません。",
    placeHolder: "APIキーを貼り付けてください",
    // **形は決め打ちしない。** さくらの鍵の形を確かめていないので、
    // 空でないことだけを見る。決め打ちすると、正しい鍵が入らなくなる
    validate: (value) =>
      value.trim().length === 0 ? "APIキーが空です。" : undefined,
  };

  private modelCache = new Map<string, ModelInfo>();

  constructor(private readonly context: vscode.ExtensionContext) {}

  async getApiKey(): Promise<string | undefined> {
    const key = await this.context.secrets.get(SECRET_KEY);
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
      .get<string>("sakura.endpoint", DEFAULT_ENDPOINT)
      .replace(/\/+$/, "");
  }

  private get requestTimeoutMs(): number {
    return (
      vscode.workspace
        .getConfiguration("novelai")
        .get<number>("sakura.timeoutSeconds", 180) * 1000
    );
  }

  /**
   * コンテキスト長。
   *
   * **モデル一覧APIはコンテキスト長を返さない。** モデルごとの表を持つと
   * 新しいモデルが出るたびに古くなるので、設定値を使う。
   * チャンク分割の基準になるため、実際より大きいと入力が黙って切り捨てられる。
   */
  private get contextWindow(): number {
    const configured = vscode.workspace
      .getConfiguration("novelai")
      .get<number>("sakura.contextWindow", 32000);
    return configured >= 1024 ? configured : 32000;
  }

  private async headers(): Promise<Record<string, string>> {
    const apiKey = await this.getApiKey();
    if (!apiKey) {
      throw new AIError(
        "さくらのAI EngineのAPIキーが設定されていません。「AI設定」から登録してください。",
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
          "さくらのAI EngineのAPIキーが未設定です。" +
          "さくらのクラウドのコントロールパネルで発行したキーを登録してください。",
      };
    }
    try {
      const models = await this.listModels();
      if (models.length === 0) {
        return {
          ok: true,
          message:
            "さくらのAI Engineに接続できましたが、利用できるモデルが見つかりません。契約内容を確認してください。",
          modelCount: 0,
        };
      }
      return {
        ok: true,
        message: `さくらのAI Engineに接続しました（モデル ${models.length} 件）`,
        modelCount: models.length,
      };
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /** `/v1/models` の生応答を、この起動で一度だけ記録したか */
  private loggedRawModels = false;

  async listModels(): Promise<ModelInfo[]> {
    const response = await fetchJson<ModelListResponse>({
      url: `${this.endpoint}/models`,
      headers: await this.headers(),
      timeoutMs: 15000,
      label: LABEL,
    });

    // **生の応答を一度だけ記録する**（コンテキスト長の実測、2026-08-27）。
    // OpenAI互換の /models に「モデルの受け取れる長さ」の拡張欄があるかは
    // 公表情報だけでは分からない。あれば LM Studio（0.23.1）と同じ形の
    // 自動読取に切り替え、無ければ設定値のままでよい——その判断材料。
    // 応答はモデルの一覧情報だけで、鍵や原稿は含まれない
    if (!this.loggedRawModels) {
      this.loggedRawModels = true;
      logLine(
        `さくらのAI: /v1/models の生応答（実測用）: ` +
          JSON.stringify(response).slice(0, 4000)
      );
    }

    const infos: ModelInfo[] = [];
    for (const entry of response.data ?? []) {
      const id = entry.id;
      if (!id || !isChatModel(id)) continue;
      infos.push(this.describe(id));
    }
    infos.sort((a, b) => a.id.localeCompare(b.id));
    return infos;
  }

  async getModel(id: string): Promise<ModelInfo | undefined> {
    const cached = this.modelCache.get(id);
    if (cached) return { ...cached, contextWindow: this.contextWindow };
    // 一覧に出ないモデルでも、作者が明示的に選んでいれば使えるようにする
    return this.describe(id);
  }

  private describe(id: string): ModelInfo {
    const parameterSize = parseParameterSize(id);
    const info: ModelInfo = {
      id,
      displayName: id,
      contextWindow: this.contextWindow,
      parameterSize,
      capabilities: ["JSON強制"],
      // **「クラウドだから最上位」と決めつけない**（後述の理由）
      tier: inferTier(parameterSize, "ollama"),
    };
    this.modelCache.set(id, info);
    return info;
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
      max_tokens: resolveMaxOutputTokens(),
      stream: false,
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

    // **断られた指定だけを外して出し直す。**
    // どれが駄目かをエラー文から当てにいかず、1つずつ外して試す
    // （GeminiでもAnthropicでも同じ手を使っている）
    let response: ChatResponse | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        response = await this.post(body, headers, params.signal);
        break;
      } catch (error) {
        if (
          body.response_format !== undefined &&
          isUnsupportedParameter(error, "response_format")
        ) {
          // **形式の強制が効かないだけで、応答は使える。**
          // 各機能のパーサはコードフェンス付きの応答も読めるようにしてある
          delete body.response_format;
          logLine(
            "さくらのAI Engine：JSON形式の強制が受け付けられなかったため、外して再試行します。"
          );
          continue;
        }
        if (
          body.temperature !== undefined &&
          isUnsupportedParameter(error, "temperature")
        ) {
          delete body.temperature;
          continue;
        }
        throw error;
      }
    }
    if (!response) {
      throw new AIError(
        "さくらのAI Engineへの要求が受け付けられませんでした。",
        "bad_response"
      );
    }

    const choice = response.choices?.[0];
    if (!choice) {
      throw new AIError(
        "さくらのAI Engineから形式が不正な応答が返りました。",
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
        // 返ってこなければ undefined のまま（`?? 0` にしない）。
        // 0にすると「対応しているが効かなかった」と読めてしまう
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
 * モデル名からパラメータ数を読む。
 *
 * さくらが出しているのは**公開重みのモデル**（`preview/gemma-4-31B-it` など）で、
 * 名前に大きさが入っている。ClaudeやChatGPTのように中身が非公開のモデルとは
 * 事情が違うので、**「クラウドだから最上位」と決めつけずに実際の大きさで測る。**
 *
 * ここを最上位にしてしまうと、31Bのモデルへ 70B級を想定した長さの
 * プロンプトとチャンクが渡る。**手元の12Bで駄目だった仕事を投げることになる。**
 */
export function parseParameterSize(modelId: string): string | null {
  const match = modelId.match(/(\d+(?:\.\d+)?)\s*([BM])\b/i);
  if (!match) return null;
  return `${match[1]}${match[2].toUpperCase()}`;
}
