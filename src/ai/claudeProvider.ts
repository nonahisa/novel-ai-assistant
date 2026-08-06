import * as vscode from "vscode";
import Anthropic from "@anthropic-ai/sdk";
import {
  AIError,
  AIProvider,
  ConnectionTestResult,
  GenerateParams,
  GenerateResult,
  ModelInfo,
  inferTier,
} from "./types";

/** APIキーの保存先。設定ファイルではなくOSの資格情報ストアに置く */
const SECRET_KEY = "novelai.claude.apiKey";

/**
 * Claude（Anthropic API）アダプタ。
 *
 * Ollamaと違いクラウド実行なので**呼ぶたびに課金される**。
 * 設計方針どおり自動フォールバックはせず、
 * 使うかどうかは常に作者が明示的に選ぶ。
 */
export class ClaudeProvider implements AIProvider {
  readonly id = "claude" as const;
  readonly displayName = "Claude（クラウド・有料）";

  /** モデル情報のキャッシュ。listModels は毎回叩くと遅い */
  private modelCache = new Map<string, ModelInfo>();

  constructor(private readonly context: vscode.ExtensionContext) {}

  async getApiKey(): Promise<string | undefined> {
    return this.context.secrets.get(SECRET_KEY);
  }

  async setApiKey(key: string): Promise<void> {
    await this.context.secrets.store(SECRET_KEY, key.trim());
    // キーが変わればアカウントも変わりうるので、モデル情報を捨てる
    this.modelCache.clear();
  }

  async clearApiKey(): Promise<void> {
    await this.context.secrets.delete(SECRET_KEY);
    this.modelCache.clear();
  }

  private async client(): Promise<Anthropic> {
    const apiKey = await this.getApiKey();
    if (!apiKey) {
      throw new AIError(
        "ClaudeのAPIキーが設定されていません。「AIの設定」から登録してください。",
        "not_running"
      );
    }
    return new Anthropic({
      apiKey,
      // 課金を伴うため、SDKの暗黙リトライは行わない。thinking拒否だけ generate 内で1回再試行する。
      maxRetries: 0,
      timeout: this.requestTimeoutMs,
    });
  }

  private get requestTimeoutMs(): number {
    // SDKはミリ秒指定
    return (
      vscode.workspace
        .getConfiguration("novelai")
        .get<number>("claude.timeoutSeconds", 180) * 1000
    );
  }

  async isConfigured(): Promise<boolean> {
    return (await this.getApiKey()) !== undefined;
  }

  async testConnection(): Promise<ConnectionTestResult> {
    if (!(await this.getApiKey())) {
      return {
        ok: false,
        message:
          "ClaudeのAPIキーが未設定です。console.anthropic.com で発行したキーを登録してください。",
      };
    }
    try {
      const models = await this.listModels();
      return {
        ok: true,
        message: `Claudeに接続しました（モデル ${models.length} 件）`,
        modelCount: models.length,
      };
    } catch (e) {
      return { ok: false, message: describeError(e) };
    }
  }

  /**
   * 利用可能なモデルをAPIから取得する。
   * モデル名・コンテキスト長はハードコードしない（新モデルが次々出るため）。
   */
  async listModels(): Promise<ModelInfo[]> {
    const client = await this.client();
    const infos: ModelInfo[] = [];
    try {
      for await (const m of client.models.list()) {
        const info: ModelInfo = {
          id: m.id,
          displayName: m.display_name,
          contextWindow: m.max_input_tokens ?? 200000,
          // クラウドモデルはパラメータ数を公開していない
          parameterSize: null,
          capabilities: describeCapabilities(m.capabilities),
          tier: inferTier(null, "claude"),
        };
        this.modelCache.set(m.id, info);
        infos.push(info);
      }
    } catch (e) {
      throw toClaudeAIError(e);
    }
    return infos;
  }

  async getModel(id: string): Promise<ModelInfo | undefined> {
    const cached = this.modelCache.get(id);
    if (cached) return cached;
    try {
      const client = await this.client();
      const m = await client.models.retrieve(id);
      const info: ModelInfo = {
        id: m.id,
        displayName: m.display_name,
        contextWindow: m.max_input_tokens ?? 200000,
        parameterSize: null,
        capabilities: describeCapabilities(m.capabilities),
        tier: inferTier(null, "claude"),
      };
      this.modelCache.set(id, info);
      return info;
    } catch {
      return undefined;
    }
  }

  /** 入力トークン数を実測する。コスト見積もりに使う（推測値ではなくAPIの値） */
  async countInputTokens(params: {
    model: string;
    systemPrompt: string;
    userPrompt: string;
  }): Promise<number> {
    const client = await this.client();
    try {
      const res = await client.messages.countTokens({
        model: params.model,
        system: params.systemPrompt,
        messages: [{ role: "user", content: params.userPrompt }],
      });
      return res.input_tokens;
    } catch (e) {
      throw toClaudeAIError(e);
    }
  }

  async generate(params: GenerateParams): Promise<GenerateResult> {
    const started = Date.now();
    throwIfAborted(params.signal);
    const client = await this.client();

    // モデルごとの対応状況を見て、送ってよいパラメータだけを組み立てる。
    // 未対応のパラメータを送るとモデルによっては400で弾かれるため。
    const raw = await this.rawCapabilities(params.model, params.signal);
    const maxTokens = await this.resolveMaxTokens(params.model, params.signal);
    throwIfAborted(params.signal);

    const body: Anthropic.MessageCreateParamsNonStreaming = {
      model: params.model,
      max_tokens: maxTokens,
      system: params.systemPrompt,
      messages: [{ role: "user", content: params.userPrompt }],
    };

    if (params.jsonSchema && raw?.structured_outputs.supported !== false) {
      // Claudeの構造化出力はスキーマに追加の制約がある（後述の変換を参照）
      body.output_config = {
        format: {
          type: "json_schema",
          schema: toClaudeJsonSchema(params.jsonSchema) as Record<
            string,
            unknown
          >,
        },
      };
    }

    // 思考モードの扱いはモデル世代で逆になっている。
    //  - adaptive対応の新しいモデル：既定でONなので、切るには明示的にdisabledを送る
    //  - enabledのみの古いモデル：既定でOFFなので、何も送らなければよい
    const thinkingIsOnByDefault = raw?.thinking.types.adaptive.supported === true;
    let sentDisabledThinking = false;
    if (params.disableThinking && thinkingIsOnByDefault) {
      body.thinking = { type: "disabled" };
      sentDisabledThinking = true;
    }

    // effort は対応モデルのみ。抽出タスクは深い推論を必要としないため低めにする
    if (raw?.effort.supported && raw.effort.low.supported) {
      body.output_config = { ...body.output_config, effort: "low" };
    }

    let res: Anthropic.Message;
    try {
      res = await client.messages.create(body, { signal: params.signal });
    } catch (e) {
      // 一部のモデルは thinking の明示的な無効化自体を拒否する。
      // その場合だけ、思考ONのまま1回だけやり直す（プロバイダの切替はしない）。
      if (sentDisabledThinking && isThinkingRejection(e)) {
        delete body.thinking;
        try {
          res = await client.messages.create(body, { signal: params.signal });
        } catch (e2) {
          throw toClaudeAIError(e2);
        }
      } else {
        throw toClaudeAIError(e);
      }
    }

    if (!isClaudeMessage(res)) {
      throw new AIError("Claudeから形式が不正な応答が返りました。", "bad_response");
    }

    // 安全側の判定を先に行う。refusal のとき content は空か途中までしかない
    if (res.stop_reason === "refusal") {
      throw new AIError(
        "AIが安全上の理由でこの内容の処理を拒否しました。" +
          (res.stop_details?.explanation
            ? `（${res.stop_details.explanation}）`
            : ""),
        "bad_response",
        JSON.stringify(res.stop_details ?? {})
      );
    }

    const text = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");

    if (!text.trim()) {
      throw new AIError(
        "AIから空の応答が返りました。",
        "bad_response",
        `stop_reason=${res.stop_reason}`
      );
    }

    return {
      text,
      usage: {
        inputTokens: res.usage.input_tokens,
        outputTokens: res.usage.output_tokens,
      },
      truncated: res.stop_reason === "max_tokens",
      elapsedMs: Date.now() - started,
    };
  }

  /** 出力トークンの上限。設定値とモデル上限の小さい方 */
  private async resolveMaxTokens(model: string, signal?: AbortSignal): Promise<number> {
    throwIfAborted(signal);
    const configured = vscode.workspace
      .getConfiguration("novelai")
      .get<number>("claude.maxOutputTokens", 8192);
    const raw = await this.rawModel(model, signal);
    const modelMax = raw?.max_tokens ?? 8192;
    return Math.max(1024, Math.min(configured, modelMax));
  }

  private rawModelCache = new Map<string, Anthropic.ModelInfo>();

  private async rawModel(
    id: string,
    signal?: AbortSignal
  ): Promise<Anthropic.ModelInfo | undefined> {
    throwIfAborted(signal);
    const cached = this.rawModelCache.get(id);
    if (cached) return cached;
    try {
      const client = await this.client();
      const m = await client.models.retrieve(id, undefined, { signal });
      // 中止後に返った値をキャッシュすると、次回の要求へ不完全な状態を持ち越す。
      throwIfAborted(signal);
      this.rawModelCache.set(id, m);
      return m;
    } catch (e) {
      const error = toClaudeAIError(e);
      if (error.kind === "aborted") throw error;
      // 取得できなければ既定値で進む（呼び出し自体は成功しうる）
      return undefined;
    }
  }

  private async rawCapabilities(
    id: string,
    signal?: AbortSignal
  ): Promise<Anthropic.ModelCapabilities | undefined> {
    return (await this.rawModel(id, signal))?.capabilities ?? undefined;
  }
}

/** UI表示用に対応機能を短い日本語ラベルへ変換する */
function describeCapabilities(
  caps: Anthropic.ModelCapabilities | null
): string[] {
  if (!caps) return [];
  const out: string[] = [];
  if (caps.structured_outputs.supported) out.push("JSON強制");
  if (caps.thinking.supported) out.push("思考");
  if (caps.image_input.supported) out.push("画像");
  if (caps.effort.supported) out.push("effort");
  if (caps.batch.supported) out.push("バッチ");
  return out;
}

/**
 * OllamaとClaudeでJSONスキーマの受け付け方が違うため変換する。
 *
 * Claudeの構造化出力は
 *   - すべてのobjectに additionalProperties: false が必要
 *   - type: ["string", "null"] のような配列形式は anyOf で書く
 * という制約がある。Ollama側のスキーマ定義は変更したくないので
 * （プロンプトversionが変わるとキャッシュが全部無効になる）、
 * 送信直前にここで変換する。
 */
export function toClaudeJsonSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) {
    return schema.map(toClaudeJsonSchema);
  }
  if (schema === null || typeof schema !== "object") {
    return schema;
  }

  const src = schema as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(src)) {
    if (key === "type" && Array.isArray(value)) {
      // ["string", "null"] → anyOf: [{type:"string"}, {type:"null"}]
      continue;
    }
    out[key] = toClaudeJsonSchema(value);
  }

  if (Array.isArray(src.type)) {
    out.anyOf = (src.type as unknown[]).map((t) => ({ type: t }));
  }

  if (out.type === "object" || out.properties !== undefined) {
    if (out.additionalProperties === undefined) {
      out.additionalProperties = false;
    }
  }

  return out;
}

/** thinking パラメータ自体を拒否されたか */
function isThinkingRejection(e: unknown): boolean {
  if (!(e instanceof Anthropic.BadRequestError)) return false;
  return /thinking/i.test(e.message);
}

function describeError(e: unknown): string {
  const err = toClaudeAIError(e);
  return err.message;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new AIError("処理が中止されました。", "aborted");
  }
}

function isClaudeMessage(value: unknown): value is Anthropic.Message {
  if (!isRecord(value) || !Array.isArray(value.content) || !isRecord(value.usage)) {
    return false;
  }
  if (
    typeof value.usage.input_tokens !== "number" ||
    typeof value.usage.output_tokens !== "number"
  ) {
    return false;
  }
  return value.content.every(
    (block) =>
      isRecord(block) &&
      typeof block.type === "string" &&
      (block.type !== "text" || typeof block.text === "string")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** SDKの型付き例外を、UIが扱いやすい AIError へ変換する */
export function toClaudeAIError(error: unknown): AIError {
  const e = error;
  if (e instanceof AIError) return e;

  if (e instanceof Anthropic.AuthenticationError) {
    return new AIError(
      "ClaudeのAPIキーが正しくありません。再登録してください。",
      "not_running",
      e.message
    );
  }
  if (e instanceof Anthropic.NotFoundError) {
    return new AIError(
      "指定したモデルが見つかりません。",
      "model_not_found",
      e.message
    );
  }
  if (e instanceof Anthropic.PermissionDeniedError) {
    return new AIError(
      "このAPIキーには権限がありません（モデル未開放、または請求設定が未完了の可能性があります）。",
      "bad_response",
      e.message
    );
  }
  if (e instanceof Anthropic.RateLimitError) {
    return new AIError(
      "Claudeのレート上限に達しました。しばらく待ってから再実行してください。",
      "bad_response",
      e.message
    );
  }
  if (e instanceof Anthropic.APIConnectionTimeoutError) {
    return new AIError(
      "Claudeの応答がタイムアウトしました。設定でタイムアウトを延ばしてください。",
      "timeout",
      e.message
    );
  }
  if (e instanceof Anthropic.APIUserAbortError) {
    return new AIError("処理が中止されました。", "aborted", e.message);
  }
  if (e instanceof Anthropic.APIConnectionError) {
    return new AIError(
      "Claudeに接続できません。ネットワーク接続を確認してください。",
      "not_running",
      e.message
    );
  }
  if (e instanceof Anthropic.APIError) {
    return new AIError(
      "Claudeが予期しない応答を返しました。設定を確認して再実行してください。",
      "bad_response",
      String(e.status)
    );
  }

  const err = e as Error;
  if (err?.name === "AbortError") {
    return new AIError("処理が中止されました。", "aborted");
  }
  return new AIError("Claudeとの通信中に予期しないエラーが発生しました。", "unknown");
}
