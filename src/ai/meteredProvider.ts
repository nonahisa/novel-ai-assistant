import {
  AIError,
  type AIProvider,
  type ConnectionTestResult,
  type GenerateParams,
  type GenerateResult,
  type ModelInfo,
  type ProviderId,
} from "./types";
import { appendUsageLog } from "../core/usageLog";
import { contextOverflow, OUTPUT_RESERVE_TOKENS } from "./contextGuard";
import { logStep } from "../core/logger";

/**
 * AI呼び出しの送信量を記録するために、プロバイダを包む。
 *
 * ## なぜ1か所で包むか
 *
 * `generate` を呼んでいるのは10ファイルある。それぞれに記録処理を
 * 書くと、**新しい機能を足した人が書き忘れる**。書き忘れても動くので、
 * 忘れたことに誰も気づけない。`AIRegistry.resolve()` が返すものを
 * 包めば、呼び出し側は1行も変えずに全部が記録される。
 *
 * ## 何を包まないか
 *
 * `generate` 以外はそのまま渡す。とくに **`getModel` は
 * 「持っているかどうか」で呼び出し側が分岐する**ので
 * （`AIRegistry.resolveModelInfo`）、元が持っていないときに
 * 生やしてはいけない。生やすと、一覧から探す道が使われなくなって
 * モデル情報が取れなくなる。
 *
 * APIキーの出し入れ（`ApiKeyProvider`）はここを通らない。
 * ウィザードは `getProvider()` から素のプロバイダを取っている。
 *
 * ## 上限の関所も、ここに置く（設計書6.27.10）
 *
 * 記録と同じ理由である。**全プロバイダ・全機能がここを通る**ので、
 * 1か所で見れば「入らないものを送ってしまう」経路が残らない。
 * 各機能に書くと、新しい機能を足した人が書き忘れる。
 */
export class MeteredProvider implements AIProvider {
  /** 元が実装しているときだけ生やす（上のコメントの理由） */
  readonly getModel?: (id: string) => Promise<ModelInfo | undefined>;

  constructor(private readonly inner: AIProvider) {
    if (inner.getModel) {
      this.getModel = (id) => inner.getModel!(id);
    }
  }

  get id(): ProviderId {
    return this.inner.id;
  }

  get displayName(): string {
    return this.inner.displayName;
  }

  get isPaid(): boolean {
    return this.inner.isPaid;
  }

  isConfigured(): Promise<boolean> {
    return this.inner.isConfigured();
  }

  testConnection(): Promise<ConnectionTestResult> {
    return this.inner.testConnection();
  }

  listModels(): Promise<ModelInfo[]> {
    return this.inner.listModels();
  }

  /**
   * 送って、送った量を残す。
   *
   * **失敗しても記録してから投げ直す。** うまくいった回だけ残すと、
   * 「答えが返らなかった理由」を後から追えない（設計書6.20.2と同じ考え方）。
   */
  async generate(params: GenerateParams): Promise<GenerateResult> {
    const started = Date.now();

    // **入らないものは送らない**（設計書6.27.10）。送ってしまうと
    // Ollama は黙って切り捨て、クラウドは料金を取ってから断る
    const overflow = contextOverflow({
      systemChars: params.systemPrompt.length,
      userChars: params.userPrompt.length,
      outputTokens: params.maxOutputTokens ?? OUTPUT_RESERVE_TOKENS,
      contextWindow: await this.contextWindowOf(params.model),
    });
    if (overflow) {
      // **送らなかったことも記録に残す。** 記録に何も出ないと、作者からは
      // 「押したのに何も起きなかった」としか見えない
      this.record(params, { elapsedMs: 0, error: describeError(overflow) });
      throw overflow;
    }

    try {
      const result = await this.inner.generate(params);
      this.record(params, {
        usage: result.usage,
        elapsedMs: result.elapsedMs,
        truncated: result.truncated,
      });
      return result;
    } catch (error) {
      this.record(params, {
        elapsedMs: Date.now() - started,
        error: describeError(error),
      });
      throw error;
    }
  }

  /** 上限が分からないと記録したモデル。**同じモデルでは一度だけ書く** */
  private readonly loggedUnknownLimit = new Set<string>();

  /**
   * 関所が使う上限を引く。**取れなくても止めない。**
   *
   * 失敗したときに投げ直さないのは、**上限が分からないという理由で作品
   * 全体が処理できなくなるのを避ける**ため。
   *
   * **ここで値を覚え込まない。** Ollama・Claude・Gemini は各プロバイダが
   * 結果を持ち回るので通信は初回だけだが、LM Studio は毎回 `/api/v0/models`
   * を引く——引くのが正しい。あちらは**いま読み込まれている長さ**を返し、
   * 実行の途中でモデルを載せ替えると値が変わる。手元のサーバへの1往復
   * （数ミリ秒）と引き換えに、古い上限で判断する事故を避けている。
   *
   * **通ったときは何も書かない。** チャンクの数だけ行が出るとログが
   * 埋まって他が読めなくなる。送った量は `usage.md` に既に残っている。
   */
  private async contextWindowOf(model: string): Promise<number | undefined> {
    if (!this.getModel) return undefined;
    let limit: number | undefined;
    try {
      limit = (await this.getModel(model))?.contextWindow;
    } catch {
      limit = undefined;
    }
    if (limit === undefined && !this.loggedUnknownLimit.has(model)) {
      this.loggedUnknownLimit.add(model);
      logStep(
        `モデル「${model}」のコンテキスト上限が取れないため、` +
          "入るかどうかの確認を省いて送ります"
      );
    }
    return limit;
  }

  /**
   * 記録を1行足す。
   *
   * **`meta` が無い呼び出しは記録しない。** 作品に属さない呼び出し
   * （接続確認など）を、どこかの作品のログへ書くと数字が狂う。
   */
  private record(
    params: GenerateParams,
    outcome: {
      // 形は `GenerateResult["usage"]` と同じ。**そのまま渡す**ので、
      // プロバイダが新しい項目を返し始めても、ここを直す必要はない
      usage?: GenerateResult["usage"];
      elapsedMs?: number;
      truncated?: boolean;
      error?: string;
    }
  ): void {
    const meta = params.meta;
    if (!meta?.workFolder) return;

    appendUsageLog(meta.workFolder, {
      feature: meta.feature,
      provider: this.inner.displayName,
      model: params.model,
      paid: this.inner.isPaid,
      systemChars: params.systemPrompt.length,
      userChars: params.userPrompt.length,
      schemaChars: params.jsonSchema
        ? JSON.stringify(params.jsonSchema).length
        : undefined,
      parts: meta.parts,
      numCtx: params.numCtx,
      ...outcome,
    });
  }
}

/**
 * 失敗を短く言い表す。
 *
 * **種別（`kind`）を先に出す。** 「残高が無い」と「レート上限」は
 * 直し方が違うので、記録を眺めたときに区別が付いてほしい。
 */
function describeError(error: unknown): string {
  if (error instanceof AIError) {
    return `${error.kind}: ${error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}
