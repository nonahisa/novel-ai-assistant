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
import { contextOverflow, skipsContextGuard } from "./contextGuard";
import { resolveMaxOutputTokens } from "./outputLimit";
import { logStep } from "../core/logger";
import { AiQueueAbortError, acquireCall } from "../core/aiSequence";
import { type SpeedSource, saveModelTuning } from "../core/modelTuning";
import { outputTokensPerSecond } from "../core/tuningStats";
import { TOKENS_PER_CHAR } from "../core/sizeBudget";

/**
 * これに満たない応答からは速さを採らない（トークン）。
 *
 * **立ち上がりの遅れが支配的になる。** 応答が返り始めるまでの待ちは
 * 出力の長さに関係なく乗るので、数十トークンの応答で割ると「そのモデルの
 * 書く速さ」ではなく「待たされた時間」を測ったことになる。
 */
const MIN_SPEED_SAMPLE_TOKENS = 64;

/** これに満たない所要時間の回も採らない（ミリ秒）。理由は上と同じ */
const MIN_SPEED_SAMPLE_MS = 1_000;

/**
 * 同じモデルの速度を書き直すまでの間隔（ミリ秒）。
 *
 * 台帳はVS Codeの**設定ファイル**なので、書けばディスクへ書き込みが走る。
 * 呼び出しのたびに書くと、1つの機能を流すだけでチャンクの数だけ書くことに
 * なる。値が落ち着いているあいだは、しばらく置いてから書き直せば足りる。
 */
const SPEED_WRITE_INTERVAL_MS = 60_000;

/**
 * 間隔を待たずに書き直す、値の変わりよう（割合）。
 *
 * **大きく変わったときは、すぐ映す。** モデルを載せ替えた・機械が重い、
 * といった変化は作者が知りたい情報なので、60秒の間隔より優先する。
 */
const SPEED_WRITE_CHANGE_RATIO = 0.2;

/**
 * 値の変わりようで書き直すときの、最短の間隔（ミリ秒）。
 *
 * チャンクごとに応答の長さが違うと、速度は簡単に2割以上振れる。
 * 変化だけを条件にすると「毎回書く」に近づき、設定ファイルへの書き込みが
 * チャンクの数だけ走る。**大きく変わっても、直前に書いたばかりなら待つ**
 * ——5秒あれば1チャンクぶんは流れるので、連続の書き込みは止まる。
 */
const SPEED_WRITE_CHANGE_MIN_INTERVAL_MS = 5_000;

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
 *
 * ## リクエストの関所も、ここに置く（設計書6.76）
 *
 * 理由は上の2つとまったく同じである。**全プロバイダ・全機能がここを
 * 通る**ので、1か所で1件ずつに絞れば、機能を足した人が並列に投げて
 * しまう経路が残らない。
 *
 * ## 出力の速さも、ここで採る（設計書6.65.14）
 *
 * 0.36.3 の速度は「書ける量の測定」からしか取れなかった。あれは
 * **手元のAIだけを測る機能**なので、クラウド（Gemini・さくら・Claude・
 * ChatGPT）の欄は永久に「—」のままだった。ここなら6つとも通る
 * （作者の裁定、2026-09-06）。
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

  /** 関所がこれを見る（下の `outputTokensFor`）ので、落とさずに通す */
  get capsOutput(): boolean | undefined {
    return this.inner.capsOutput;
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
    let started = Date.now();

    // **入らないものは送らない**（設計書6.27.10）。送ってしまうと
    // Ollama は黙って切り捨て、クラウドは料金を取ってから断る。
    //
    // 唯一の例外が読める長さの測定である（`skipsContextGuard` に理由）。
    // 三項で書いてあるのは、素通りするときに上限の問い合わせ
    // （LM Studio では毎回の1往復）まで省くため
    const overflow = skipsContextGuard(params.meta?.feature)
      ? undefined
      : contextOverflow({
          systemChars: params.systemPrompt.length,
          userChars: params.userPrompt.length,
          outputTokens: this.outputTokensFor(params),
          contextWindow: await this.contextWindowOf(params.model),
        });
    if (overflow) {
      // **送らなかったことも記録に残す。** 記録に何も出ないと、作者からは
      // 「押したのに何も起きなかった」としか見えない
      this.record(params, { elapsedMs: 0, error: describeError(overflow) });
      throw overflow;
    }

    // **順番待ちは、上限の確認が済んでからにする**（設計書6.76）。
    // 入らないと分かっているものを列に並ばせてから断るのは無駄で、
    // その間ほかの機能を待たせることになる。
    //
    // ここで待つのは**実送信のあいだだけ**である。上の `contextWindowOf`
    // はプロバイダによっては1往復するが、数ミリ秒なので関所の外に置いて、
    // 待たせる時間を短くしている
    let release: () => void;
    try {
      release = await this.enterQueue(params.signal);
    } catch (error) {
      // 送っていないので、所要時間は0で残す。**順番待ちの長さを
      // AIの遅さとして記録しない**（overflow のときと同じ扱い）
      this.record(params, { elapsedMs: 0, error: describeError(error) });
      throw error;
    }
    // 待ち時間を所要時間に混ぜない。混ぜると「AIが遅くなった」と読めてしまう
    started = Date.now();

    try {
      let result: GenerateResult;
      try {
        result = await this.inner.generate(params);
      } finally {
        release();
      }
      this.record(params, {
        usage: result.usage,
        elapsedMs: result.elapsedMs,
        truncated: result.truncated,
      });
      // **うまくいった回からだけ速さを採る**（下のコメントに理由）。
      // 台帳への書き込みは抑えてあるので、たいていは何もせずに戻る
      await this.recordSpeed(params.model, result);
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
   * 送る順番を取る（設計書6.76のリクエストの関所）。
   *
   * **中止は既存の流儀へ言い換える。** 呼び出し側は例外なく
   * `AIError` の `aborted` を見て「作者が止めた」と判断しており
   * （通知を出さない分岐）、別の型を投げると失敗として報告してしまう。
   */
  private async enterQueue(signal?: AbortSignal): Promise<() => void> {
    try {
      return await acquireCall(signal);
    } catch (error) {
      if (error instanceof AiQueueAbortError) {
        throw new AIError("処理が中止されました。", "aborted");
      }
      throw error;
    }
  }

  /**
   * 関所が「応答のぶん」として数えるトークン数（設計書6.77の第2段）。
   *
   * **プロバイダによって向きが逆になる。理由は、実際に場所を食うものが
   * 違うからである。**
   *
   * - **上限を送るプロバイダ（クラウド5社）**：`実上限 → 見込み → 設定値`。
   *   渡した上限がそのまま送られるので、**その席を空けておかないと入らない。**
   *   以前はここで既定を `OUTPUT_RESERVE_TOKENS`（8,192）にしていたが、
   *   実際に送られるのは設定値（既定16,384）だったので、**関所を通ったのに
   *   上限を超える**という逆向きの食い違いが残っていた
   * - **上限を送らないプロバイダ（Ollama）**：`見込み → 実上限 → 設定値`。
   *   あちらは `num_predict` を送らず（設計書6.58.2）、`num_ctx` を
   *   **見込みぶんだけ**確保する。実際に消費されるのは見込みのほうなので、
   *   実上限で数えると「確保は足りているのに関所が断る」ことになる
   *   （32kのモデルで、送れる本文が約17,200字から約11,470字へ縮む）
   *
   * **印が無ければ「上限を送る側」として扱う**（安全側）。付け忘れが
   * 「実際より小さく見積もって送る」ほうへ倒れると、黙って切り捨てられる
   * 経路が復活する。
   *
   * 式を組むのはここである。`contextGuard.ts` は VS Code に依存させない
   * 決まりなので、設定を読む処理をあちらへ入れない。
   */
  private outputTokensFor(params: GenerateParams): number {
    const [first, second] =
      this.inner.capsOutput === false
        ? [params.plannedOutputTokens, params.maxOutputTokens]
        : [params.maxOutputTokens, params.plannedOutputTokens];
    return first ?? second ?? resolveMaxOutputTokens();
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
   * 最後に台帳へ書いた速度。**モデル名で引く。**
   *
   * この包みはプロバイダ1つにつき1個だけ作られる（`AIRegistry.meter`）ので、
   * 実際の鍵は `プロバイダID:モデル名` と同じになる。
   *
   * 覚えているのは書き込みを抑えるためだけで、**値は平均しない**
   * （直近の実測をそのまま台帳へ入れる）。
   */
  private readonly lastSpeed = new Map<
    string,
    { at: number; tokensPerSecond: number }
  >();

  /** 台帳へ書けなかったことを言うのは、同じモデルで一度だけ */
  private readonly loggedSpeedFailure = new Set<string>();

  /**
   * 応答から出力の速さを採って、台帳へ残す（設計書6.65.14）。
   *
   * **採れる回は限られる。** 短い応答・切り詰められた応答は、
   * 「そのモデルが書く速さ」を表していない（上の2つの定数に理由）。
   * 失敗と中止の回はそもそもここへ来ない（呼ぶのは成功したときだけ）。
   *
   * **記録に `meta` は要らない。** 送信量のログと違って、これは作品では
   * なく**モデルの性質**なので、作品に属さない呼び出しから採ってもよい。
   */
  private async recordSpeed(
    model: string,
    result: GenerateResult
  ): Promise<void> {
    // 途中で切られた応答は「その速さで書き切れた」ことにならない
    if (result.truncated) return;

    const measured = result.usage?.outputTokens;
    const useMeasured =
      typeof measured === "number" && Number.isFinite(measured) && measured > 0;
    /*
      **申告が無ければ字数から見積もる。**

      換算は `core/sizeBudget.ts` の係数を借りる（新しい係数を作らない。
      同じ意味の数を2か所目に書くのが、これまでの食い違いの原因だった）。

      思考モードの出力も足す。**あれも時間を使って書かれている**ので、
      本文だけで割ると、考えてから答えるモデルほど遅く見えてしまう。
    */
    const tokens = useMeasured
      ? measured
      : Math.round(
          (result.text.length + (result.thinking?.length ?? 0)) *
            TOKENS_PER_CHAR
        );
    const source: SpeedSource = useMeasured ? "call" : "estimated";

    if (tokens < MIN_SPEED_SAMPLE_TOKENS) return;
    if (result.elapsedMs < MIN_SPEED_SAMPLE_MS) return;

    // 式は一覧側と共用する（`core/tuningStats.ts`）。写すと片方だけ直る
    const tokensPerSecond = outputTokensPerSecond(tokens, result.elapsedMs);
    if (tokensPerSecond === undefined) return;

    const now = Date.now();
    if (!this.shouldWriteSpeed(model, now, tokensPerSecond)) return;

    try {
      await saveModelTuning(this.inner.id, model, {
        outputTokensPerSecond: tokensPerSecond,
        speedSource: source,
        // 時計は `Date.now` の1か所から取る（試験で止められるように）
        speedMeasuredAt: new Date(now).toISOString(),
      });
      // **書けたときだけ覚える。** 書けていないのに覚えると、次の回が
      // 「もう書いた」と判断して台帳に速度が入らないままになる
      this.lastSpeed.set(model, { at: now, tokensPerSecond });
    } catch (error) {
      // **速度が残せなかっただけで、AIの応答は返す**（見せるための参考値）。
      // ただしエラーの本文は捨てない（CLAUDE.md 規則5）
      if (this.loggedSpeedFailure.has(model)) return;
      this.loggedSpeedFailure.add(model);
      logStep(
        `モデル「${model}」の出力速度を台帳へ保存できませんでした` +
          `（${error instanceof Error ? error.message : String(error)}）。`
      );
    }
  }

  /**
   * いま書くべきか。**書き込みを抑えるための判断**（設計書6.65.14）。
   *
   * 初めてなら書く。そうでなければ「前回から間隔が空いた」か
   * 「値が大きく変わった」ときだけ書く。
   */
  private shouldWriteSpeed(
    model: string,
    now: number,
    tokensPerSecond: number
  ): boolean {
    const previous = this.lastSpeed.get(model);
    if (!previous) return true;
    if (now - previous.at >= SPEED_WRITE_INTERVAL_MS) return true;
    if (now - previous.at < SPEED_WRITE_CHANGE_MIN_INTERVAL_MS) return false;
    const change =
      Math.abs(tokensPerSecond - previous.tokensPerSecond) /
      previous.tokensPerSecond;
    return change >= SPEED_WRITE_CHANGE_RATIO;
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
