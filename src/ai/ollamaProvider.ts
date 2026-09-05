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
import { contextSizeForPrompt } from "../core/chunker";
import { describeFetchFailure, isFetchTimeout } from "./httpClient";
import {
  applyStreamLine,
  emptyStreamedChat,
  streamingEnabled,
  takeCompleteLines,
} from "./ollamaStream";
// 出力の見込みは**関所と同じ値**を使う（設計書6.27.10）。ここだけ別の値を
// 持つと「関所は通ったのに num_ctx が足りない」という食い違いになる
import { OUTPUT_RESERVE_TOKENS } from "./contextGuard";
import { logLine } from "../core/logger";
import { withAiWork } from "../core/aiActivity";
import { resolveTimeoutMs } from "../core/modelTuning";

const DEFAULT_ENDPOINT = "http://localhost:11434";

/**
 * モデル情報が取れなかったときのコンテキスト長。
 *
 * `/api/show` が失敗すると必要量を計算しても頭打ちの根拠が無い。
 * ここを従来の既定値と同じにしておけば、**取れないときは従来と同じ
 * 8192 に落ちるだけで、いまより悪くはならない。**
 */
const UNKNOWN_CONTEXT_WINDOW = 8192;

/**
 * 作者が明示した `num_ctx`（設計書6.58）。指定が無ければ undefined。
 *
 * **読むのはここだけにする。** 以前は誤字脱字・抽出・設定パネルの3か所が
 * それぞれ同じ数行を持っており、**AIを呼ぶ17か所のうち3か所でしか
 * 指定が効いていなかった**。作者から見れば「設定したのに効く機能と
 * 効かない機能がある」という状態で、理由を説明できない
 * （`chunkChars` で同じことが起きている。6.23）。
 *
 * **0は「指定なし」。** 設定の説明にそう書いてあり、既定値でもある。
 */
export function configuredNumCtx(): number | undefined {
  const configured = vscode.workspace
    .getConfiguration("novelai")
    .get<number>("ollama.numCtx", 0);
  return configured > 0 ? configured : undefined;
}

/**
 * このモデルの実効の上限（設計書6.58.4）。
 *
 * **作者が `num_ctx` を決めているなら、それがこのモデルの上限である。**
 * 申告値をそのまま配ると、**送る直前の関所が見ている上限と、実際に送る
 * `num_ctx` が食い違う**——関所は申告の262,144と比べて「入る」と言うのに、
 * Ollamaへは指定の8,192で送るので、**入力が黙って切り捨てられる**
 * （0.22.14で塞いだのと同じ穴）。
 *
 * ここで1つにしておけば、**関所・チャンクの分割・送信の3つが揃う**。
 *
 * **指定のほうが大きいときは、申告値を超えない。** モデルが読めない量を
 * 「読める」と扱っても、切り捨てられるだけである。
 */
export function effectiveContextWindow(
  declared: number,
  configured: number | undefined
): number {
  if (configured === undefined || !Number.isFinite(configured)) return declared;
  if (configured <= 0) return declared;
  return Math.min(declared, configured);
}

interface TagsResponse {
  models?: Array<{
    name: string;
    size?: number;
    details?: { parameter_size?: string; quantization_level?: string };
    /** 新しい版の Ollama は一覧にも入れてくる。無い版もある */
    capabilities?: string[];
  }>;
}

/**
 * その応答が「モデルを載せられなかった」ものか。
 *
 * 作者の報告（2026-08-30）：19GBの `gemma4:26b` で読める長さを測ろうとして
 * HTTP 500 と
 * `llama-server process has terminated: … failed to initialize the context: …
 * error loading model: vector` が返り、`bad_response` に丸められた結果、
 * 「出力上限とモデル設定を確認してください」という的外れな案内が出た。
 * 実際に要るのは「小さいモデルにする・文脈を短くする・メモリを空ける」である。
 *
 * **見るのは「読み込みに失敗した」と名指ししている定型文だけ**にする。
 * 原因（メモリ・壊れた重み・非対応）まで当てにいかない（CLAUDE.md 規則5）。
 * 詳しい理由はOllamaが本文に書いてくるので、`detail` に載せてログへ流す。
 */
export function isModelLoadFailure(detail: string): boolean {
  return [
    /error loading model/i,
    /failed to initialize the context/i,
    /llama_init_from_model/i,
    /llama-server process has terminated/i,
    /unable to load model/i,
    /requires more system memory/i,
  ].some((pattern) => pattern.test(detail));
}

/**
 * 生成に使えるモデルか。**埋め込み用のモデルを一覧に出さない**
 * （作者の報告「bge-m3 が出るが選んでも使えない」2026-08-30）。
 *
 * `bge-m3` は意味検索の索引づくりに使うモデル（`ai/ollamaEmbedding.ts`）で、
 * 文章を書かせても返らない。選べてしまうと、選んだあとで初めて失敗する。
 *
 * **判定は `capabilities` を主にする。** 生成できるモデルには必ず
 * `completion` が入る（実測、2026-08-30：qwen3・gemma3・gemma4 はすべて
 * `completion` を含み、`bge-m3` は `["embedding"]` だけ）。**モデル名を
 * 並べた一覧にはしない**——新しいモデルが次々出るため（CLAUDE.md 規則6）。
 *
 * `capabilities` が取れないとき（古い版・`/api/show` が失敗したとき）だけ、
 * **用途を表す語**で落とす。判断が付かないものは残す——一覧に余分が出る害より、
 * 使えるモデルが消える害のほうが大きい。
 */
export function isGenerationModel(
  name: string,
  capabilities: readonly string[] | undefined
): boolean {
  if (capabilities && capabilities.length > 0) {
    return capabilities.includes("completion");
  }
  return !/embed|rerank/i.test(name);
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
  /**
   * **出力に上限を掛けない**（設計書6.58.2）。`num_predict` を送らず、
   * `num_ctx` を見込みぶんだけ確保する——だから関所も、実上限ではなく
   * 見込みで場所を数える（設計書6.77の第2段）。
   */
  readonly capsOutput = false;

  /** モデル詳細のキャッシュ。/api/show は毎回呼ぶと重いため */
  private modelCache = new Map<string, ModelInfo>();

  private get endpoint(): string {
    const raw = vscode.workspace
      .getConfiguration("novelai")
      .get<string>("ollama.endpoint", DEFAULT_ENDPOINT);
    return raw.replace(/\/+$/, "");
  }

  /**
   * 1回の呼び出しで待つミリ秒。
   *
   * **AIチューニングの台帳を先に見る**（設計書6.49）。同じOllamaでも
   * 3Bと26Bでは応答にかかる時間がまるで違うので、プロバイダ単位の
   * 設定1つでは、どちらかが必ず切れる。台帳に無ければ従来どおり設定を読む。
   */
  private requestTimeoutMs(model: string): number {
    return resolveTimeoutMs(this.id, model, 180);
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

    const infos: ModelInfo[] = [];
    for (const entry of tags.models ?? []) {
      const name = entry.name;
      // **一覧に出さないと分かったら `/api/show` を呼ばない。**
      // 新しい版の Ollama は `/api/tags` にも `capabilities` を入れるので、
      // 埋め込みモデルのぶん往復が1回減る
      if (entry.capabilities && !isGenerationModel(name, entry.capabilities)) {
        continue;
      }

      const cached = this.modelCache.get(name);
      if (cached) {
        // キャッシュには `getModel()` 経由でも入る。あちらは絞らないので、
        // 一覧へ出す前にここでも確かめる
        if (isGenerationModel(name, cached.capabilities)) infos.push(cached);
        continue;
      }
      try {
        const info = await this.showModel(name);
        // 詳細は覚えておく（`getModel()` が使う）が、一覧へは出さない
        this.modelCache.set(name, info);
        if (isGenerationModel(name, info.capabilities)) infos.push(info);
      } catch {
        // 詳細が取れなくても一覧からは落とさない。
        // ただし名前から用途が明らかなものは落とす
        if (!isGenerationModel(name, undefined)) continue;
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
      /*
        **作者が `num_ctx` を決めているなら、それがこのモデルの上限である**
        （設計書6.58.4）。

        申告値をそのまま返すと、**送る直前の関所が見ている上限と、実際に
        送る `num_ctx` が食い違う**。関所（`meteredProvider`）は申告値
        （たとえば262,144）と比べて「入る」と判断するのに、Ollamaへは
        作者の指定（たとえば8,192）で送るので、**入力が黙って切り捨てられる**
        ——0.22.14 で塞いだのと同じ穴である。

        チャンクの大きさもここから決まるので、絞れば送る量ごと縮む。
        **上限を1つにすれば、関所・分割・送信の3つが自動的に揃う。**
      */
      contextWindow: effectiveContextWindow(contextWindow, configuredNumCtx()),
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

  /**
   * 独り言（`core/chatter.ts`）が「いま話しかけてよいか」を見るので、
   * 依頼のあいだは仕事中の印を立てる。
   *
   * **Ollamaにだけ入れている。** 独り言は無料のローカルAIでしか動かさない
   * （有料のAIで勝手に課金しないため）ので、他のプロバイダでは要らない。
   */
  async generate(params: GenerateParams): Promise<GenerateResult> {
    return withAiWork(() => this.generateInner(params));
  }

  private async generateInner(
    params: GenerateParams
  ): Promise<GenerateResult> {
    const started = Date.now();

    // 呼び出し側が決めた値があればそれを使う。無ければ**送る文字列そのもの**から
    // 見積もる。以前はここを 8192 に固定しており、渡してこない11か所では
    // 入力が黙って切り捨てられていた（0.22.14で判明）。
    // `getModel` はキャッシュ済みなので、毎回 /api/show を叩くわけではない。
    //
    // **出力の見込みは呼び出し側にしか分からない**（あらすじは短く、抽出は
    // 長い）。渡されていればそれを使い、無ければ多めの既定で確保する
    const numCtx =
      params.numCtx ??
      // **作者の指定は、ここ1か所で受ける**（設計書6.58）。
      // 以前は誤字脱字・抽出・設定パネルの3か所が自前で
      // `novelai.ollama.numCtx` を読んでおり、**残る14の機能では
      // 指定が効いていなかった**。同じ設定が機能によって効いたり
      // 効かなかったりするのは、作者から見て理由が無い（6.23と同じ形）
      configuredNumCtx() ??
      contextSizeForPrompt({
        promptChars: params.systemPrompt.length + params.userPrompt.length,
        /*
          **見込み → 実上限 → 既定**の順で読む（設計書6.77の第2段）。

          確保に使うのは `plannedOutputTokens`（`min(設定, 実測 ?? 8,192)`）
          である。実上限（`maxOutputTokens`）のほうは、測っていないモデルでは
          設定値そのもの（既定16,384）なので、こちらで確保すると `num_ctx` が
          倍近くに育ち、非力な機械のメモリを食う——6.58.2で避けた副作用が
          そのまま戻る。

          実上限へ落ちるのは、見込みを渡してこない呼び出し（独り言の200など）
          のためである。どちらも無ければ従来どおり `OUTPUT_RESERVE_TOKENS`。
        */
        outputTokens:
          params.plannedOutputTokens ??
          params.maxOutputTokens ??
          OUTPUT_RESERVE_TOKENS,
        contextWindow:
          (await this.getModel(params.model))?.contextWindow ??
          UNKNOWN_CONTEXT_WINDOW,
      });

    // **どの長さで確保したかを残す。** これが記録に無かったせいで、
    // 「抽出中にコンソールが一瞬ずつ何度も出る」という報告（2026-08-30）の
    // 原因——`num_ctx` がチャンクごとに変わってモデルが読み込み直されていた
    // ——を、ログからは追えなかった（設計書6.53）
    logLine(
      `Ollama：num_ctx ${numCtx}（${params.model} / 送信 ${
        params.systemPrompt.length + params.userPrompt.length
      }字）`
    );

    const options: Record<string, unknown> = {
      temperature: params.temperature,
      /*
        **`num_predict` は送らない。出力に上限を掛けない**
        （作者の判断、2026-09-01。設計書6.58.2）。

        ほかの5つのプロバイダは `novelai.maxOutputTokens` を送信時の
        上限として渡すが、**Ollamaにだけは渡さない**。これは書き忘れでは
        なく、設定の説明にも「Ollamaへは送りません」と書いてある。

        **上限を掛けると、長い応答が途中で切れる。** 抽出の応答はJSONで、
        途中で切れると解析できず**そのチャンクは丸ごと捨てられる**
        （呼び出し1回ぶんが無駄になる）。手元のOllamaは呼ぶだけなら
        無料なので、クラウドのように「切ってでも節約する」理由が無い。

        `maxOutputTokens` は**確保するコンテキスト長の計算にだけ**使う
        （上の `numCtx`）。応答用に空けておく分であって、上限ではない。

        **測定だけは例外**（設計書6.65.14の4）。「書ける量」の測定
        （`features/measureContext.ts` の `measureOutputLimit`）は、
        設定値を超えて書けても測定の役には立たないうえ、繰り返しに崩れた
        モデルを待ち続ける害のほうが大きい。呼び出し側が
        `capOutputTokens: true` を立てたときだけ、下で `num_predict` を足す。
      */
      // これを指定しないとOllamaは既定の短いコンテキストで動き、
      // 入力が黙って切り捨てられる。長文処理では必須。
      num_ctx: numCtx,
    };
    if (params.capOutputTokens && params.maxOutputTokens !== undefined) {
      options.num_predict = params.maxOutputTokens;
    }

    const body: Record<string, unknown> = {
      model: params.model,
      stream: false,
      messages: [
        { role: "system", content: params.systemPrompt },
        { role: "user", content: params.userPrompt },
      ],
      options,
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
      /*
        **流して受け取る道は、開発ビルドでだけ通る**（設計書6.63.1）。

        `__DEV_HELPERS__` は本番ビルドで false に畳まれ、esbuild が
        この枝ごと落とす（`esbuild.js`）。作者がF5で確かめるための実験で、
        利用者へ出すのは「通信部品の待ち時間を明示する」ほう
        （`fetchTimeouts.ts`）である。

        **呼び出し側が断れる**（`disableStreaming`。2026-09-03）。流す道は
        断片が届くたびに待ち時間を数え直すので、**繰り返しに崩れて書き続ける
        モデルを永遠に待つ**。測定はそれでは終わらないので、絶対の締め切りの
        ある道（`fetchJson`）を通す。理由の詳しくは `ai/types.ts` にある。
      */
      res = __DEV_HELPERS__ && streamingEnabled() && !params.disableStreaming
        ? await this.streamChat(
            body,
            this.requestTimeoutMs(params.model),
            params.signal,
            params.onThinking
          )
        : await this.fetchJson<ChatResponse>(
            "/api/chat",
            body,
            this.requestTimeoutMs(params.model),
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

  /**
   * `/api/chat` を**流しながら**受け取る（設計書6.63.1。開発ビルド限定）。
   *
   * 受け取った断片を `ollamaStream.ts` が組み立て、`stream:false` の
   * 応答と同じ形（`ChatResponse`）にして返す。**呼ぶ側は違いを知らない。**
   *
   * **待ち時間の扱いが変わる。** ヘッダーは即座に届くので「ヘッダー待ち」の
   * 上限には当たらない。代わりに、**最後の断片が届いてからの間**を
   * こちらの待ち時間で見る——生成が続いている限り断片が流れてくるので、
   * 止まったときだけ切れる。
   */
  private async streamChat(
    body: Record<string, unknown>,
    timeoutMs: number,
    externalSignal?: AbortSignal,
    /** 思考が届くたびに呼ぶ。相談パネルが画面へ流す（設計書6.63.2） */
    onThinking?: (delta: string) => void
  ): Promise<ChatResponse> {
    const controller = new AbortController();
    let abortSource: "caller" | "timeout" | undefined;
    const abort = (source: "caller" | "timeout") => {
      if (abortSource !== undefined) return;
      abortSource = source;
      controller.abort();
    };
    // **断片が届くたびに数え直す。** 全体の上限にすると、長い生成が
    // まっとうに進んでいても途中で切ってしまう
    let timer = setTimeout(() => abort("timeout"), timeoutMs);
    const bump = () => {
      clearTimeout(timer);
      timer = setTimeout(() => abort("timeout"), timeoutMs);
    };
    const onExternalAbort = () => abort("caller");
    if (externalSignal?.aborted) onExternalAbort();
    else externalSignal?.addEventListener("abort", onExternalAbort);

    const started = Date.now();
    try {
      const response = await fetch(`${this.endpoint}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...body, stream: true }),
        signal: controller.signal,
      });
      if (!response.ok || !response.body) {
        throw new AIError(
          `Ollamaがエラーを返しました (HTTP ${response.status})。`,
          "bad_response"
        );
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const state = emptyStreamedChat();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bump();
        buffer += decoder.decode(value, { stream: true });
        const { lines, rest } = takeCompleteLines(buffer);
        buffer = rest;
        for (const line of lines) {
          const before = state.thinking ?? "";
          applyStreamLine(state, line);
          // **増えた分だけを渡す。** 全文を毎回渡すと、受け取る側が
          // 差分を計算する羽目になり、同じ理屈が2か所に散る
          const after = state.thinking ?? "";
          if (onThinking && after.length > before.length) {
            onThinking(after.slice(before.length));
          }
        }
      }
      /*
        **最後に取り込み器を空にする**（設計書6.63.1）。

        `decode(value, { stream: true })` は、**多バイト文字の途中で切れた
        バイトを内部に溜めて次へ持ち越す**。日本語は1文字3バイトなので、
        断片の境目が文字の途中に落ちるのはむしろ普通である。
        持ち越しの仕組みがあるおかげでそこは壊れないが、
        **最後に空にしないと、溜まったままの分が消える。**

        引数なしの `decode()` が、その持ち越しを吐き出す。
      */
      buffer += decoder.decode();
      // 最後の断片（改行で終わっていない場合）も取り込む
      applyStreamLine(state, buffer);

      logLine(
        `Ollama：流して受信（${Math.round((Date.now() - started) / 1000)}秒 / ` +
          `${state.content.length}字 / 出力 ${state.evalCount ?? "不明"}トークン）`
      );

      return {
        message: { content: state.content },
        done_reason: state.truncated ? "length" : "stop",
        error: state.error,
        eval_count: state.evalCount,
        prompt_eval_count: state.promptEvalCount,
      } as ChatResponse;
    } catch (error) {
      if (error instanceof AIError) throw error;
      const err = error as Error;
      if (err.name === "AbortError") {
        if (abortSource === "caller") {
          throw new AIError("処理が中止されました。", "aborted");
        }
        throw new AIError(
          `Ollamaの応答がタイムアウトしました（${Math.round(timeoutMs / 1000)}秒）。`,
          "timeout"
        );
      }
      throw new AIError(
        "Ollamaに接続できません。",
        "not_running",
        describeFetchFailure(error)
      );
    } finally {
      clearTimeout(timer);
      externalSignal?.removeEventListener("abort", onExternalAbort);
    }
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
          throw new AIError(
            "モデルが見つかりません。",
            "model_not_found",
            detail,
            undefined,
            response.status
          );
        }
        // **モデルを載せられなかったのは「応答の形が悪い」ではない。**
        // 直し方（小さいモデル・短い文脈・メモリを空ける）がまるで違う
        if (isModelLoadFailure(detail)) {
          throw new AIError(
            "Ollamaがモデルを読み込めませんでした。",
            "model_load_failed",
            detail.slice(0, 500),
            undefined,
            response.status
          );
        }
        throw new AIError(
          `Ollamaがエラーを返しました (HTTP ${response.status})`,
          "bad_response",
          detail.slice(0, 500),
          undefined,
          response.status
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
      // **Node自身の待ち時間切れは「未起動」ではない。** 起動を確かめても
      // 直らないので、案内が真逆になる
      if (isFetchTimeout(e)) {
        throw new AIError(
          "Ollamaの応答がタイムアウトしました。" +
            "待ち時間を延ばすか、一度に送る量を減らしてください。",
          "timeout",
          describeFetchFailure(e)
        );
      }
      // 接続拒否・名前解決失敗はサーバ未起動とみなす。
      // **符号まで残す**——「fetch failed」だけでは後から原因を追えない
      throw new AIError(
        `Ollamaに接続できません（${this.endpoint}）`,
        "not_running",
        describeFetchFailure(e)
      );
    } finally {
      clearTimeout(timer);
      externalSignal?.removeEventListener("abort", onExternalAbort);
    }
  }
}
