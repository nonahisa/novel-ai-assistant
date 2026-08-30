import * as vscode from "vscode";
import { AIError, ApiKeyHelp, ApiKeyProvider, ConnectionTestResult, GenerateParams, GenerateResult, ModelInfo, inferTier, validateApiKeyFormat } from "./types";
import { fetchJson } from "./httpClient";
import { clampToModelLimit, resolveMaxOutputTokens } from "./outputLimit";
import { buildAttemptPlan, type OptionAttempt } from "./optionFallback";
import { forgetSecret, logLine, registerSecret } from "../core/logger";
import { resolveTimeoutMs } from "../core/modelTuning";
import { isWebRuntime } from "../core/runtime";

/**
 * Claude（Anthropic API）アダプタ。
 *
 * **公式SDKを使わない。** 2026-08-21まで `@anthropic-ai/sdk` を使っていたが、
 * SDKはNode専用のコード（`node:child_process` を読む資格情報の自動探索）を
 * importするだけで含んでしまい、ブラウザ版のVS Code向けビルドが壊れる
 * （設計書5.8.5）。OpenAI・Geminiと同じく、素の `fetch` で呼ぶ形に書き換えた。
 *
 * **配線（URL・ヘッダー・エラー形式・ページングの仕方）は、SDK自身の
 * ソース（`node_modules/@anthropic-ai/sdk`、書き換え時点でv0.115.0）を
 * 読んで確かめた。** 憶測で書いていない。ただし**実際のAnthropic APIに
 * 対して検証してはいない**（このプロジェクトで実キーを持つのは
 * Ollama・Geminiだけ）。書き換え後は実機での接続確認を先に行うこと。
 *
 * Ollamaと違いクラウド実行なので**呼ぶたびに課金される**。
 * 設計方針どおり自動フォールバックはせず、
 * 使うかどうかは常に作者が明示的に選ぶ。
 */

const SECRET_KEY = "novelai.claude.apiKey";
const DEFAULT_ENDPOINT = "https://api.anthropic.com";
const ANTHROPIC_VERSION = "2023-06-01";
const LABEL = "Claude";

const CLAUDE_STOP_REASONS = new Set<string>([
  "end_turn",
  "max_tokens",
  "stop_sequence",
  "tool_use",
  "pause_turn",
  "refusal",
]);

/** `/v1/models/{id}` の応答（使う項目だけ） */
interface ClaudeModel {
  id: string;
  display_name: string;
  max_input_tokens?: number;
  max_tokens?: number;
  capabilities: ClaudeModelCapabilities | null;
}

interface ClaudeModelCapabilities {
  structured_outputs?: { supported?: boolean };
  thinking?: {
    supported?: boolean;
    types?: { adaptive?: { supported?: boolean } };
  };
  image_input?: { supported?: boolean };
  effort?: { supported?: boolean; low?: { supported?: boolean } };
  batch?: { supported?: boolean };
}

/** `/v1/models` の応答（カーソル形式のページング） */
interface ClaudeModelList {
  data: ClaudeModel[];
  has_more: boolean;
  last_id: string | null;
}

/** `/v1/messages` の応答 */
interface ClaudeMessage {
  content: Array<{ type: string; text?: string }>;
  stop_reason: string | null;
  stop_details?: { explanation?: string };
  usage: {
    input_tokens: number;
    output_tokens: number;
    /**
     * キャッシュから読めた分。
     *
     * **Claudeは印（`cache_control`）を付けないと効かない。** いまは
     * 付けていないので、この項目は返らないか0で返る。付ける実装より先に
     * 読むほうを入れておくと、**付けた前後を同じ物差しで比べられる**。
     */
    cache_read_input_tokens?: number | null;
    /**
     * キャッシュへ書き込んだ分。読めた分より割高なので、印を付けたあと
     * 「書いてばかりで読めていない」ことに気づくために型へ残す
     * （いまは記録していない）。
     */
    cache_creation_input_tokens?: number | null;
  };
}

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

  private get endpoint(): string {
    return DEFAULT_ENDPOINT;
  }

  /**
   * 1回の呼び出しで待つミリ秒。台帳（AIチューニング）→ 設定 → 既定 の順。
   *
   * **既定が300秒なのはClaudeだけ**（package.json）。ここへ渡す数も
   * それに合わせる——180にすると、設定を宣言していない場面（試験など）で
   * 黙って短くなる。
   *
   * **上限のほうは台帳を見ない。** Claudeはモデル一覧が
   * `max_input_tokens` を返すので、測った値で上書きすると
   * 「取れている正しい値」を潰すことになる（設計書6.49）。
   */
  private requestTimeoutMs(model: string): number {
    return resolveTimeoutMs(this.id, model, 300);
  }

  /**
   * 送信ヘッダー。
   *
   * **ブラウザから直に叩くと、Anthropicは既定で拒否する。** 公式SDKは
   * `dangerouslyAllowBrowser: true` を渡したときだけ
   * `anthropic-dangerous-direct-browser-access` を付ける（ブラウザ経由だと
   * 鍵が盗まれる危険があるとSDK自身が警告している）。この拡張機能は
   * 鍵を `vscode.ExtensionContext.secrets`（OSの資格情報ストア）へ
   * 保存しており、ブラウザ版でも同じ仕組みを使うので、
   * `isWebRuntime()` のときだけ同じ意思表示を付ける。
   */
  private async headers(): Promise<Record<string, string>> {
    const apiKey = await this.getApiKey();
    if (!apiKey) {
      throw new AIError(
        "ClaudeのAPIキーが設定されていません。「AI設定」から登録してください。",
        "authentication_failed"
      );
    }
    return {
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
      ...(isWebRuntime()
        ? { "anthropic-dangerous-direct-browser-access": "true" }
        : {}),
    };
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
   *
   * ページングは `after_id`（前ページの最後のID）を繰り返し渡すカーソル形式。
   * SDKの `models.list()` と同じ動き。
   */
  async listModels(): Promise<ModelInfo[]> {
    const headers = await this.headers();
    const infos: ModelInfo[] = [];
    let afterId: string | undefined;

    // ページ送りが壊れて無限に回らないよう上限を設ける
    for (let page = 0; page < 20; page++) {
      const query = new URLSearchParams({ limit: "100" });
      if (afterId) query.set("after_id", afterId);

      let response: ClaudeModelList;
      try {
        response = await fetchJson<ClaudeModelList>({
          url: `${this.endpoint}/v1/models?${query.toString()}`,
          headers,
          timeoutMs: 15000,
          label: LABEL,
        });
      } catch (e) {
        throw toClaudeAIError(e);
      }

      for (const m of response.data) {
        const info = toModelInfo(m);
        this.modelCache.set(m.id, info);
        infos.push(info);
      }

      if (!response.has_more || !response.last_id) break;
      afterId = response.last_id;
    }

    return infos;
  }

  async getModel(id: string): Promise<ModelInfo | undefined> {
    const cached = this.modelCache.get(id);
    if (cached) return cached;
    const m = await this.rawModel(id);
    if (!m) return undefined;
    const info = toModelInfo(m);
    this.modelCache.set(id, info);
    return info;
  }

  async generate(params: GenerateParams): Promise<GenerateResult> {
    const started = Date.now();
    throwIfAborted(params.signal);
    const headers = await this.headers();

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
      raw?.thinking?.types?.adaptive?.supported === true;
    const sendsSchema =
      params.jsonSchema !== undefined &&
      raw?.structured_outputs?.supported !== false;
    const sendsThinking = params.disableThinking === true && thinkingIsOnByDefault;
    const sendsEffort =
      raw?.effort?.supported === true && raw.effort.low?.supported === true;

    // この呼び出しで実際に送る指定だけを、外す候補にする。
    // 送ってもいない指定を「非対応」と覚えると、次の呼び出しで失う
    const applicable: ClaudeOptionKey[] = [];
    if (sendsEffort) applicable.push("effort");
    if (sendsThinking) applicable.push("thinking");
    if (sendsSchema) applicable.push("jsonSchema");

    const buildBody = (support: ClaudeSupport): Record<string, unknown> => {
      const body: Record<string, unknown> = {
        model: params.model,
        max_tokens: maxTokens,
        system: params.systemPrompt,
        messages: [{ role: "user", content: params.userPrompt }],
      };
      let outputConfig: Record<string, unknown> | undefined;
      if (sendsSchema && support.jsonSchema) {
        // Claudeの構造化出力はスキーマに追加の制約がある（後述の変換を参照）
        outputConfig = {
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
        outputConfig = { ...outputConfig, effort: "low" };
      }
      if (outputConfig) body.output_config = outputConfig;
      return body;
    };

    let res: ClaudeMessage | undefined;
    let accepted: ClaudeSupport | undefined;
    let lastError: AIError | undefined;

    for (const attempt of claudeAttemptPlan(stored, applicable)) {
      throwIfAborted(params.signal);
      try {
        res = await fetchJson<ClaudeMessage>({
          url: `${this.endpoint}/v1/messages`,
          method: "POST",
          headers,
          body: buildBody(attempt.support),
          timeoutMs: this.requestTimeoutMs(params.model),
          signal: params.signal,
          label: LABEL,
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

        const error = toClaudeAIError(e);
        if (!isInvalidRequest(error)) throw error;

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
      .filter((b): b is { type: "text"; text: string } => b.type === "text" && typeof b.text === "string")
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
        // **null で返ることがある**（キャッシュを使っていない回）ので undefined へ寄せる。
        // `?? 0` にはしない——0は「印を付けたのに読めなかった」に取っておく
        cachedInputTokens: res.usage.cache_read_input_tokens ?? undefined,
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

  private rawModelCache = new Map<string, ClaudeModel>();

  private async rawModel(
    id: string,
    signal?: AbortSignal
  ): Promise<ClaudeModel | undefined> {
    throwIfAborted(signal);
    const cached = this.rawModelCache.get(id);
    if (cached) return cached;
    try {
      const headers = await this.headers();
      const m = await fetchJson<ClaudeModel>({
        url: `${this.endpoint}/v1/models/${encodeURIComponent(id)}`,
        headers,
        timeoutMs: 15000,
        signal,
        label: LABEL,
      });
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
  ): Promise<ClaudeModelCapabilities | undefined> {
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

function toModelInfo(m: ClaudeModel): ModelInfo {
  return {
    id: m.id,
    displayName: m.display_name,
    contextWindow: m.max_input_tokens ?? 200000,
    // クラウドモデルはパラメータ数を公開していない
    parameterSize: null,
    capabilities: describeCapabilities(m.capabilities),
    tier: inferTier(null, "claude"),
  };
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
 *
 * **`error.detail`（生の応答本文）を見る。** `.message` は
 * 「Claudeがエラーを返しました (HTTP 400)。」という定型文で、
 * 実際の理由は本文にしか書かれていない。
 */
export function billingProblem(error: unknown): AIError | undefined {
  const message =
    error instanceof AIError
      ? (error.detail ?? error.message)
      : error instanceof Error
        ? error.message
        : String(error);
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

export type ClaudeAttempt = OptionAttempt<ClaudeOptionKey>;

/**
 * 試す組み合わせを順に並べる。
 * 並べ方は Gemini と共通（`optionFallback.ts`）。外す順だけこちらで決める。
 */
export function claudeAttemptPlan(
  support: ClaudeSupport,
  /** この呼び出しで実際に送る指定だけを渡す */
  applicable: ClaudeOptionKey[]
): ClaudeAttempt[] {
  return buildAttemptPlan(
    support,
    CLAUDE_OPTION_ORDER.filter((key) => applicable.includes(key))
  );
}

export function describeDroppedOptions(dropped: ClaudeOptionKey[]): string {
  if (dropped.length === 0) return "なし（すべて付けたまま）";
  return dropped.map((key) => CLAUDE_OPTION_LABELS[key]).join("・");
}

/**
 * 要求の作りが受け付けられなかったか。認証や上限とは区別する。
 *
 * Gemini側の `isInvalidArgument` と同じ考え方（`httpClient.ts` の
 * `toStatusError` は400を明示的な種別に振り分けないので、`bad_response`
 * かつメッセージに "HTTP 400" を含むかで見分ける）。
 */
export function isInvalidRequest(error: unknown): boolean {
  if (!(error instanceof AIError)) return false;
  if (error.kind !== "bad_response") return false;
  return /HTTP 400/.test(error.message);
}

/** UI表示用に対応機能を短い日本語ラベルへ変換する */
function describeCapabilities(caps: ClaudeModelCapabilities | null): string[] {
  if (!caps) return [];
  const out: string[] = [];
  if (caps.structured_outputs?.supported) out.push("JSON強制");
  if (caps.thinking?.supported) out.push("思考");
  if (caps.image_input?.supported) out.push("画像");
  if (caps.effort?.supported) out.push("effort");
  if (caps.batch?.supported) out.push("バッチ");
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

function isClaudeMessage(value: unknown): value is ClaudeMessage {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 予期しない失敗を、UIが扱いやすい AIError へ正規化する。
 *
 * `fetchJson` が投げるものはすでに `AIError` なので、ほぼ素通しする。
 * それ以外（想定していない例外）は、生のメッセージをUIへ出さない
 * （内部情報が漏れる可能性があるため）。
 */
export function toClaudeAIError(error: unknown): AIError {
  if (error instanceof AIError) return error;
  return new AIError("Claudeとの通信中に予期しないエラーが発生しました。", "unknown");
}
