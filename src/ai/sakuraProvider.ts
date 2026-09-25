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
import { describeWindowCappedOutput } from "./contextGuard";
import { forgetSecret, logLine, registerSecret } from "../core/logger";
import {
  resolveContextWindow,
  resolveTimeoutMs,
  type ContextWindowSource,
} from "../core/modelTuning";
import { customEndpointNotice } from "../core/endpointNotice";
import {
  asContextOverflowError,
  isChatModel,
  isUnsupportedParameter,
} from "./openaiProvider";
import { hiddenModel } from "./hiddenModels";

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

/**
 * コンテキスト長の決め方（設計書6.77の第2段）。
 *
 * **モデル一覧APIはコンテキスト長を返さない。** モデルごとの表を持つと
 * 新しいモデルが出るたびに古くなるので、設定値を使う。
 * チャンク分割の基準になるため、実際より大きいと入力が黙って切り捨てられる。
 *
 * **AIチューニングで測った値があれば、そちらを先に使う**（設計書6.49）。
 * 設定はプロバイダに1つしか無く、`gpt-oss-120b`（131,072）と31Bのモデルを
 * 行き来すると必ずどちらかが合わない。台帳はモデルごとなので食い違わない。
 *
 * **台帳にも設定にも無ければ、同梱の値を見る**（`core/bundledTuning.ts`）。
 * `/v1/models/{id}` も404で長さを教えない（2026-09-26）。4,096しか読めない
 * モデル（llm-jp・Phi）を 32,000 と扱って全話400にしたのが、同梱に載せた
 * きっかけである。
 *
 * export しているのは、3社ぶんの読み順を試験が突き合わせるため。
 */
export const SAKURA_CONTEXT_WINDOW: ContextWindowSource = {
  settingKey: "sakura.contextWindow",
  fallback: 32000,
  minimum: 1024,
};

interface ModelListResponse {
  data?: Array<{ id?: string; owned_by?: string }>;
}

/**
 * 思考を止める指定（比べ 2026-09-25〜26）。
 *
 * **再現**：考えるタイプのモデル（Qwen3.6-35B-A3B・Kimi-K2.7-Code・Kimi-K2.6）が、
 * 考える途中で出力の上限（11,264）を使い切り、答えが空で返った
 * （`finish_reason=length`）。Ollama へは `think: false` を送っているのに、
 * さくらへは思考を止める指定を何も送っていなかった。
 *
 * **実測（2026-09-26、要約用の短い問い）で効いたもの**：
 *
 * | 指定 | Qwen3.6 | Kimi-K2.6 | Kimi-K2.7-Code |
 * |---|---|---|---|
 * | 何も送らない | 考えた（1,801トークン） | — | — |
 * | `reasoning_effort: "none"` | 止まった | **考えが答えの欄へ流れ出た** | 止まらなかった |
 * | `chat_template_kwargs` の `enable_thinking: false` | 止まった | — | — |
 * | `chat_template_kwargs` の `thinking: false` | — | 止まった | 答えの欄へ流れ出た（スキーマを付けると止まった） |
 *
 * 形式の強制（`response_format` の JSON スキーマ）を付けた本番の形では、
 * 3つとも答えの欄に JSON だけが返った。**`reasoning_effort` は送らない**
 * ——K2.6 で独り言が答えに混ざる。
 *
 * **モデル名で分けずに、2つの鍵を一緒に送る。** 会話の雛形（chat template）
 * は知らない鍵を読まないので、Qwen 系は `enable_thinking` だけを、Kimi 系は
 * `thinking` だけを読む。gpt-oss・gemma-4・llm-jp・Phi にも送って、断られない
 * ことを確かめた（2026-09-26）。名前で分けると、新しいモデルが出るたびに表が
 * 古くなる（規則6）。
 */
const THINKING_OFF_TEMPLATE_KWARGS: Readonly<Record<string, boolean>> = {
  enable_thinking: false,
  thinking: false,
};

interface ChatResponse {
  choices?: Array<{
    message?: {
      content?: string | null;
      /** 考えた中身（vLLM は `reasoning`、古い版は `reasoning_content`） */
      reasoning?: string | null;
      reasoning_content?: string | null;
    };
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

  /**
   * 思考を止める指定（`chat_template_kwargs`）を**外すと通った**モデル。
   *
   * **通ったときだけ書く**（規則5）。この起動のあいだだけ覚える——
   * 断るモデルはいまのところ見つかっておらず（2026-09-26、9モデル）、
   * 起動し直すたびに1回だけ400をもらうほうが、保存した記憶が古くなって
   * 思考を止められなくなるより害が小さい。
   */
  private readonly thinkingOffRejected = new Set<string>();

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

  /** 1回の呼び出しで待つミリ秒。台帳（AIチューニング）→ 設定 → 既定 の順 */
  private requestTimeoutMs(model: string): number {
    return resolveTimeoutMs(this.id, model, 180);
  }

  /** コンテキスト長。台帳（AIチューニング）→ 設定 → 既定 の順 */
  private contextWindowFor(model: string): number {
    return resolveContextWindow(this.id, model, SAKURA_CONTEXT_WINDOW);
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
        message:
          `さくらのAI Engineに接続しました（モデル ${models.length} 件）` +
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
      // **仕事をこなせないと測ったモデルは候補に出さない**（作者の裁定
      // 2026-09-26 深夜。`hiddenModels.ts`）。`getModel` は外さないので、
      // 名前を打てば使え、すでに割り当ててあるならそのまま動く
      if (hiddenModel(this.id, id)) continue;
      infos.push(this.describe(id));
    }
    infos.sort((a, b) => a.id.localeCompare(b.id));
    return infos;
  }

  async getModel(id: string): Promise<ModelInfo | undefined> {
    const cached = this.modelCache.get(id);
    if (cached) return { ...cached, contextWindow: this.contextWindowFor(id) };
    // 一覧に出ないモデルでも、作者が明示的に選んでいれば使えるようにする
    return this.describe(id);
  }

  private describe(id: string): ModelInfo {
    const parameterSize = parseParameterSize(id);
    const info: ModelInfo = {
      id,
      displayName: id,
      contextWindow: this.contextWindowFor(id),
      parameterSize,
      capabilities: ["JSON強制"],
      // **「クラウドだから最上位」と決めつけない**（後述の理由）
      tier: inferTier(parameterSize, "ollama"),
    };
    this.modelCache.set(id, info);
    return info;
  }

  async generate(params: GenerateParams): Promise<GenerateResult> {
    /*
      **`params.tools`（道具の定義）と `onToolCall` は、ここでは見ない。**

      渡ってくるのは Ollama の形（`prompts/contradictionCheck.ts`）なので、
      そのままでは送れない。知らない欄を送って要求ごと弾かれるより、黙って
      無視して従来どおり答えさせるほうがよい——**道具は答えの質を上げる
      添え物**で、本体はプロンプトの段のほうにある（無くても成り立つ）。
    */
    const started = Date.now();
    const headers = await this.headers();

    const body: Record<string, unknown> = {
      model: params.model,
      messages: [
        { role: "system", content: params.systemPrompt },
        { role: "user", content: params.userPrompt },
      ],
      temperature: params.temperature,
      // **呼び出し側の見込みを尊重する**（設計書6.77の第2段）。
      // 渡されない呼び出しはこれまでどおり設定値で送る
      max_tokens: params.maxOutputTokens ?? resolveMaxOutputTokens(),
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

    // **思考を止める**（比べ 2026-09-25〜26。下の定数に理由）。断られたと
    // 分かっているモデルには、最初から付けない
    const sendsThinkingOff =
      params.disableThinking === true &&
      !this.thinkingOffRejected.has(params.model);
    if (sendsThinkingOff) {
      body.chat_template_kwargs = { ...THINKING_OFF_TEMPLATE_KWARGS };
    }

    // **断られた指定だけを外して出し直す。**
    // どれが駄目かをエラー文から当てにいかず、1つずつ外して試す
    // （GeminiでもAnthropicでも同じ手を使っている）
    let response: ChatResponse | undefined;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        response = await this.post(body, headers, params.model, params.signal);
        // **覚えるのは通ったときだけ**（CLAUDE.md 規則5）。付けて送った
        // のに外した状態で通ったなら、このモデルは受け付けないと分かった
        if (sendsThinkingOff && body.chat_template_kwargs === undefined) {
          this.thinkingOffRejected.add(params.model);
          logLine(
            `さくらのAI Engine：思考を止める指定（chat_template_kwargs）を外すと通りました` +
              `（モデル: ${params.model}）。この起動のあいだは付けずに送ります。`
          );
        }
        break;
      } catch (error) {
        // **上限超えは、指定を外して出し直しても直らない。** 先に見て
        // 種別を分ける。実測（gpt-oss-120b、2026-08-30）では
        // 「Input length (170068) exceeds model's maximum context length
        // (131072).」が400で返り、`bad_response` に丸められていたため、
        // 「読める長さを測る」がそこで打ち切られていた
        const overflow = asContextOverflowError(error, LABEL);
        if (overflow) throw overflow;

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
        /*
          **思考を止める指定は、400なら理由を問わず外して試す**（規則5）。
          ほかの2つと違って本文の言い回しを見ない——OpenAI互換の口には
          本来無い欄なので、断るサーバーが何と書くかは分からない
          （「Extra inputs are not permitted」のように欄の名前すら出さない
          ものもある）。外しても通らなければ、原因は別にある（残高不足など）
          ので、上の「通ったときだけ覚える」によって記憶は変わらない。
        */
        if (
          body.chat_template_kwargs !== undefined &&
          error instanceof AIError &&
          error.kind === "bad_response" &&
          error.status === 400
        ) {
          delete body.chat_template_kwargs;
          logLine(
            `さくらのAI Engine：思考を止める指定を付けた要求が受け付けられなかったため、` +
              `外して再試行します（モデル: ${params.model}）。応答: ${error.detail ?? "（本文なし）"}`
          );
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
      /*
        **上限で切られた空は、直し方が違う**（比べ 2026-09-25〜26）。
        考えるタイプのモデルが、考える途中で出力の上限を使い切ると、答えの
        欄は空のまま `finish_reason=length` で返る。「空の応答」とだけ言うと、
        作者は何をすればよいか分からない。考えた量（`reasoning`）は捨てずに
        長さだけ残す——中身は本文の読みなので、ログへ写さない。
      */
      const reasoningChars =
        (choice.message?.reasoning ?? choice.message?.reasoning_content ?? "")
          .length;
      const detail =
        `finish_reason=${choice.finish_reason ?? "unknown"}` +
        (reasoningChars > 0 ? ` / 考えた量 ${reasoningChars}字` : "");
      if (choice.finish_reason === "length") {
        /*
          **上限を縮めたのが送る前の関所なら、設定の話をしない**（0.89.6 の
          担当の報告 #5）。読める長さに合わせて縮めた上限は、設定を上げても
          また同じ値まで縮まる。直らない操作へ導かない。
        */
        const cap = params.outputCappedByWindow;
        throw new AIError(
          "AIが答えを書く前に、1回の応答の上限を使い切りました（考える途中で止まった可能性があります）。" +
            (cap !== undefined
              ? `${describeWindowCappedOutput(cap)}別のモデルをお試しください。`
              : "設定の「1回の応答の上限」を大きくするか、別のモデルをお試しください。"),
          "bad_response",
          detail
        );
      }
      throw new AIError("AIから空の応答が返りました。", "bad_response", detail);
    }

    /*
      **考えた中身を、思考の欄として返す**（設計書6.49.9）。AIチューニングが
      「思考を止める指定が効いたか」を見分けるのに要る。これまでは捨てて
      いたので、止まっていないモデルも止まったように見えた。答え（`text`）
      には混ぜない。
    */
    const reasoning =
      choice.message?.reasoning ?? choice.message?.reasoning_content ?? "";
    return {
      text,
      ...(reasoning.length > 0 ? { thinking: reasoning } : {}),
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
    // **待ち時間はモデルごとに違う**ので、名前を明示的に受け取る
    model: string,
    signal: AbortSignal | undefined
  ): Promise<ChatResponse> {
    return fetchJson<ChatResponse>({
      url: `${this.endpoint}/chat/completions`,
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
