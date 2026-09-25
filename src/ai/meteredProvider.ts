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
import {
  contextOverflow,
  outputTokensWithinWindow,
  skipsContextGuard,
  type ContextFitInput,
} from "./contextGuard";
import {
  MINIMUM_OUTPUT_TOKENS,
  resolveOutputTokensForSend,
} from "./outputLimit";
import { recordFeatureOutputTokens } from "../core/featureOutputTokens";
import { endsInWhitespaceRunaway } from "../core/truncatedResponse";
import { logStep } from "../core/logger";
import { AiQueueAbortError, acquireCall } from "../core/aiSequence";
import { localAiGate } from "../core/localAiGate";
import { isLocalProviderId } from "../core/localProviders";
import {
  type SpeedSource,
  modelTuning,
  modelTuningRaw,
  saveModelTuning,
} from "../core/modelTuning";
import { outputTokensPerSecond } from "../core/tuningStats";
import {
  MIN_CHARS_PER_TOKEN_SAMPLES,
  TOKENS_PER_CHAR,
  mergeCharsPerToken,
  roundCharsPerToken,
} from "../core/sizeBudget";

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
 * これに満たない入力からは、読み込みの速さを採らない（トークン。設計書6.8.19）。
 *
 * **Ollama は前の回と同じ頭の部分を読み直さない**（キャッシュが効く）。
 * そのぶんは `prompt_eval_count` にも時間にも入らないので速さの計算は
 * 崩れないが、読み直したのが数十トークンだけの回は、立ち上がりの固定費を
 * 測ったことになる。実際の機能は指示だけで数千字あるので、この線は越える。
 */
const MIN_INPUT_SPEED_SAMPLE_TOKENS = 256;

/**
 * これに満たない読み込み時間の回も採らない（ミリ秒）。
 *
 * **出力（1秒）より短くしてある。** 読み込みは速い機械では数百ミリ秒で
 * 終わる——そういう機械では読み込みが目安にほとんど効かないので、採れ
 * なくても困らないが、1秒で切ると GPU の機械では一度も採れない。
 * Ollama はナノ秒で申告するので、短くても時計の粗さで崩れない。
 */
const MIN_INPUT_SPEED_SAMPLE_MS = 100;

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
 * ——30秒あれば数チャンクぶんは流れるので、連続の書き込みは止まる
 * （5秒では、長い一括処理で `settings.json` が5秒ごとに書き換わり、作品の
 * リポジトリをワークスペースにしている作者では未コミットの印が点きっぱなしに
 * なる——レビューの指摘、2026-09-06。見せるための参考値なので即時性は要らない）。
 */
const SPEED_WRITE_CHANGE_MIN_INTERVAL_MS = 30_000;

/**
 * これに満たない字数の回からは、字/トークンを採らない。
 *
 * **チャット定型文のぶんが支配的になる。** どのプロバイダも、送った
 * プロンプトの前後に役割の印（`<|im_start|>` のようなもの）を付けてから
 * 数える。数十トークンの固定費なので、短い回で割ると「そのモデルの
 * 字/トークン」ではなく**定型文の重さ**を測ることになる。
 *
 * しかもこの実装は最小値を覚えるので、接続確認のような数十字の回が
 * 1度混ざると、**その値に張り付いたまま二度と動かない。**
 * 2,000字あれば固定費の影響は数%に収まり、実際の機能のプロンプト
 * （指示だけで数千字ある）はすべてこの線を越える。
 *
 * 速度のほうに `MIN_SPEED_SAMPLE_TOKENS` を置いたのと同じ理由である。
 */
const MIN_RATIO_SAMPLE_CHARS = 2000;

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
  async generate(requested: GenerateParams): Promise<GenerateResult> {
    let started = Date.now();

    // **入らないものは送らない**（設計書6.27.10）。送ってしまうと
    // Ollama は黙って切り捨て、クラウドは料金を取ってから断る。
    //
    // 唯一の例外が読める長さの測定である（`skipsContextGuard` に理由）。
    // 素通りするときは、上限の問い合わせ（LM Studio では毎回の1往復）
    // まで省く
    let params = requested;
    let overflow: AIError | undefined;
    if (!skipsContextGuard(requested.meta?.feature)) {
      const fit: ContextFitInput = {
        systemChars: requested.systemPrompt.length,
        userChars: requested.userPrompt.length,
        outputTokens: this.outputTokensFor(requested),
        contextWindow: await this.contextWindowOf(requested.model),
        // **チャンクを決めたのと同じ台帳を見る**（設計書6.77）。
        // 実測が無ければ `resolveTokensPerChar` が従来の 0.7 を返す
        measured: modelTuning(this.inner.id, requested.model),
      };
      // **出力の見込みだけで上限に届くなら、残りを出力に回す**
      // （`outputTokensWithinWindow` に理由。比べ 2026-09-25〜26）
      const outputTokens = outputTokensWithinWindow(fit, MINIMUM_OUTPUT_TOKENS);
      overflow = contextOverflow({ ...fit, outputTokens });
      if (!overflow && outputTokens < fit.outputTokens) {
        params = this.withOutputLimit(requested, outputTokens, fit);
      }
    }
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
    //
    // **手元のAIは、その前にプロセスをまたいだ門を通る**（設計書6.76.1）。
    // 順番は「実行の札 → 門 → 関所」。関所を持ったまま門で待つと、同じ窓の
    // クラウドへの送信まで別の窓の完了を待たされる（関所は6社共通の1本）
    let leaveLocalGate: (() => void) | undefined;
    let release: () => void;
    try {
      leaveLocalGate = await this.enterLocalGate(params);
      release = await this.enterQueue(params.signal);
    } catch (error) {
      leaveLocalGate?.();
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
        leaveLocalGate?.();
      }
      this.record(params, {
        usage: result.usage,
        elapsedMs: result.elapsedMs,
        truncated: result.truncated,
      });
      // **うまくいった回からだけ速さを採る**（下のコメントに理由）。
      // 台帳への書き込みは抑えてあるので、たいていは何もせずに戻る
      await this.recordSpeed(params.model, result);
      await this.recordCharsPerToken(params, result);
      await this.recordFeatureOutput(params, result);
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
   * 手元のAIへ送る前の、プロセスをまたいだ門（設計書6.76.1）。
   *
   * **クラウドは通さない**（取り合うメモリが無い）。門が差し込まれていない
   * とき（単体テスト・ブラウザ版）も今までどおり送る。
   *
   * **門の失敗で送信を止めない。** 中止と作者の「やめる」だけを `aborted` として
   * 通し、ほかの失敗はログに残して素通りする——順番待ちは「あればよいもの」で、
   * これが壊れて執筆の道具が止まるほうが害が大きい。
   */
  private async enterLocalGate(
    params: GenerateParams
  ): Promise<(() => void) | undefined> {
    if (!isLocalProviderId(this.inner.id)) return undefined;
    const gate = localAiGate();
    if (!gate) return undefined;
    try {
      return await gate.enter({
        providerId: this.inner.id,
        model: params.model,
        feature: params.meta?.feature,
        signal: params.signal,
      });
    } catch (error) {
      if (error instanceof AiQueueAbortError) {
        throw new AIError(error.message || "処理が中止されました。", "aborted");
      }
      logStep(
        `手元のAIの順番待ち（ほかの窓との札）を確かめられなかったので、そのまま送ります：${describeError(error)}`
      );
      return undefined;
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
    /*
      **落とし先も、呼び出し側と同じ出どころから引く**（設計書6.77の第3段）。

      以前はここだけ `resolveMaxOutputTokens()`（設定値そのもの）だった。
      渡してこない呼び出しでは、**機能の実測があっても関所だけが設定値で
      数える**ことになる——値を1つの出どころへ寄せた意味が、ここで抜ける。
      機能は記録（`meta.feature`）が既に持っているので、取りにいけばよい。
    */
    return (
      first ??
      second ??
      resolveOutputTokensForSend(this.inner.id, params.model, params.meta?.feature)
    );
  }

  /** 出力の上限を縮めて送ったと記録したモデル。**同じモデル・同じ見込みでは一度だけ書く** */
  private readonly loggedOutputFit = new Set<string>();

  /**
   * 出力の上限を `tokens` まで縮めた呼び出しを作る（比べ 2026-09-25〜26。
   * `contextGuard.ts` の `outputTokensWithinWindow` に理由）。
   *
   * **実上限と見込みの両方を縮める。** 実上限はクラウドがそのまま送る値、
   * 見込みは Ollama が `num_ctx` を確保する値で、どちらが効くかは
   * プロバイダ次第である（`outputTokensFor`）。**実上限は必ず明示する**
   * ——渡されない呼び出しでは、プロバイダが設定値（16,384）を送り、
   * 縮めた意味が無くなる。
   *
   * **黙って縮めない。** 1回の応答の上限が変わると、長い答えが途中で
   * 切れることがありうる。モデルごとに一度だけ操作ログへ出す。
   */
  private withOutputLimit(
    params: GenerateParams,
    tokens: number,
    fit: ContextFitInput
  ): GenerateParams {
    const note = `${params.model}:${fit.outputTokens}`;
    if (!this.loggedOutputFit.has(note)) {
      this.loggedOutputFit.add(note);
      logStep(
        `モデル「${params.model}」は読める長さが` +
          `${(fit.contextWindow ?? 0).toLocaleString("ja-JP")}トークンで、` +
          `出力の見込み（${fit.outputTokens.toLocaleString("ja-JP")}トークン）だけで埋まるため、` +
          `1回の応答の上限を入る分（この回は${tokens.toLocaleString("ja-JP")}トークン）まで縮めて送ります`
      );
    }
    return {
      ...params,
      maxOutputTokens: Math.min(params.maxOutputTokens ?? tokens, tokens),
      plannedOutputTokens:
        params.plannedOutputTokens === undefined
          ? undefined
          : Math.min(params.plannedOutputTokens, tokens),
    };
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
   * （直近の実測をそのまま台帳へ入れる）。読み込みの速さ（設計書6.8.19）も
   * 同じ札に並べる——片方だけ採れた回があるので、どちらも省略できる。
   */
  private readonly lastSpeed = new Map<
    string,
    { at: number; output?: number; input?: number }
  >();

  /** 台帳へ書けなかったことを言うのは、同じモデルで一度だけ */
  private readonly loggedSpeedFailure = new Set<string>();

  /**
   * 応答から出力の速さ（と読み込みの速さ）を採って、台帳へ残す
   * （設計書6.65.14・6.8.19）。
   *
   * **採れる回は限られる。** 短い応答・切り詰められた応答は、
   * 「そのモデルが書く速さ」を表していない（上の2つの定数に理由）。
   * 失敗と中止の回はそもそもここへ来ない（呼ぶのは成功したときだけ）。
   * **覚えるのは通った回からだけ**（実装ルール5の考え方）。
   *
   * **記録に `meta` は要らない。** 送信量のログと違って、これは作品では
   * なく**モデルの性質**なので、作品に属さない呼び出しから採ってもよい。
   */
  private async recordSpeed(
    model: string,
    result: GenerateResult
  ): Promise<void> {
    const output = outputSpeedSample(result);
    const input = inputSpeedSample(result);
    if (output === undefined && input === undefined) return;

    const now = Date.now();
    if (!this.shouldWriteSpeed(model, now, output?.tokensPerSecond, input)) {
      return;
    }

    // 時計は `Date.now` の1か所から取る（試験で止められるように）
    const at = new Date(now).toISOString();
    try {
      await saveModelTuning(this.inner.id, model, {
        /*
          **採れた側だけを書く。** 台帳は `undefined` の欄を消すので、
          採れなかった側を `undefined` で渡すと、前の実測まで消える
          （短い応答の回は読み込みの速さしか採れない）。
        */
        ...(output !== undefined
          ? {
              outputTokensPerSecond: output.tokensPerSecond,
              speedSource: output.source,
              speedMeasuredAt: at,
            }
          : {}),
        ...(input !== undefined
          ? { inputTokensPerSecond: input, inputSpeedMeasuredAt: at }
          : {}),
      });
      // **書けたときだけ覚える。** 書けていないのに覚えると、次の回が
      // 「もう書いた」と判断して台帳に速度が入らないままになる
      const previous = this.lastSpeed.get(model);
      this.lastSpeed.set(model, {
        at: now,
        output: output?.tokensPerSecond ?? previous?.output,
        input: input ?? previous?.input,
      });
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
   * 「値が大きく変わった」ときだけ書く。**前回に無かった値が採れたのも
   * 「大きく変わった」に数える**——読み込みの速さを初めて採れた回を、
   * 60秒の間隔で捨てない。
   */
  private shouldWriteSpeed(
    model: string,
    now: number,
    outputTokensPerSecond: number | undefined,
    inputTokensPerSecond: number | undefined
  ): boolean {
    const previous = this.lastSpeed.get(model);
    if (!previous) return true;
    if (now - previous.at >= SPEED_WRITE_INTERVAL_MS) return true;
    if (now - previous.at < SPEED_WRITE_CHANGE_MIN_INTERVAL_MS) return false;
    return (
      changedEnough(previous.output, outputTokensPerSecond) ||
      changedEnough(previous.input, inputTokensPerSecond)
    );
  }

  /** 字/トークンを台帳へ書けなかったことを言うのは、同じモデルで一度だけ */
  private readonly loggedRatioFailure = new Set<string>();

  /**
   * 応答から**字/トークンの実測**を採って、台帳へ残す（設計書6.77）。
   *
   * 製品は字↔トークンを当て推量（0.7字/トークン）で見ているが、作者の
   * 送信量の記録437件で突き合わせると**実測はその倍**だった。見積りが
   * 小さすぎると、入るのに入らないと判断して本文を細かく切る。
   * **この製品は既にこの数字を1回ずつ記録している**（`core/usageLog.ts` の
   * `systemChars`・`userChars` と `usage.inputTokens`）。使っていなかっただけである。
   *
   * 採らない回が3つある。**どれも「測ったことにならない」回である。**
   *
   * - `inputTokens` を返さないAI……見積りで割ると、見積りを見積りで
   *   検算することになって意味がない
   * - キャッシュが効いた回……`inputTokens` が実際より小さく出るので、
   *   字/トークンが**実際より大きく**（＝危ない側へ）見える
   * - 短すぎる回……下の定数に理由
   *
   * **スキーマの字数は足さない。** プロンプトとは別枠で送られ、入力
   * トークンに乗るかがプロバイダによって違う（`core/usageLog.ts` の
   * `schemaChars` の説明）。足すと、乗らないプロバイダで字/トークンが
   * 大きく出る。
   */
  private async recordCharsPerToken(
    params: GenerateParams,
    result: GenerateResult
  ): Promise<void> {
    const usage = result.usage;
    const inputTokens = usage?.inputTokens;
    if (
      typeof inputTokens !== "number" ||
      !Number.isFinite(inputTokens) ||
      inputTokens <= 0
    ) {
      return;
    }
    // **0と undefined を分ける。** 0は「数えたうえで効かなかった」なので
    // 捨てる理由が無い（`ai/types.ts` の `cachedInputTokens`）
    const cached = usage?.cachedInputTokens;
    if (typeof cached === "number" && cached > 0) return;

    const chars = params.systemPrompt.length + params.userPrompt.length;
    if (chars < MIN_RATIO_SAMPLE_CHARS) return;

    const sample = roundCharsPerToken(chars / inputTokens);
    if (!Number.isFinite(sample) || sample <= 0) return;

    /*
      **平均しない。これまでの最小値を覚える**（作者の裁定）。理由と式は
      `core/sizeBudget.ts` の `mergeCharsPerToken` にまとめてある——
      読める長さの測定（`features/measureContext.ts`）も同じ欄へ書くので、
      約束は1か所にしか置かない。
    */
    /*
      **素の台帳を読む**（`modelTuningRaw`）。ここは作者自身の実測を
      積む側で、同梱の初期値（`core/bundledTuning.ts`）を previous に
      すると、最小値を覚える決まりのせいで**同梱の値が作者の実測に
      勝ち続ける。** 添えてある回数も数え始めになってしまう。
    */
    const current = modelTuningRaw(this.inner.id, params.model);
    const previous = current?.charsPerToken;
    const samples = current?.charsPerTokenSamples ?? 0;
    const next = mergeCharsPerToken(previous, sample);

    /*
      **書き込みを抑える**（速度と同じ理由。台帳はVS Codeの設定ファイル
      なので、書けばディスクへ書き込みが走る）。書くのは2つの場合だけ。

      1. 最小値が下がった……覚える値が変わったのだから書く
      2. 件数がしきい値に届いていない……そこまでは毎回書いて、
         早く「信じてよい」状態まで持っていく

      しきい値を越えたあとは、下がった回しか数えない。だから
      `charsPerTokenSamples` は**呼び出し回数そのものではない**
      （台帳側のコメントに書いた）。少なめに出るぶんには安全側である。
    */
    const improved = previous === undefined || next < previous;
    if (!improved && samples >= MIN_CHARS_PER_TOKEN_SAMPLES) return;

    try {
      await saveModelTuning(this.inner.id, params.model, {
        charsPerToken: next,
        charsPerTokenSamples: samples + 1,
      });
    } catch (error) {
      // **残せなかっただけで、AIの応答は返す。** ただしエラーの本文は
      // 捨てない（CLAUDE.md 規則5）。速度のときと同じ扱い
      if (this.loggedRatioFailure.has(params.model)) return;
      this.loggedRatioFailure.add(params.model);
      logStep(
        `モデル「${params.model}」の字/トークンを台帳へ保存できませんでした` +
          `（${error instanceof Error ? error.message : String(error)}）。`
      );
    }
  }

  /** 見込みを台帳へ書けなかったことを言うのは、同じ機能で一度だけ */
  private readonly loggedFeatureOutputFailure = new Set<string>();

  /**
   * 応答から**機能ごとの出力トークン数**を採って、台帳へ残す
   * （設計書6.77の第3段。`core/featureOutputTokens.ts`）。
   *
   * **速さ・字/トークンとまったく同じ流儀**である——普段の呼び出しから
   * 自動で採り、確認なしで保存する。違うのは使い道で、こちらは
   * **見込みそのもの**になる（計画・関所・実送信の上限が引く）。
   *
   * 採らない回が2つある。
   *
   * - `completion_tokens` を返さないAI……字数から換算すると、見込みを
   *   見積りで決めることになって「実測から決める」ではなくなる
   * - 読める長さの測定（`context_probe`）……あれは**わざと上限を試す**
   *   呼び出しで、機能の仕事の大きさを表していない
   *
   * **切り詰められた回は、量ではなく印として渡す。** 切られた回の
   * `completion_tokens` は上限そのものなので「要った量」ではない
   * （紹介文の16,384がまさにそれだった）。
   */
  private async recordFeatureOutput(
    params: GenerateParams,
    result: GenerateResult
  ): Promise<void> {
    const feature = params.meta?.feature;
    if (feature === undefined || feature.length === 0) return;
    if (skipsContextGuard(feature)) return;
    /*
      **空白だけの行で埋まった回は、量も印も残さない**（残課題8）。

      2026-09-22、さくらのAIの逸脱検知で、応答が空白で出力上限まで埋まった。
      **上限が足りなかったのではない**——中身は書き終わっていて、そのあと
      空白を書き続けただけである。ここで「切り詰められた」の印を付けると、
      以後その機能は見込みを失って設定値の大きな上限で送り続け、空白で
      埋まる回はかえって長くなる。量として残せば、空白の量を「要った量」と
      覚える。どちらも測ったことにならない。
    */
    if (endsInWhitespaceRunaway(result.text)) return;

    const tokens = result.usage?.outputTokens;
    if (typeof tokens !== "number" || !Number.isFinite(tokens) || tokens <= 0) {
      return;
    }

    try {
      // **どのモデルで測ったかまで残す**（0.71.6）。速さ・字/トークンの
      // 台帳と同じ鍵の立て方である（`this.inner.id` がプロバイダID）
      await recordFeatureOutputTokens(
        feature,
        this.inner.id,
        params.model,
        tokens,
        result.truncated === true
      );
    } catch (error) {
      // **残せなかっただけで、AIの応答は返す**（速度・字/トークンと同じ扱い）。
      // ただしエラーの本文は捨てない（CLAUDE.md 規則5）
      if (this.loggedFeatureOutputFailure.has(feature)) return;
      this.loggedFeatureOutputFailure.add(feature);
      logStep(
        `機能「${feature}」の出力トークン数を台帳へ保存できませんでした` +
          `（${error instanceof Error ? error.message : String(error)}）。`
      );
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
 * 応答から、出力の速さを採る（設計書6.65.14）。採れない回は `undefined`。
 *
 * **AIが書き出しの時間を申告したら、それで割る**（設計書6.8.19。ノートPCの
 * 実機、2026-09-23）。所要時間の全体で割ると、読み込みの時間まで「書く遅さ」
 * として数える。CPUだけの機械では読み込みが時間の大半なので、1万字の
 * チャンクを送った回の速さは実際の書き出しの数分の1に出ていた。読み込みの
 * 速さを別に覚えるようになったので、ここで混ぜると見積もりで二重に数える。
 *
 * **申告しないAI（クラウド・LM Studio）は、これまでどおり全体で割る。**
 * その値は読み込みの時間を含んだ「1回ぶんの速さ」なので、見積もりの側は
 * 読み込みを足さない（読み込みの速さが台帳に入らないため、自然にそうなる）。
 */
function outputSpeedSample(
  result: GenerateResult
): { tokensPerSecond: number; source: SpeedSource } | undefined {
  // 途中で切られた応答は「その速さで書き切れた」ことにならない
  if (result.truncated) return undefined;

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

  // 書き出しの時間の申告は、トークン数の申告と対でしか意味を持たない
  const declared = result.usage?.outputDurationMs;
  const elapsedMs =
    useMeasured &&
    typeof declared === "number" &&
    Number.isFinite(declared) &&
    declared > 0
      ? declared
      : result.elapsedMs;

  if (tokens < MIN_SPEED_SAMPLE_TOKENS) return undefined;
  if (elapsedMs < MIN_SPEED_SAMPLE_MS) return undefined;

  // 式は一覧側と共用する（`core/tuningStats.ts`）。写すと片方だけ直る
  const tokensPerSecond = outputTokensPerSecond(tokens, elapsedMs);
  return tokensPerSecond === undefined ? undefined : { tokensPerSecond, source };
}

/**
 * 応答から、読み込みの速さ（トークン/秒）を採る（設計書6.8.19）。
 *
 * **AIが読み込みの時間を申告した回だけ**（いまは Ollama）。所要時間の全体
 * からは書き出しと切り分けられないので、申告の無いAIでは採らない——
 * 推定で埋めると、見積もりが書き出しの時間を二重に数える。
 *
 * **切り詰められた回からも採る。** 途中で切られるのは書き出しのほうで、
 * 読み込みは最後まで済んでいる（成功して返った回であることは変わらない）。
 */
function inputSpeedSample(result: GenerateResult): number | undefined {
  const tokens = result.usage?.inputTokens;
  const ms = result.usage?.inputDurationMs;
  if (typeof tokens !== "number" || !Number.isFinite(tokens)) return undefined;
  if (typeof ms !== "number" || !Number.isFinite(ms)) return undefined;
  if (tokens < MIN_INPUT_SPEED_SAMPLE_TOKENS) return undefined;
  if (ms < MIN_INPUT_SPEED_SAMPLE_MS) return undefined;
  // 丸め方は出力の速さと同じ式を使う（小数1桁）
  return outputTokensPerSecond(tokens, ms);
}

/** 前回の値から2割以上動いたか。**前回に無かった値が採れたら、動いたと数える** */
function changedEnough(
  previous: number | undefined,
  current: number | undefined
): boolean {
  if (current === undefined) return false;
  if (previous === undefined) return true;
  return Math.abs(current - previous) / previous >= SPEED_WRITE_CHANGE_RATIO;
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
