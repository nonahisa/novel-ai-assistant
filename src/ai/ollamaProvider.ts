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
import { countByteFallback, decodeByteFallback } from "../core/byteFallback";
import { logLine } from "../core/logger";

const DEFAULT_ENDPOINT = "http://localhost:11434";

interface TagsResponse {
  models?: Array<{
    name: string;
    size?: number;
    details?: { parameter_size?: string; quantization_level?: string };
  }>;
}

interface ShowResponse {
  capabilities?: string[];
  details?: { parameter_size?: string };
  model_info?: Record<string, unknown>;
}

interface ChatResponse {
  message?: { content?: string; thinking?: string };
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
  error?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isChatResponse(value: unknown): value is ChatResponse {
  if (!isRecord(value)) return false;
  if (value.error !== undefined && typeof value.error !== "string") return false;
  if (value.done_reason !== undefined && typeof value.done_reason !== "string") return false;
  if (
    value.prompt_eval_count !== undefined &&
    typeof value.prompt_eval_count !== "number"
  ) {
    return false;
  }
  if (value.eval_count !== undefined && typeof value.eval_count !== "number") {
    return false;
  }
  if (value.message === undefined) return true;
  if (!isRecord(value.message)) return false;
  return (
    (value.message.content === undefined || typeof value.message.content === "string") &&
    (value.message.thinking === undefined || typeof value.message.thinking === "string")
  );
}

export class OllamaProvider implements AIProvider {
  readonly id = "ollama" as const;
  readonly displayName = "Ollama（ローカル）";
  /** 自分の機械で動かすので課金は無い */
  readonly isPaid = false;

  /** モデル詳細のキャッシュ。/api/show は毎回呼ぶと重いため */
  private modelCache = new Map<string, ModelInfo>();

  private get endpoint(): string {
    const raw = vscode.workspace
      .getConfiguration("novelai")
      .get<string>("ollama.endpoint", DEFAULT_ENDPOINT);
    return raw.replace(/\/+$/, "");
  }

  private get requestTimeoutMs(): number {
    return (
      vscode.workspace
        .getConfiguration("novelai")
        .get<number>("ollama.timeoutSeconds", 180) * 1000
    );
  }

  async isConfigured(): Promise<boolean> {
    const r = await this.testConnection();
    return r.ok;
  }

  async testConnection(): Promise<ConnectionTestResult> {
    try {
      const res = await this.fetchJson<TagsResponse>("/api/tags", undefined, 8000);
      const count = res.models?.length ?? 0;
      if (count === 0) {
        return {
          ok: true,
          message:
            "Ollamaに接続できましたが、モデルが1つも見つかりません。`ollama pull <モデル名>` で取得してください。",
          modelCount: 0,
        };
      }
      return {
        ok: true,
        message: `Ollamaに接続しました（モデル ${count} 件）`,
        modelCount: count,
      };
    } catch (e) {
      const msg =
        e instanceof AIError && e.kind === "not_running"
          ? `Ollamaに接続できません（${this.endpoint}）。Ollamaが起動しているか確認してください。`
          : `接続に失敗しました: ${String(e instanceof Error ? e.message : e)}`;
      return { ok: false, message: msg };
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    const tags = await this.fetchJson<TagsResponse>("/api/tags", undefined, 8000);
    const names = (tags.models ?? []).map((m) => m.name);

    const infos: ModelInfo[] = [];
    for (const name of names) {
      const cached = this.modelCache.get(name);
      if (cached) {
        infos.push(cached);
        continue;
      }
      try {
        const info = await this.showModel(name);
        this.modelCache.set(name, info);
        infos.push(info);
      } catch {
        // 詳細が取れなくても一覧からは落とさない
        const fallback: ModelInfo = {
          id: name,
          displayName: name,
          contextWindow: 4096,
          parameterSize: null,
          capabilities: [],
          tier: "light",
        };
        infos.push(fallback);
      }
    }
    return infos;
  }

  /** /api/show からコンテキスト長と対応機能を取得する */
  private async showModel(name: string): Promise<ModelInfo> {
    const res = await this.fetchJson<ShowResponse>(
      "/api/show",
      { model: name },
      15000
    );

    // model_info のキーは "gemma4.context_length" のようにアーキ名が前置される。
    // モデルごとに変わるため、末尾一致で拾う。
    let contextWindow = 4096;
    const modelInfo = res.model_info ?? {};
    for (const [key, value] of Object.entries(modelInfo)) {
      if (key.endsWith(".context_length") && typeof value === "number") {
        contextWindow = value;
        break;
      }
    }

    const parameterSize = res.details?.parameter_size ?? null;

    return {
      id: name,
      displayName: name,
      contextWindow,
      parameterSize,
      capabilities: res.capabilities ?? [],
      tier: inferTier(parameterSize, "ollama"),
    };
  }

  async getModel(name: string): Promise<ModelInfo | undefined> {
    const cached = this.modelCache.get(name);
    if (cached) return cached;
    try {
      const info = await this.showModel(name);
      this.modelCache.set(name, info);
      return info;
    } catch {
      return undefined;
    }
  }

  async generate(params: GenerateParams): Promise<GenerateResult> {
    const started = Date.now();

    const body: Record<string, unknown> = {
      model: params.model,
      stream: false,
      messages: [
        { role: "system", content: params.systemPrompt },
        { role: "user", content: params.userPrompt },
      ],
      options: {
        temperature: params.temperature,
        // これを指定しないとOllamaは既定の短いコンテキストで動き、
        // 入力が黙って切り捨てられる。長文処理では必須。
        num_ctx: params.numCtx ?? 8192,
      },
    };

    if (params.jsonSchema) {
      // Ollamaの構造化出力。スキーマを渡すとJSON形式を強制できる
      body.format = params.jsonSchema;
    }
    if (params.disableThinking) {
      body.think = false;
    }

    let res: ChatResponse;
    try {
      res = await this.fetchJson<ChatResponse>(
        "/api/chat",
        body,
        this.requestTimeoutMs,
        params.signal
      );
    } catch (e) {
      if (e instanceof AIError) throw e;
      throw new AIError(String(e), "unknown");
    }

    if (!isChatResponse(res)) {
      throw new AIError("Ollamaから形式が不正な応答が返りました。", "bad_response");
    }

    if (res.error) {
      if (/not found|no such model/i.test(res.error)) {
        throw new AIError(
          `モデル「${params.model}」が見つかりません。`,
          "model_not_found",
          res.error
        );
      }
      throw new AIError(res.error, "bad_response", res.error);
    }

    // 珍しい漢字が `<0xE5><0x9B><0xAE>` のようなバイト表記のまま
    // 返ることがある（実データで「囮」がそうなっていた）。
    // ここで戻さないと、そのまま資料ファイルへ保存されてしまう
    const raw = res.message?.content ?? "";
    const text = decodeByteFallback(raw);
    const repaired = countByteFallback(raw);
    if (repaired > 0) {
      logLine(`バイト表記のまま返った文字を ${repaired} 箇所戻しました。`);
    }
    if (!text.trim()) {
      throw new AIError(
        "AIから空の応答が返りました。",
        "bad_response",
        JSON.stringify(res).slice(0, 500)
      );
    }

    return {
      text,
      thinking: res.message?.thinking,
      usage: {
        inputTokens: res.prompt_eval_count ?? 0,
        outputTokens: res.eval_count ?? 0,
      },
      truncated: res.done_reason === "length",
      elapsedMs: Date.now() - started,
    };
  }

  private async fetchJson<T>(
    path: string,
    body?: unknown,
    timeoutMs = 30000,
    externalSignal?: AbortSignal
  ): Promise<T> {
    const controller = new AbortController();
    let abortSource: "caller" | "timeout" | undefined;
    const abort = (source: "caller" | "timeout") => {
      if (abortSource !== undefined) return;
      abortSource = source;
      controller.abort();
    };
    const timer = setTimeout(() => abort("timeout"), timeoutMs);
    const onExternalAbort = () => abort("caller");
    if (externalSignal?.aborted) {
      onExternalAbort();
    } else {
      externalSignal?.addEventListener("abort", onExternalAbort);
    }

    try {
      const response = await fetch(`${this.endpoint}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        if (response.status === 404) {
          throw new AIError("モデルが見つかりません。", "model_not_found", detail);
        }
        throw new AIError(
          `Ollamaがエラーを返しました (HTTP ${response.status})`,
          "bad_response",
          detail.slice(0, 500)
        );
      }

      try {
        return (await response.json()) as T;
      } catch (e) {
        if (e instanceof Error && e.name === "AbortError") throw e;
        throw new AIError("Ollamaから形式が不正な応答が返りました。", "bad_response");
      }
    } catch (e) {
      if (e instanceof AIError) throw e;
      const err = e as Error;
      if (err.name === "AbortError") {
        if (abortSource === "caller") {
          throw new AIError("処理が中止されました。", "aborted");
        }
        throw new AIError(
          `Ollamaの応答がタイムアウトしました（${Math.round(
            timeoutMs / 1000
          )}秒）。モデルが大きい場合は設定でタイムアウトを延ばしてください。`,
          "timeout"
        );
      }
      // 接続拒否・名前解決失敗はサーバ未起動とみなす
      throw new AIError(
        `Ollamaに接続できません（${this.endpoint}）`,
        "not_running",
        err.message
      );
    } finally {
      clearTimeout(timer);
      externalSignal?.removeEventListener("abort", onExternalAbort);
    }
  }
}
