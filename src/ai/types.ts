/** 対応プロバイダ */
export type ProviderId =
  | "ollama"
  /** LM Studio（手元のPC。OpenAI互換の口） */
  | "lmstudio"
  | "gemini"
  | "claude"
  | "openai"
  | "sakura";

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
  /**
   * モデルが対応できる最大のコンテキスト長。**表示にだけ使う。**
   *
   * `contextWindow`（＝本文の分割に使う値）には入れない。まだ読み込んで
   * いないモデルを実際より大きく見積もると、入力が黙って切り捨てられる。
   * いまのところLM Studioだけが入れる（ほかは undefined のまま）。
   */
  maxContextWindow?: number;
  /**
   * いま読み込まれているか。分からなければ undefined。
   *
   * LM Studioは読み込んでいないモデルも一覧に返すため、
   * 「これから読み込む」ことを選ぶ前に伝えたい。
   */
  loaded?: boolean;
}

export interface GenerateParams {
  systemPrompt: string;
  userPrompt: string;
  model: string;
  temperature: number;
  /** 実際に使うコンテキスト長。Ollamaでは num_ctx として渡す */
  numCtx?: number;
  /**
   * 思考が流れてくるたびに呼ばれる（設計書6.63.2）。
   *
   * **相談パネルのためにある。** 大きく開いた画面で長い相談をすると、
   * 答えが返るまで**何も起きない時間**が続く。思考を流せば、
   * 少なくとも「動いている」ことと「何を考えているか」が見える。
   *
   * **流して受け取る道でしか呼ばれない。** まとめて受け取る形では、
   * 応答が全部そろってから届くので「流す」余地が無い。
   * したがっていまは開発ビルド限定の実験（`ollamaStream.ts`）である。
   *
   * **本文（`content`）は流さない。** 途中まで見せると、作者が
   * 書きかけの答えを読んで動いてしまう。答えは揃ってから出す。
   */
  onThinking?: (delta: string) => void;
  /**
   * この呼び出しで**実際に上限として送る**トークン数（設計書6.77の第2段）。
   *
   * Ollama以外の5プロバイダは、これを `max_tokens` 等としてそのまま送る
   * （渡されなければグローバル設定 `novelai.maxOutputTokens`）。
   * **Ollamaだけは上限を掛けない**（設計書6.58.2。長い応答が途中で切れると
   * 抽出のJSONが解析できず、そのチャンクが丸ごと捨てられる）。
   *
   * **「見込み」と混ぜないこと。** 場所の確保に見込む量は
   * `plannedOutputTokens` である。同じ欄を両方に使うと、確保を小さくする
   * つもりの値がそのまま実際の上限になり、応答が切れる
   * （0.32.11で一度そうなった）。
   *
   * 送る直前の関所（`ai/contextGuard.ts`）は、まずこの値で判断する。
   */
  maxOutputTokens?: number;
  /**
   * この呼び出しの応答に**見込む**トークン数（設計書6.77の第2段）。
   *
   * **場所を空けるためだけの値である。上限として送らない。**
   * Ollamaの `num_ctx` の確保と、関所の見込みのフォールバックに使う。
   *
   * **`numCtx` を渡さない呼び出しのためにある。** 出力の量は機能によって
   * 桁が違い（あらすじは短く、抽出は長い）、呼び出し側にしか分からない。
   * 渡さなければ `OUTPUT_RESERVE_TOKENS`（`ai/contextGuard.ts`）で見込む。
   *
   * 台帳に実測があれば、それより多くは書けないと分かっているので、
   * 実測ぶんだけ確保すればよい（`resolveOutputTokensForPlanning`）。
   * **非力な機械では、この差がそのまま無駄なメモリになる。**
   */
  plannedOutputTokens?: number;
  /** JSON構造化出力のスキーマ。指定するとその形式を強制する */
  jsonSchema?: object;
  /** 思考モード対応モデルで思考を無効化するか */
  disableThinking?: boolean;
  /**
   * 流して受け取る道（設計書6.63.1）を使わせないか。
   *
   * **測定は配布と同じ受け取り方で行う。** 流し受信は**断片が届くたびに
   * 待ち時間を数え直す**ので、生成が進んでいる限り切れない——相談用には
   * それが正しいが、測定にとっては致命的である。書ける量の測定
   * （`features/measureContext.ts`）は数千行の列挙を頼むため、モデルが
   * 繰り返しに崩れて延々と書き続けると**永遠に時間切れにならず、測定が
   * 終わらない**（作者の報告「F5でAIチューニングが終わりません」
   * 2026-09-03）。測定は時間切れを「その量は書けない」と数えて前へ進む
   * 設計（`core/outputProbe.ts`）なので、**絶対の締め切りが要る。**
   *
   * 理由はもう1つある。**測るのは本番の道の性能でもある。** 開発ビルドで
   * だけ通る実験の道で測った値を、配布物が使う道の設定として台帳
   * （`core/modelTuning.ts`）へ書くのは筋が通らない。
   *
   * **流す道を持たないプロバイダは無視してよい**（見るのは
   * `ai/ollamaProvider.ts` だけ）。
   */
  disableStreaming?: boolean;
  /**
   * `maxOutputTokens` を、実際に上限として送るか（設計書6.65.14の4）。
   *
   * **既定（false/未指定）では送らない。** 出力上限を掛けない方針
   * （作者の判断、2026-09-01。`ai/ollamaProvider.ts` のコメントに理由がある）
   * はここでは変えない——長い応答が途中で切れると、抽出のJSONが
   * 解析できずそのチャンクが丸ごと捨てられる。
   *
   * **`true` にしてよいのは「書ける量」の測定だけ**（`features/measureContext.ts`
   * の `measureOutputLimit`）。設定値を超えて書けても測定の役には立たず、
   * 実測（25分かかった回が10分以上縮んだ）では待ち時間の無駄のほうが大きい。
   *
   * **見るのは `ai/ollamaProvider.ts` だけでよい。** ほかのプロバイダは
   * もともと `maxOutputTokens` を送信時の上限として渡しているので、
   * この旗が無くても同じ効果になる。
   */
  capOutputTokens?: boolean;
  signal?: AbortSignal;
  /**
   * この呼び出しが何であるか。**AIへは送らない。**
   *
   * 送信量の記録（`core/usageLog.ts`）に使う。プロバイダの実装は
   * これを無視してよい（見ているのは `ai/meteredProvider.ts` だけ）。
   *
   * **送るものと、送らないものを同じ型に入れている。** 分けると、
   * 呼び出し側が2つの引数を持ち回ることになり、10か所ある呼び出しの
   * どれかで付け忘れる。付け忘れても動くもの（記録）は、
   * 付け忘れに気づけない。
   */
  meta?: GenerateMeta;
}

/** 送信量の記録に添える情報。AIへは送らない */
export interface GenerateMeta {
  /**
   * どの機能の呼び出しか。
   * **`core/chunkCache.ts` の feature 名と揃える**（同じものを2通りに
   * 呼ぶと、記録とキャッシュを突き合わせられなくなる）。
   */
  feature: string;
  /**
   * 記録先を決める作品フォルダ（`WorkEntry.folderPath`）。
   *
   * **無ければ記録しない。** 作品に属さない呼び出し（接続確認など）を
   * どこかの作品のログへ書くと、その作品の数字が狂う。
   */
  workFolder?: string;
  /**
   * 送ったものの内訳（字数）。「本文」「設定資料」「指示」など。
   *
   * 組み立て済みの文字列からは内訳が取れないので、材料を積む側から渡す。
   * **省いてよい。** そのときは合計だけが記録される。
   */
  parts?: Record<string, number>;
}

export interface GenerateResult {
  text: string;
  /** 思考モードの出力（あれば） */
  thinking?: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    /**
     * 入力のうち、プロンプトキャッシュから読めた分。
     *
     * **対応していないAI（Ollama等）では undefined。** 0と区別する
     * ——0は「対応しているが、今回は効かなかった」の意味に取っておく。
     * 両方を0にまとめると、「そもそも数えられないAI」なのか
     * 「数えたうえで効いていない」のかが記録から読めなくなり、
     * 効かせる工夫の前後を比べられない。
     */
    cachedInputTokens?: number;
  };
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
  /**
   * 渡された出力上限（`GenerateParams.maxOutputTokens`）を、**実際に
   * APIへ送るか**（設計書6.77の第2段）。**無指定は「送る」扱い。**
   *
   * 送る直前の関所（`ai/meteredProvider.ts`）が、見込みと実上限の
   * どちらで場所を数えるかを、これで決める。
   *
   * **`false` なのはOllamaだけである。** あちらは `num_predict` を送らず
   * （設計書6.58.2）、代わりに `num_ctx` を見込みぶんだけ確保するので、
   * **実際に場所を食うのは見込みのほう**になる。
   *
   * **プロバイダIDで分岐しないために置いている。** LM Studio のように
   * Ollama互換の口を持つものがあり、名前は当てにならない。
   */
  readonly capsOutput?: boolean;
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
      /**
       * モデルを読み込めなかった。
       *
       * 手元で動くAI（LM Studio）で、要求したモデルがメモリに載らないときに
       * 起きる。**理由はAI側が具体的に教えてくれる**（「約44.87GB必要で、
       * 続けると固まる見込みなので止めた」など）ので、`bad_response` に
       * 丸めずに分け、その説明をそのまま作者へ届ける。
       */
      | "model_load_failed"
      /**
       * 送るものがモデルの上限に入らない（設計書6.27.10）。
       *
       * **送る前に分かる**唯一の失敗である。Ollama は上限を超えた入力を
       * エラーにせず**黙って切り捨てる**ので、切り捨てられたことは
       * 「AIが本文の後半を読んでいない」という形でしか現れない。
       * 送る前に止めて、必要量と上限を作者へ見せる。
       */
      | "context_overflow"
      | "rate_limited"
      | "aborted"
      | "unknown",
    readonly detail?: string,
    /**
     * サーバーが指定した再試行までの待ち時間（ミリ秒）。
     * レート上限のときだけ入る。無料枠は上限が低く、
     * これを守って待てば続行できることが多い。
     */
    readonly retryAfterMs?: number,
    /**
     * サーバーが返したHTTPの状態番号。HTTPを介した失敗のときだけ入る。
     *
     * **`message` から読み取らない。** かつては `(HTTP 400)` という
     * 通知文を正規表現で拾っていたが、あれは**作者に見せる文**であって
     * 機械が読む場所ではない。文言を直した瞬間に、上限超えの判定
     * （`openaiProvider.ts` の `asContextOverflowError`）が黙って
     * 効かなくなる（0.28.4）。
     */
    readonly status?: number
  ) {
    super(message);
    this.name = "AIError";
  }
}

/**
 * 待っても直らない失敗か。**残りのチャンクを試すだけ無駄になる**もの。
 *
 * チャンク単位の失敗で全体を止めないのが原則だが（CLAUDE.md 実装スタイル）、
 * **それはチャンクの中身が原因の失敗に向けた原則**である。ここに並ぶのは
 * どのチャンクでも同じように起きる「環境側の失敗」で、続けても同じ失敗を
 * 積むだけになる。
 *
 * **実際に起きた**（2026-08-30の作者のログ）。載らない大きさのモデルを
 * 選んだまま伏線の回収確認を回し、**9チャンクすべてが同じ
 * `model_load_failed` で失敗**していた。1回目で止めて理由を1つ出すほうが、
 * 同じ失敗を9つ並べるより作者の手がかりになる。
 *
 * ここを増やすときは「作者が何かを直すまで、次のチャンクでも必ず同じに
 * なるか」で判断する。**`timeout` と `not_running` は入れない**——一時的な
 * ことがあり、`isConnectivityFailure` の側で回数を数えて扱う。
 */
export function isFatalProviderFailure(kind: AIError["kind"]): boolean {
  return (
    kind === "authentication_failed" ||
    kind === "permission_denied" ||
    kind === "insufficient_credit" ||
    // モデルが載らないのも同じ。実行中にLM Studio側で外れると起きる
    kind === "model_load_failed" ||
    kind === "rate_limited"
  );
}

/**
 * 繋がらなかっただけの失敗か。一時的なことがあるので、
 * 続けて何回起きたかを数えて判断する（数える側は呼び出し元）。
 */
export function isConnectivityFailure(kind: AIError["kind"]): boolean {
  return kind === "not_running" || kind === "timeout";
}

/** 失敗種別ごとに、作者が次に行える具体的な操作を1つ返す。 */
export function recoveryForAIError(error: AIError): string {
  switch (error.kind) {
    case "not_running":
      return "AIを起動し、接続先設定を確認してください。";
    case "model_not_found":
      return "利用可能なモデルを選び直してください。";
    case "timeout":
      // 待ち時間の設定を先に出す。チャンクを小さくすると呼び出し回数が増え、
      // クラウドAIでは料金も増える。まず待つほうが害が少ない。
      //
      // **どこを触ればよいかまで言う。** 「設定で」だけでは設定画面の
      // どの項目か分からない（項目名は日本語で出る。設定キーはAIごとに
      // 違うので、サービス名を決め打ちしないためにも名前で案内する）。
      // 実測ではこの作品の応答は中央34秒・90%点124秒で、既定の180秒に
      // 余裕が無かった（作者のログ、2026-08-29）。0.28.9
      //
      // **秒数を自分で当てなくてよい道も示す**（作者の要望、2026-08-30）。
      // 何秒あれば足りるかは、モデルと本文の長さで変わる——測れば分かる
      // ものを作者に当てさせない（設計書6.49）。**サービス名は書かない**ので、
      // 料金の断りも「有料のAIでは」という言い方に留める
      //
      // **既定を「180秒」と断定しない。** Claudeだけ300秒なので、
      // Claudeを使っている作者には事実と違う案内になる。サービス名を
      // 書かない方針なので、幅で言う
      return (
        "拡張機能の設定で、お使いのAIの「タイムアウト」の秒数を延ばしてください" +
        "（既定は180秒。AIによっては300秒です。長い本文では足りないことがあります）。" +
        "それでも切れるなら「1チャンクの文字数」を小さくしてください。" +
        "「AIチューニング」を実行すると、このモデルに合った待ち時間を測って設定できます" +
        "（AIを呼ぶので、有料のAIでは料金がかかります）。"
      );
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
    // **「小さいモデルを選べ」だけにしない。** いま使いたいモデルを諦める
    // ほかに手が無いように見えるが、実際には文脈を短くすれば載ることが多い。
    //
    // **サービス名は書かない。** 以前はLM Studio決め打ちで、設定名まで
    // 出していた。Ollamaも同じ種別を返すようになり（作者の報告、2026-08-30。
    // 19GBのモデルで `error loading model`）、Ollamaを使っているのに
    // 「LM Studioの設定で…」と出る状態だった。サービスごとの具体策は、
    // 投げる側が `message` に添える（LM Studio は
    // `lmstudioLauncher.ts` の `LOAD_CONTEXT_SETTING_HINT`）
    case "model_load_failed":
      return (
        "より小さいモデルを選ぶか、読み込むときの文脈の長さを短くしてください。" +
        "ほかのアプリを閉じてメモリを空けると載ることもあります。"
      );
    // 直せる手が3つある（本文の量・モデル・資料の量）ので、全部並べる。
    // どれも作者が自分で操作できるものである
    case "context_overflow":
      return (
        "本文を小さく分けるか、大きいモデルを選んでください。" +
        "参照資料を減らす設定も効きます。"
      );
    case "rate_limited":
      return "しばらく待ってから、必要な場合に手動で再実行してください。";
    case "aborted":
      return "必要なら抽出をもう一度実行してください。";
    case "unknown":
      return "AI設定と拡張機能のログを確認してください。";
  }
}
