import * as vscode from "vscode";
import Anthropic from "@anthropic-ai/sdk";
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
import { clampToModelLimit, resolveMaxOutputTokens } from "./outputLimit";
import { forgetSecret, logLine, registerSecret } from "../core/logger";

/** APIキーの保存先。設定ファイルではなくOSの資格情報ストアに置く */
const SECRET_KEY = "novelai.claude.apiKey";

const CLAUDE_STOP_REASONS = new Set<string>([
  "end_turn",
  "max_tokens",
  "stop_sequence",
  "tool_use",
  "pause_turn",
  "refusal",
  "model_context_window_exceeded",
]);

/**
 * Claude（Anthropic API）アダプタ。
 *
 * Ollamaと違いクラウド実行なので**呼ぶたびに課金される**。
 * 設計方針どおり自動フォールバックはせず、
 * 使うかどうかは常に作者が明示的に選ぶ。
 */
export class ClaudeProvider implements ApiKeyProvider {
  readonly id = "claude" as const;
  readonly displayName = "Claude（クラウド・有料）";
  readonly isPaid = true;

  readonly apiKeyHelp: ApiKeyHelp = {
    title: "ClaudeのAPIキーを入力してください",
    prompt:
      "console.anthropic.com の API Keys で発行できます。入力内容は資格情報ストアに保存され、settings.jsonには書き込まれません。",
    placeHolder: "APIキーを貼り付けてください",
    validate: validateApiKeyFormat,
  };

  /** モデル情報のキャッシュ。listModels は毎回叩くと遅い */
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

  private async client(): Promise<Anthropic> {
    const apiKey = await this.getApiKey();
    if (!apiKey) {
      throw new AIError(
        "ClaudeのAPIキーが設定されていません。「AIの設定」から登録してください。",
        "authentication_failed"
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

    // モデルの申告する対応状況だけでは足りない。実際に400で拒否される項目が
    // あるため、拒否されたら外して試し、通った組み合わせを覚える。
    // Gemini側と同じ方針（エラー文から原因を当てにいかない）。
    const stored = this.supportFor(params.model);

    // 思考モードの扱いはモデル世代で逆になっている。
    //  - adaptive対応の新しいモデル：既定でONなので、切るには明示的にdisabledを送る
    //  - enabledのみの古いモデル：既定でOFFなので、何も送らなければよい
    const thinkingIsOnByDefault =
      raw?.thinking.types.adaptive.supported === true;
    const sendsSchema =
      params.jsonSchema !== undefined &&
      raw?.structured_outputs.supported !== false;
    const sendsThinking = params.disableThinking === true && thinkingIsOnByDefault;
    const sendsEffort =
      raw?.effort.supported === true && raw.effort.low.supported === true;

    // この呼び出しで実際に送る指定だけを、外す候補にする。
    // 送ってもいない指定を「非対応」と覚えると、次の呼び出しで失う
    const applicable: ClaudeOptionKey[] = [];
    if (sendsEffort) applicable.push("effort");
    if (sendsThinking) applicable.push("thinking");
    if (sendsSchema) applicable.push("jsonSchema");

    const buildBody = (
      support: ClaudeSupport
    ): Anthropic.MessageCreateParamsNonStreaming => {
      const body: Anthropic.MessageCreateParamsNonStreaming = {
        model: params.model,
        max_tokens: maxTokens,
        system: params.systemPrompt,
        messages: [{ role: "user", content: params.userPrompt }],
      };
      if (sendsSchema && support.jsonSchema) {
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
      if (sendsThinking && support.thinking) {
        body.thinking = { type: "disabled" };
      }
      // effort は対応モデルのみ。抽出タスクは深い推論を必要としないため低めにする
      if (sendsEffort && support.effort) {
        body.output_config = { ...body.output_config, effort: "low" };
      }
      return body;
    };

    let res: Anthropic.Message | undefined;
    let accepted: ClaudeSupport | undefined;
    let lastError: AIError | undefined;

    for (const attempt of claudeAttemptPlan(stored, applicable)) {
      throwIfAborted(params.signal);
      try {
        res = await client.messages.create(buildBody(attempt.support), {
          signal: params.signal,
        });
        // 通った組み合わせだけを覚える。失敗から学ぶと誤った結論が残る
        accepted = attempt.support;
        if (attempt.dropped.length > 0) {
          logLine(
            `Claudeは「${describeDroppedOptions(attempt.dropped)}」を外すと通りました` +
              `（モデル: ${params.model}）。以後この組み合わせで呼び出します。`
          );
        }
        break;
      } catch (e) {
        // 残高不足もAnthropicは400で返す。要求の形の問題ではないので、
        // 機能を外しても直らない。外し続けると対応機能を失うだけ
        const billing = billingProblem(e);
        if (billing) throw billing;

        const error = toClaudeMessageCreateError(e);
        if (error.kind !== "bad_response" || !isInvalidRequest(e)) throw error;

        lastError = error;
        // **何を外したときに何と言われたのかを必ず残す。**
        // 以前はこれを捨てていたため、どの指定が悪いのか誰にも分からず、
        // 当てずっぽうで機能を外し続けることになった
        logLine(
          `Claudeが要求を受け付けませんでした（モデル: ${params.model} / ` +
            `外した指定: ${describeDroppedOptions(attempt.dropped)}）。` +
            `応答: ${error.detail ?? "（本文なし）"}`
        );
      }
    }

    if (!res || !accepted) {
      throw (
        lastError ??
        new AIError("Claudeが要求を受け付けませんでした。", "bad_response")
      );
    }
    this.rememberSupport(params.model, accepted);

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
    const raw = await this.rawModel(model, signal);
    return clampToModelLimit(resolveMaxOutputTokens(), raw?.max_tokens ?? 8192);
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

  private readonly supportCache = new Map<string, ClaudeSupport>();

  /**
   * モデルごとに送ってよい指定。分からないうちは全部送れる前提で始める。
   *
   * **VS Codeを閉じても覚えておく。** 覚えないと再起動のたびに
   * 400で弾かれる呼び出しが発生し、そのぶん課金される。
   */
  private supportFor(model: string): ClaudeSupport {
    const cached = this.supportCache.get(model);
    if (cached) return cached;

    const stored = this.context.globalState.get<ClaudeSupport>(
      supportKey(model)
    );
    const support: ClaudeSupport = {
      effort: stored?.effort ?? true,
      thinking: stored?.thinking ?? true,
      jsonSchema: stored?.jsonSchema ?? true,
    };
    this.supportCache.set(model, support);
    return support;
  }

  /**
   * 通った組み合わせを覚える。
   *
   * **記憶と手元の控えの両方を書き換える。** 以前は保存先だけを更新しており、
   * 手元の控えが古いままだったため、同じ実行の次のチャンクでまた同じ指定を送り、
   * 毎回400を4回もらってから通るという動きになっていた（実データのログで確認）。
   */
  private rememberSupport(model: string, support: ClaudeSupport): void {
    this.supportCache.set(model, { ...support });
    void this.context.globalState.update(supportKey(model), { ...support });
  }
}

/**
 * 記憶の置き場。
 *
 * v2 にしたのは、v1で残高不足を「機能が未対応」と誤って学習した記録を
 * 捨てるため。古い記録を読み続けると、対応している機能を永久に使わなくなる。
 *
 * v3 にしたのも同じ理由である。積み上げ式に外していたv2では、原因が
 * JSONスキーマ1つだけでも、先に外した effort と 思考の無効化 まで
 * 「非対応」として記録された。その記録が残っていると、直したあとも
 * スキーマ無し・思考ONのまま呼び続けることになる（実データで発生）。
 *
 * v4 は、拒否の原因がモデルではなく**こちらのスキーマ**だったため。
 * 「必須でない項目が多すぎる」で弾かれていたのを直したので、
 * 「JSONスキーマ非対応」という記録は誤りになった。
 *
 * **`toClaudeJsonSchema` を直したら、ここの版も上げること。**
 * 上げないと、直す前の判定が残って新しいスキーマを試さない。
 */
function supportKey(model: string): string {
  return `novelai.claude.support.v4.${model}`;
}

/**
 * 残高不足・請求設定の問題か。
 *
 * Anthropicはこれも400 invalid_request_error で返してくるため、
 * 「要求の形が悪い」と区別が付かない。文面で判断するしかない。
 * 取り違えると、直らない再試行を繰り返したうえに
 * 対応している機能まで外してしまう。
 */
export function billingProblem(error: unknown): AIError | undefined {
  const message = error instanceof Error ? error.message : String(error);
  if (!/credit balance|Plans & Billing|billing/i.test(message)) {
    return undefined;
  }
  return new AIError(
    "Anthropicのクレジット残高が不足しています。" +
      "console.anthropic.com の Plans & Billing で購入してください。",
    "insufficient_credit",
    message
  );
}

/** モデルごとに、任意の指定が使えるか */
export interface ClaudeSupport {
  effort: boolean;
  thinking: boolean;
  jsonSchema: boolean;
}

export type ClaudeOptionKey = keyof ClaudeSupport;

/** 外す順。抽出の質への影響が小さいものから並べる */
export const CLAUDE_OPTION_ORDER: ClaudeOptionKey[] = [
  "effort",
  "thinking",
  "jsonSchema",
];

export const CLAUDE_OPTION_LABELS: Record<ClaudeOptionKey, string> = {
  effort: "推論の深さ(effort)",
  thinking: "思考の無効化",
  jsonSchema: "JSONスキーマ",
};

export interface ClaudeAttempt {
  support: ClaudeSupport;
  /** この試行で外した指定。空なら全部付けたまま */
  dropped: ClaudeOptionKey[];
}

/**
 * 試す組み合わせを順に並べる。
 *
 * **まず1つずつ外す。** 以前は端から順に積み上げて外していたため、
 * 原因が最後の1つ（JSONスキーマ）だったときに、無実の指定まで
 * 「非対応」として覚えてしまった。実際にClaudeで起き、
 * 思考の無効化とJSONスキーマの両方を永久に失った状態になっていた。
 *
 * 1つずつ試せば、原因が1つのときは犯人だけを覚えられる。
 * どれを外しても直らないときだけ、まとめて外した組み合わせを試す。
 */
export function claudeAttemptPlan(
  support: ClaudeSupport,
  /** この呼び出しで実際に送る指定だけを渡す */
  applicable: ClaudeOptionKey[]
): ClaudeAttempt[] {
  const active = CLAUDE_OPTION_ORDER.filter(
    (key) => applicable.includes(key) && support[key]
  );
  const plan: ClaudeAttempt[] = [{ support: { ...support }, dropped: [] }];

  for (const key of active) {
    plan.push({ support: { ...support, [key]: false }, dropped: [key] });
  }

  if (active.length > 1) {
    const minimal = { ...support };
    for (const key of active) minimal[key] = false;
    plan.push({ support: minimal, dropped: [...active] });
  }
  return plan;
}

export function describeDroppedOptions(dropped: ClaudeOptionKey[]): string {
  if (dropped.length === 0) return "なし（すべて付けたまま）";
  return dropped.map((key) => CLAUDE_OPTION_LABELS[key]).join("・");
}

/** 要求の作りが受け付けられなかったか。認証や上限とは区別する */
export function isInvalidRequest(error: unknown): boolean {
  if (error instanceof Anthropic.BadRequestError) return true;
  if (error instanceof Anthropic.APIError) return error.status === 400;
  return false;
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
 *   - **minLength / maxLength は受け付けない**
 * という制約がある。Ollama側のスキーマ定義は変更したくないので
 * （プロンプトversionが変わるとキャッシュが全部無効になる）、
 * 送信直前にここで変換する。
 *
 * 文字数の制約は、以前は「拒否されたら外す」形にしていた。
 * しかし**Anthropicの仕様として最初から非対応**であり、
 * 試す意味がないうえに、その1回の400が他の指定への濡れ衣になった。
 * 常に落とす。字数はコード側で切っているので（`clampSummary`）、
 * スキーマから外しても資料の見た目は変わらない。
 */
export function toClaudeJsonSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) {
    return schema.map((item) => toClaudeJsonSchema(item));
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
    if (key === "minLength" || key === "maxLength") continue;
    out[key] = toClaudeJsonSchema(value);
  }

  if (Array.isArray(src.type)) {
    out.anyOf = (src.type as unknown[]).map((t) => ({ type: t }));
  }

  if (out.type === "object" || out.properties !== undefined) {
    if (out.additionalProperties === undefined) {
      out.additionalProperties = false;
    }
    /**
     * **すべての項目を必須にする。**
     *
     * Anthropicは「必須でない項目」の総数に上限（24）を設けており、
     * こちらのスキーマは26個で拒否されていた。
     * 「Schemas contains too many optional parameters (26)」がその応答である。
     * 個別の指定（effort・思考・文字数）は無関係で、スキーマ全体が
     * 受け取ってもらえていなかった。
     *
     * 必須にしても意味は変わらない。null許容の項目は anyOf に null を
     * 含んでいるので、「読み取れなかった」は null で表せる。
     * むしろ**省略可能にすると、モデルは面倒な項目を黙って落とす**
     * （この作品で何度も確認している）。Ollama側のスキーマでも
     * 同じ理由で必須を増やしてきた。ここはその方針と揃う。
     */
    const properties = out.properties;
    if (properties && typeof properties === "object") {
      out.required = Object.keys(properties as Record<string, unknown>);
    }
  }

  return out;
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
  if (!isClaudeStopReason(value.stop_reason)) return false;
  return value.content.every(
    (block) =>
      isRecord(block) &&
      typeof block.type === "string" &&
      (block.type !== "text" || typeof block.text === "string")
  );
}

function isClaudeStopReason(value: unknown): boolean {
  return value === null || (typeof value === "string" && CLAUDE_STOP_REASONS.has(value));
}

function toClaudeMessageCreateError(error: unknown): AIError {
  // SDKの成功HTTP応答JSONのデコード失敗だけを応答不正として扱う。
  // 汎用のSyntaxErrorまで変換すると、呼び出し側のプログラム不備を隠してしまう。
  if (error instanceof SyntaxError) {
    return new AIError("Claudeから形式が不正な応答が返りました。", "bad_response");
  }
  return toClaudeAIError(error);
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
      "authentication_failed",
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
      "permission_denied",
      e.message
    );
  }
  if (e instanceof Anthropic.RateLimitError) {
    return new AIError(
      "Claudeのレート上限に達しました。しばらく待ってから再実行してください。",
      "rate_limited",
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
      // ステータスだけ残しても原因にたどり着けない。
      // 実際にどの項目を拒否されたのかは本文にしか書かれていない
      `HTTP ${e.status}: ${e.message}`
    );
  }

  const err = e as Error;
  if (err?.name === "AbortError") {
    return new AIError("処理が中止されました。", "aborted");
  }
  return new AIError("Claudeとの通信中に予期しないエラーが発生しました。", "unknown");
}
