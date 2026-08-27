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
