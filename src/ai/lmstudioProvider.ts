import * as vscode from "vscode";
import {
  AIError,
  AIProvider,
  ConnectionTestResult,
  GenerateParams,
  GenerateResult,
  ModelInfo,
  inferTier,
} from "./types";
import { fetchJson } from "./httpClient";
import { toOpenAIJsonSchema } from "./jsonSchema";
import { resolveMaxOutputTokens } from "./outputLimit";
import { logLine } from "../core/logger";
import { parseParameterSize } from "./sakuraProvider";
import { isUnsupportedParameter } from "./openaiProvider";

/**
 * LM Studio アダプタ（設計書6.24）。
 *
 * 作者の依頼（2026-08-23）：「使用可能なAIにLM studioを追加できますか？」。
 *
 * ## Ollamaと同じ立ち位置、さくらと同じ形
 *
 * **手元で動く。無料で、原稿を外へ送らない**——Ollamaと同じ性質である。
 * ただし口は**OpenAI互換**（`/v1/chat/completions`）なので、実装は
 * さくらのAI Engineとほぼ同じ形になる。**Ollama用の `num_ctx` は無い。**
 *
 * ## APIキーは要らない
 *
 * LM Studioのサーバは手元で動いており、認証を持たない。**入力欄を出さない。**
 * 「キーが要るのでは」と作者を迷わせるだけである。
 *
 * ## コンテキスト長は、こちらからは分からない
 *
 * LM Studioで**どの長さでモデルを読み込んだか**は、APIから確実には取れない。
 * さくらと同じく設定値（`novelai.lmstudio.contextWindow`）を使う。
 *
 * **実際より大きいと、入力が黙って切り捨てられる。** LM Studioの画面で
 * 読み込み時に指定した長さに合わせてもらう。
 *
 * ## 大きさはモデル名から読む
 *
 * LM Studioが動かすのは**公開重みのモデル**で、名前に大きさが入っている
 * （`qwen3-30b-a3b` など）。Ollamaと同じ物差しで能力を見積もる。
 * **「手元で動く＝非力」でも「最新だから最上位」でもない。**
 */

const DEFAULT_ENDPOINT = "http://localhost:1234/v1";
const LABEL = "LM Studio";

interface ModelListResponse {
  data?: Array<{ id?: string; object?: string }>;
}

interface ChatResponse {
  choices?: Array<{
    message?: { content?: string | null };
    finish_reason?: string;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export class LmStudioProvider implements AIProvider {
  readonly id = "lmstudio" as const;
  readonly displayName = "LM Studio（手元のPC）";

  /** 手元で動くので課金されない。Ollamaと同じ扱い */
  readonly isPaid = false;

  private readonly modelCache = new Map<string, ModelInfo>();

  private get endpoint(): string {
    const configured = vscode.workspace
      .getConfiguration("novelai")
      .get<string>("lmstudio.endpoint", DEFAULT_ENDPOINT)
      .trim();
    return (configured || DEFAULT_ENDPOINT).replace(/\/+$/, "");
  }

  private get contextWindow(): number {
    const configured = vscode.workspace
      .getConfiguration("novelai")
      .get<number>("lmstudio.contextWindow", 8192);
    return Number.isFinite(configured) && configured > 0 ? configured : 8192;
  }

  private get requestTimeoutMs(): number {
    const seconds = vscode.workspace
      .getConfiguration("novelai")
      .get<number>("lmstudio.timeoutSeconds", 180);
    return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 180_000;
  }

  /**
   * 呼べる状態か。
   *
   * **サーバが動いているかで決める。** APIキーが無いので、
   * 「設定済みか」を問う意味がない。
   */
  async isConfigured(): Promise<boolean> {
    try {
      await this.listModels();
      return true;
    } catch {
      return false;
    }
  }

  async testConnection(): Promise<ConnectionTestResult> {
    try {
      const models = await this.listModels();
      if (models.length === 0) {
        return {
          ok: true,
          message:
            "LM Studioに接続できましたが、読み込まれているモデルがありません。" +
            "LM Studioでモデルを読み込んでから、もう一度お試しください。",
          modelCount: 0,
        };
      }
      return {
        ok: true,
        message: `LM Studioに接続しました（モデル ${models.length} 件）`,
        modelCount: models.length,
      };
    } catch (error) {
      // **「起動していない」がいちばん多い。** そこを最初に言う
      return {
        ok: false,
        message:
          `LM Studioに接続できませんでした（${this.endpoint}）。` +
          "LM Studioを起動し、左の「Developer」からローカルサーバーを開始してください。" +
          `\n${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    const response = await fetchJson<ModelListResponse>({
      url: `${this.endpoint}/models`,
      timeoutMs: 15000,
      label: LABEL,
    });

    const infos: ModelInfo[] = [];
    for (const entry of response.data ?? []) {
      const id = entry.id;
      if (!id) continue;
      // **埋め込み用のモデルは選ばせない。** 文章を書かせても返らない
      if (/embed/i.test(id)) continue;
      infos.push(this.describe(id));
    }
    infos.sort((a, b) => a.id.localeCompare(b.id));
    return infos;
  }

  async getModel(id: string): Promise<ModelInfo | undefined> {
    const cached = this.modelCache.get(id);
    // 設定を直したら次から効くよう、長さは毎回読み直す
    if (cached) return { ...cached, contextWindow: this.contextWindow };
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
      // 公開重みのモデルなので、Ollamaと同じ物差しで測る
      tier: inferTier(parameterSize, "ollama"),
    };
    this.modelCache.set(id, info);
    return info;
  }

  async generate(params: GenerateParams): Promise<GenerateResult> {
    const started = Date.now();

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
    // どれが駄目かをエラー文から当てにいかず、1つずつ外して試す。
    // LM Studioは読み込んだモデルと版によって受ける指定が変わる
    let response: ChatResponse | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        response = await this.post(body, params.signal);
        break;
      } catch (error) {
        if (
          body.response_format !== undefined &&
          isUnsupportedParameter(error, "response_format")
        ) {
          // 形式の強制が効かないだけで、応答は使える
          delete body.response_format;
          logLine(
            "LM Studio：JSON形式の強制が受け付けられなかったため、外して再試行します。"
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
        "LM Studioへの要求が受け付けられませんでした。",
        "bad_response"
      );
    }

    const choice = response.choices?.[0];
    if (!choice) {
      throw new AIError(
        "LM Studioから形式が不正な応答が返りました。",
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
      },
      truncated: choice.finish_reason === "length",
      elapsedMs: Date.now() - started,
    };
  }

  private async post(
    body: Record<string, unknown>,
    signal: AbortSignal | undefined
  ): Promise<ChatResponse> {
    return fetchJson<ChatResponse>({
      url: `${this.endpoint}/chat/completions`,
      method: "POST",
      body,
      timeoutMs: this.requestTimeoutMs,
      signal,
      label: LABEL,
    });
  }
}
