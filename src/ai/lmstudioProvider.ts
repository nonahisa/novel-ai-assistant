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
import {
  asContextOverflowError,
  isUnsupportedParameter,
} from "./openaiProvider";

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
 * ## コンテキスト長は、まずLM Studioに聞く
 *
 * LM Studioは**OpenAI互換ではない自前の口**（`/api/v0/models`）を持っており、
 * そこには**実際に読み込んだ長さ**（`loaded_context_length`）が入っている
 * （この機械の0.4.21で実測、2026-08-27）。読めたらそれを使う。
 *
 * 設定値（`novelai.lmstudio.contextWindow`）は作者が手で合わせるものなので、
 * 既定の8192のまま忘れられていると、131072で読み込んでいるのにモデル選択が
 * 「文脈 8k」と出る——**設定値を表示していただけ**だった（作者の報告、
 * 2026-08-27）。読めないとき（口が無い古い版、未読込のモデル）は、
 * これまでどおり設定値を使う。**取れなくても悪くはならない。**
 *
 * **`max_context_length` は使わない。** そちらはモデルが対応できる最大で、
 * 実際に何で読み込まれたかとは別物である。実際より大きい想定は
 * 「入力が黙って切り捨てられる」そのもので、エラーにならないぶん
 * 「AIが後半を読んでいない」という形でしか現れない。
 *
 * ## 大きさはモデル名から読む
 *
 * LM Studioが動かすのは**公開重みのモデル**で、名前に大きさが入っている
 * （`qwen3-30b-a3b` など）。Ollamaと同じ物差しで能力を見積もる。
 * **「手元で動く＝非力」でも「最新だから最上位」でもない。**
 */

/**
 * LM Studioの既定の接続先。
 *
 * **export しているのは、起動の導線（`features/aiConnectivity.ts`）が
 * 同じ値を要るため。** 写しを作ると、片方だけ直したときに
 * 「起動したポートと、話しかけるポートが違う」という形で表に出る。
 */
export const DEFAULT_ENDPOINT = "http://localhost:1234/v1";
const LABEL = "LM Studio";

/**
 * LM Studioの接続先。末尾の `/` は落とす。
 *
 * **読み方をここ1つに寄せている。** 起動の導線（`aiConnectivity.ts`）と
 * 導入案内（`setupLmStudio.ts`）とモデル読み込み（`lmstudioModelLoad.ts`）が
 * 同じ値を要る。写しを作ると、起動したポートと話しかけるポートが食い違う。
 */
export function lmstudioEndpoint(): string {
  const configured = vscode.workspace
    .getConfiguration("novelai")
    .get<string>("lmstudio.endpoint", DEFAULT_ENDPOINT)
    .trim();
  return (configured || DEFAULT_ENDPOINT).replace(/\/+$/, "");
}

interface ModelListResponse {
  data?: Array<{ id?: string; object?: string }>;
}

/**
 * native API（`/api/v0/models`）が返すモデル1件。
 *
 * 項目名はこの機械のLM Studio 0.4.21の実測に合わせてある。
 * **すべて任意にしてある**——版によって欠ける項目があっても、
 * 欠けたぶんだけ設定値へ落ちればよく、例外にはしない。
 */
interface NativeModelEntry {
  id?: string;
  /** `llm` / `vlm` / `embeddings` など */
  type?: string;
  /** `loaded` / `not-loaded` */
  state?: string;
  /** モデルが対応できる最大。**contextWindowには使わない**（冒頭の説明を参照） */
  max_context_length?: number;
  /** **いま読み込まれている長さ。** 読込済みのモデルにしか入らない */
  loaded_context_length?: number;
}

interface NativeModelListResponse {
  data?: NativeModelEntry[];
}

/**
 * そのモデルが「いま実際に読み込まれている長さ」。分からなければ undefined。
 *
 * **`max_context_length` へ落とさない。** 未読込のモデルに 262144 と書いて
 * あっても、読み込むときに何を指定されるかはこちらからは分からない。
 * 大きく見積もると入力が黙って切り捨てられるので、分からないときは
 * 呼び出し側で設定値（作者が申告した値）へ落とす。
 */
function loadedContextLength(
  entry: NativeModelEntry | undefined
): number | undefined {
  if (!entry || entry.state !== "loaded") return undefined;
  const length = entry.loaded_context_length;
  return typeof length === "number" && Number.isFinite(length) && length > 0
    ? length
    : undefined;
}

interface ChatResponse {
  choices?: Array<{
    message?: { content?: string | null };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    /**
     * プロンプトキャッシュの内訳（OpenAI互換の形）。
     *
     * **手元で動くので料金の意味は無い**が、返ってくるなら記録しておく
     * （効いていれば速さに出る）。返さなければ undefined のままになる。
     */
    prompt_tokens_details?: { cached_tokens?: number };
  };
}

export class LmStudioProvider implements AIProvider {
  readonly id = "lmstudio" as const;
  readonly displayName = "LM Studio（ローカル）";

  /** 手元で動くので課金されない。Ollamaと同じ扱い */
  readonly isPaid = false;

  private readonly modelCache = new Map<string, ModelInfo>();

  /**
   * native APIが読めなかったことを、もうログへ書いたか。
   *
   * **毎回は書かない。** 一覧を引くたびに同じ行が積み上がると、
   * ほかの失敗が埋もれる（この口が無い版では必ず失敗し続ける）。
   */
  private nativeFailureLogged = false;

  private get endpoint(): string {
    return lmstudioEndpoint();
  }

  private get contextWindow(): number {
    const configured = vscode.workspace
      .getConfiguration("novelai")
      .get<number>("lmstudio.contextWindow", 8192);
    return Number.isFinite(configured) && configured > 0 ? configured : 8192;
  }

  /**
   * native APIの場所。
   *
   * 設定に入っているのはOpenAI互換の口（`…/v1`）なので、**末尾の `/v1` を
   * 落として**同じサーバの別の口を組み立てる。作者に2つ目のURLを設定させない。
   */
  private get nativeModelsUrl(): string {
    return `${this.endpoint.replace(/\/v1$/, "")}/api/v0/models`;
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
    // 読み込んだ長さと種別は、OpenAI互換の口では返らない。別の口で補う
    const native = await this.readNativeModels();

    const infos: ModelInfo[] = [];
    for (const entry of response.data ?? []) {
      const id = entry.id;
      if (!id) continue;
      // **埋め込み用のモデルは選ばせない。** 文章を書かせても返らない。
      // 名前と種別の二重の網にしてある——名前に embed が入らない
      // 埋め込みモデルもあり、逆に種別は古い版では取れない
      const nativeEntry = native?.get(id);
      if (/embed/i.test(id) || nativeEntry?.type === "embeddings") continue;
      infos.push(this.describe(id, nativeEntry));
    }
    infos.sort((a, b) => a.id.localeCompare(b.id));
    return infos;
  }

  async getModel(id: string): Promise<ModelInfo | undefined> {
    const nativeEntry = (await this.readNativeModels())?.get(id);
    const loaded = loadedContextLength(nativeEntry);

    const cached = this.modelCache.get(id);
    if (cached) {
      // 読み込んだ長さが取れたモデルは、そちらが実際の値なので優先する。
      // 取れないモデルにだけ「設定を直したら次から効く」を残す
      return {
        ...cached,
        contextWindow: loaded ?? this.contextWindow,
        // **読み込み状況は写しを使わない。** 拡張機能がこのあとモデルを
        // 読み込むので、一覧を引いた時点の「未読込」はすぐ古くなる
        loaded:
          nativeEntry?.state === undefined
            ? cached.loaded
            : nativeEntry.state === "loaded",
      };
    }
    return this.describe(id, nativeEntry);
  }

  /**
   * いま読み込まれているモデルの長さ。導入案内（`setupLmStudio.ts`）が
   * 入力欄の初期値に使う。読めなければ undefined。
   *
   * **複数読み込まれているときは、いちばん短いものを返す。** この設定値は
   * 全モデル共通の予備なので、長いほうに合わせると短いモデルを選んだときに
   * 入力が黙って切り捨てられる。
   */
  async readLoadedContextWindow(): Promise<number | undefined> {
    const native = await this.readNativeModels();
    if (!native) return undefined;

    let shortest: number | undefined;
    for (const entry of native.values()) {
      // 埋め込みモデルは選ばせないので、長さの基準にもしない
      if (entry.type === "embeddings") continue;
      const length = loadedContextLength(entry);
      if (length === undefined) continue;
      if (shortest === undefined || length < shortest) shortest = length;
    }
    return shortest;
  }

  /**
   * そのモデルの読み込み状況。取れなければ undefined。
   *
   * **拡張機能からモデルを読み込む**（`lmstudioModelLoad.ts`）ために要る。
   * 未読込なら、こちらが文脈の長さを指定して読み込ませたい——JITに任せると
   * LM Studio側の既定の短い長さで載り、作者には「文脈 8k」としか見えない
   * （作者の報告、2026-08-29）。
   *
   * 取り方は `readNativeModels` に寄せてある（写しを作らない）。
   */
  async readModelLoadState(id: string): Promise<
    | {
        loaded: boolean;
        /** モデルが対応できる最大。**読み込むときの指定にだけ使う** */
        maxContextLength?: number;
        /** いま読み込まれている長さ。未読込なら undefined */
        loadedContextLength?: number;
      }
    | undefined
  > {
    const entry = (await this.readNativeModels())?.get(id);
    if (!entry) return undefined;
    const max = entry.max_context_length;
    return {
      loaded: entry.state === "loaded",
      maxContextLength:
        typeof max === "number" && Number.isFinite(max) && max > 0
          ? max
          : undefined,
      loadedContextLength: loadedContextLength(entry),
    };
  }

  /**
   * モデルごとの実情をLM Studio自身に聞く。取れなければ undefined。
   *
   * **失敗を例外にしない。** この口を持たない古い版でも、これまでどおり
   * 設定値で動き続ける（読めれば良くなるだけで、読めなくても悪くならない）。
   */
  private async readNativeModels(): Promise<
    Map<string, NativeModelEntry> | undefined
  > {
    try {
      const response = await fetchJson<NativeModelListResponse>({
        url: this.nativeModelsUrl,
        // `/v1/models` と同じ。手元のサーバなので、待つとしても一瞬
        timeoutMs: 15000,
        label: LABEL,
      });
      const byId = new Map<string, NativeModelEntry>();
      for (const entry of response.data ?? []) {
        if (entry.id) byId.set(entry.id, entry);
      }
      return byId;
    } catch (error) {
      if (!this.nativeFailureLogged) {
        this.nativeFailureLogged = true;
        logLine(
          `LM Studio：${this.nativeModelsUrl} から読み込み状況を取得できませんでした。` +
            `設定のコンテキスト長を使います（${
              error instanceof Error ? error.message : String(error)
            }）。`
        );
      }
      return undefined;
    }
  }

  private describe(id: string, native?: NativeModelEntry): ModelInfo {
    const parameterSize = parseParameterSize(id);
    const max = native?.max_context_length;
    const info: ModelInfo = {
      id,
      displayName: id,
      // 読み込んだ長さが分かればそれが実際の値。分からなければ作者の申告
      contextWindow: loadedContextLength(native) ?? this.contextWindow,
      parameterSize,
      capabilities: ["JSON強制"],
      // 公開重みのモデルなので、Ollamaと同じ物差しで測る
      tier: inferTier(parameterSize, "ollama"),
      // **表示のためだけに持つ。** 未読込のモデルに「文脈 8k」と出ると
      // 実際より小さく見えるが、`contextWindow` へ入れると今度は
      // 実際より大きい想定で送ってしまう（設定値のままにする）
      maxContextWindow:
        typeof max === "number" && Number.isFinite(max) && max > 0
          ? max
          : undefined,
      // 状況が取れない古い版では undefined のまま（「未読込」と断じない）
      loaded: native?.state === undefined ? undefined : native.state === "loaded",
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
        // **モデルが載らないのは、指定の問題ではない。** 指定を外して
        // 出し直しても同じところで落ちるので、ここで打ち切る
        const loadFailure = toModelLoadError(error, params.model);
        if (loadFailure) throw loadFailure;

        // **上限超えも、指定の問題ではない。** 読み込んだ文脈の長さを
        // 超えたときも400で返るので、種別を分けて呼び出し側が刻み直せる
        // ようにする（判定はOpenAI互換の3つで共通。写しを作らない）
        const overflow = asContextOverflowError(error, LABEL);
        if (overflow) throw overflow;

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
        // 返ってこなければ undefined のまま（`?? 0` にしない）
        cachedInputTokens: response.usage?.prompt_tokens_details?.cached_tokens,
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

/** 応答本文から読み取るLM Studioの説明の上限。通知に収まる長さにする */
const LOAD_FAILURE_REASON_LIMIT = 300;

/**
 * 「モデルを読み込めなかった」失敗なら、理由を添えた `AIError` にして返す。
 * それ以外の失敗なら undefined（呼び出し側でこれまでどおり扱う）。
 *
 * **HTTP 400 を「要求の形が悪い」と決めつけない。** LM Studioは読み込みに
 * 失敗したときも400を返し、`bad_response` に丸めると
 * 「出力上限とモデル設定を確認してください」という見当外れの案内になる。
 * 実際に返ってきたのは次のような本文である（この機械で実測、2026-08-29）。
 *
 * > Failed to load model "google/gemma-4-12b-qat". Error: Model loading was
 * > stopped due to insufficient system resources. …requires approximately
 * > 44.87 GB of memory…
 *
 * **原因も直し方もLM Studio自身が言っている。** ここで捨てず、そのまま
 * 作者へ渡す（英文のままなのは、訳すと必要な数字や設定名が消えるため）。
 */
function toModelLoadError(error: unknown, model: string): AIError | undefined {
  if (!(error instanceof AIError)) return undefined;
  const detail = error.detail ?? "";
  if (!detail.includes("Failed to load model")) return undefined;

  const parts = [`LM Studio がモデル「${model}」を読み込めませんでした。`];
  if (/insufficient system resources/i.test(detail)) {
    parts.push(
      "メモリ不足の見込みで読み込みを止めました（LM Studio の安全装置）。"
    );
  }
  parts.push(`LM Studio の説明：${extractLoadFailureReason(detail)}`);

  return new AIError(parts.join(""), "model_load_failed", detail);
}

/**
 * 応答本文からLM Studioの説明だけを取り出す。
 *
 * OpenAI互換の形（`{"error":{"message":…}}`）で返るが、**JSONとして
 * 読めなくても諦めない**——本文は500字で切られており、長い説明では
 * 途中で切れて構文が壊れる。読めなければ本文をそのまま使う。
 */
function extractLoadFailureReason(detail: string): string {
  let reason = detail;
  try {
    const parsed = JSON.parse(detail) as { error?: { message?: string } };
    if (typeof parsed.error?.message === "string") {
      reason = parsed.error.message;
    }
  } catch {
    // 壊れたJSONは黙って本文のまま使う。ここで例外を出すと、
    // 本来伝えたい「読み込めなかった」ごと消える
  }
  return reason.trim().slice(0, LOAD_FAILURE_REASON_LIMIT);
}
