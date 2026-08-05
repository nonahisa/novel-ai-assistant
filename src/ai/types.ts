/** 対応プロバイダ */
export type ProviderId = "ollama" | "gemini" | "claude";

/** モデルの能力ティア。プロンプトとチャンクサイズの自動調整に使う */
export type CapabilityTier = "high" | "standard" | "light";

export interface ModelInfo {
  /** Ollamaなら "gemma4:e4b" のようなタグ */
  id: string;
  displayName: string;
  /** モデルが宣言するコンテキスト長（トークン） */
  contextWindow: number;
  /** パラメータ数の表記（"8.0B" など）。取得できなければ null */
  parameterSize: string | null;
  /** ツール呼び出し・思考モードなどの対応状況 */
  capabilities: string[];
  tier: CapabilityTier;
}

export interface GenerateParams {
  systemPrompt: string;
  userPrompt: string;
  model: string;
  temperature: number;
  /** 実際に使うコンテキスト長。Ollamaでは num_ctx として渡す */
  numCtx?: number;
  /** JSON構造化出力のスキーマ。指定するとその形式を強制する */
  jsonSchema?: object;
  /** 思考モード対応モデルで思考を無効化するか */
  disableThinking?: boolean;
  signal?: AbortSignal;
}

export interface GenerateResult {
  text: string;
  /** 思考モードの出力（あれば） */
  thinking?: string;
  usage?: { inputTokens: number; outputTokens: number };
  /** 応答が長さ上限で打ち切られた場合 true */
  truncated: boolean;
  /** 所要時間（ミリ秒） */
  elapsedMs: number;
}

export interface ConnectionTestResult {
  ok: boolean;
  message: string;
  /** 疎通できた場合、取得できたモデル数 */
  modelCount?: number;
}

export interface AIProvider {
  readonly id: ProviderId;
  readonly displayName: string;
  /** 呼び出せる状態か（APIキー設定済み、サーバ起動済みなど） */
  isConfigured(): Promise<boolean>;
  testConnection(): Promise<ConnectionTestResult>;
  listModels(): Promise<ModelInfo[]>;
  generate(params: GenerateParams): Promise<GenerateResult>;
}

/** パラメータ数からティアを推定する */
export function inferTier(
  parameterSize: string | null,
  providerId: ProviderId
): CapabilityTier {
  // クラウドの主力モデルは high 扱い
  if (providerId !== "ollama") return "high";

  if (!parameterSize) return "light";
  const m = parameterSize.match(/([\d.]+)\s*([BM])/i);
  if (!m) return "light";
  const value = parseFloat(m[1]);
  const billions = m[2].toUpperCase() === "B" ? value : value / 1000;

  // ローカルモデルは同じパラメータ数でもクラウドより控えめに見積もる
  if (billions >= 27) return "high";
  if (billions >= 7) return "standard";
  return "light";
}

/** AI呼び出しの失敗を表す。UI側でメッセージを出し分けるために種別を持つ */
export class AIError extends Error {
  constructor(
    message: string,
    readonly kind:
      | "not_running"
      | "model_not_found"
      | "timeout"
      | "bad_response"
      | "aborted"
      | "unknown",
    readonly detail?: string
  ) {
    super(message);
    this.name = "AIError";
  }
}
