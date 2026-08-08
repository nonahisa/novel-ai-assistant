/** 対応プロバイダ */
export type ProviderId = "ollama" | "gemini" | "claude" | "openai";

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
  /**
   * モデルが返せる出力トークンの上限。取得できなければ undefined。
   * 設定値がこれを超える場合に丸めるために使う。
   */
  maxOutputTokens?: number;
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
  /**
   * 呼び出すたびに課金されるか。
   * 実行前の確認で処理量とコストを示すかどうかの判断に使う。
   */
  readonly isPaid: boolean;
  /** 呼び出せる状態か（APIキー設定済み、サーバ起動済みなど） */
  isConfigured(): Promise<boolean>;
  testConnection(): Promise<ConnectionTestResult>;
  listModels(): Promise<ModelInfo[]>;
  generate(params: GenerateParams): Promise<GenerateResult>;
  /**
   * 1件だけ取得する。一覧を引かずに済むプロバイダは実装する。
   * 未実装なら呼び出し側が listModels から探す。
   */
  getModel?(id: string): Promise<ModelInfo | undefined>;
}

/** APIキーの入力欄に出す案内。プロバイダごとに発行元が違うため各自で持つ */
export interface ApiKeyHelp {
  title: string;
  prompt: string;
  placeHolder: string;
  /** 形式が明らかに違うキーを弾く。問題なければ undefined */
  validate(value: string): string | undefined;
}

/** APIキーを要するプロバイダ */
export interface ApiKeyProvider extends AIProvider {
  readonly apiKeyHelp: ApiKeyHelp;
  getApiKey(): Promise<string | undefined>;
  setApiKey(key: string): Promise<void>;
  clearApiKey(): Promise<void>;
}

/**
 * APIキーの最低限の検査。
 *
 * **接頭辞（`sk-` や `AIza` など）では判定しない。**
 * 各社はキーの形式を予告なく変えるため、正しいキーを弾いてしまう。
 * 実際にGoogleがAI Studioのキーを `AIza` から `AQ.` 系へ変えたとき、
 * 接頭辞を必須にしていたせいで登録できなくなった。
 *
 * 形式が正しいかどうかは、接続テストが実際にAPIを叩いて確かめる。
 * 誤って弾くと拡張機能がまったく使えなくなるのに対し、
 * 誤って通しても接続テストが理由を示して止まるだけで済む。
 */
export function validateApiKeyFormat(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return "APIキーを入力してください。";
  if (/\s/.test(trimmed)) {
    return "APIキーの途中に空白や改行が混ざっています。貼り付け直してください。";
  }
  return undefined;
}

export function isApiKeyProvider(
  provider: AIProvider
): provider is ApiKeyProvider {
  return (
    typeof (provider as Partial<ApiKeyProvider>).getApiKey === "function" &&
    typeof (provider as Partial<ApiKeyProvider>).setApiKey === "function"
  );
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
      | "authentication_failed"
      | "permission_denied"
      /**
       * 残高・クレジット切れ。
       * レート上限と違って待っても回復せず、権限の問題とも直し方が違うので分ける。
       */
      | "insufficient_credit"
      | "rate_limited"
      | "aborted"
      | "unknown",
    readonly detail?: string,
    /**
     * サーバーが指定した再試行までの待ち時間（ミリ秒）。
     * レート上限のときだけ入る。無料枠は上限が低く、
     * これを守って待てば続行できることが多い。
     */
    readonly retryAfterMs?: number
  ) {
    super(message);
    this.name = "AIError";
  }
}

/** 失敗種別ごとに、作者が次に行える具体的な操作を1つ返す。 */
export function recoveryForAIError(error: AIError): string {
  switch (error.kind) {
    case "not_running":
      return "AIを起動し、接続先設定を確認してください。";
    case "model_not_found":
      return "利用可能なモデルを選び直してください。";
    case "timeout":
      return "チャンクを小さくして、もう一度実行してください。";
    case "bad_response":
      return "出力上限とモデル設定を確認してください。";
    // どのプロバイダーでも出る案内なので、特定のサービス名を書かない。
    // 実際に使っているのがGeminiのときに「Claudeの…」と出て混乱させた
    case "authentication_failed":
      return "APIキーを確認して再登録してください。";
    case "permission_denied":
      return "APIキーの利用権限または請求設定を確認してください。";
    case "insufficient_credit":
      return "利用しているAIサービスの請求画面で、クレジットを購入してください。";
    case "rate_limited":
      return "しばらく待ってから、必要な場合に手動で再実行してください。";
    case "aborted":
      return "必要なら抽出をもう一度実行してください。";
    case "unknown":
      return "AI設定と拡張機能のログを確認してください。";
  }
}
