import { bundledFeatureOutput } from "./bundledTuning";
import { tuningStoreTable, writeTuningEntry } from "./modelTuningStore";

/**
 * **機能ごと**の「1回の応答に何トークン書くか」の台帳（設計書6.77の第3段）。
 *
 * ## なぜ要るか（作者の裁定、2026-09-19「実測から決める」）
 *
 * 出力に見込むトークン数を、計画と関所が**別々に持っていた。**
 *
 * - 計画（`ai/outputLimit.ts` の `resolveOutputTokensForPlanning`）
 *   ……`min(設定16,384, OUTPUT_RESERVE_TOKENS 8,192)` ＝ **8,192**
 * - 関所（`ai/meteredProvider.ts` の `outputTokensFor`）
 *   ……上限を送るプロバイダでは実送信の上限 ＝ **16,384**
 *
 * 計画のほうが 8,192 トークン甘いので、**計画いっぱいに詰めたチャンクが
 * 関所に断られて割られる**のが常態だった（実機、2026-09-19。さくらが
 * 2チャンクに割れて第5話の人物を取り違えた）。どちらの数字も
 * **測った値ではなく、置いた値**だったのが根である。
 *
 * ここは「置いた値」を「測った値」に替えるための台帳で、
 * **計画・関所・実送信の上限が、そろってここから引く。**
 *
 * ## 鍵は機能だけ（モデルで分けない）
 *
 * 出力の量を決めているのは、モデルではなく**仕事の大きさ**である
 * ——誤字脱字の指摘は本文の誤字の数だけ返り、各話あらすじは話数だけ返る。
 * `機能×プロバイダ×モデル` で分けると実測が散らばり、**いつまでも件数が
 * しきい値に届かない**（作者が使うプロバイダは6つ、モデルはその中で
 * さらに分かれる）。
 *
 * **モデルの側の事情は、別の欄が既に持っている**——台帳の
 * `measuredOutputTokens`（そのモデルが書ける量の実測）である。
 * 見込みを決めるときは、両方の小さいほうを採る（`ai/outputLimit.ts`）。
 *
 * ## 覚え方は `charsPerToken` をそのまま真似る
 *
 * 普段の呼び出しから自動で採り（`ai/meteredProvider.ts` の関所）、
 * **件数を持ち、件数がしきい値に届くまで信じない。** 違うのは、
 * 覚えるのが最小値ではなく**最大値**だという1点だけである
 * ——字/トークンは小さく見るほうが安全側だが、こちらは**小さく見ると
 * 応答が切れて、そのチャンクが丸ごと捨てられる。** 安全側の向きが逆なので、
 * 覚える端も逆になる。
 *
 * ## 置き場は、モデルの台帳と同じファイル
 *
 * `core/modelTuningStore.ts`（`<拡張機能の保管庫>/model-tuning.json`）を
 * そのまま使い、鍵の頭に印（`出力見込み/`）を付けて住み分ける。
 * **写しを作らない**のが理由で、あのファイルは「順番に1つずつ書く・書いた
 * あと読み直して確かめる・消えていたらやり直す」という、2つの窓を同時に
 * 開いても消えないための守りを持っている（0.66.6 で作者の測定が消えた件）。
 * 同じものを2つ目のファイルへ書き直すと、直すときに片方だけ直る。
 */

/**
 * 機能の行に付ける、鍵の頭。
 *
 * **モデルの鍵（`プロバイダID/モデル名`）と混ざらないようにする印。**
 * `core/modelTuning.ts` の `parseModelTuning` はこの頭を持つ行を読み飛ばす
 * ので、モデルの一覧（AIチューニングの実測一覧）に機能の行が紛れ込むことは
 * ない。**消す画面（`features/forgetTuning.ts`）には出る**——あちらは生の
 * 鍵を並べるので、「出力見込み / typo_check」として選んで消せる。
 */
export const FEATURE_OUTPUT_KEY_PREFIX = "出力見込み/";

/** 台帳を引くときの鍵 */
export function featureOutputKey(feature: string): string {
  return `${FEATURE_OUTPUT_KEY_PREFIX}${feature}`;
}

/**
 * 実測に上乗せする余裕。
 *
 * **最大値ちょうどでは、次の1回で超える。** かといって大きく取ると、
 * そのぶん本文に使える場所が減ってチャンクが痩せる（設計書6.27.10）。
 *
 * 25%にした根拠は、作者の実測（`.aiwriter/logs/usage.md`、2026-09-19）の
 * **ばらつきの出方**である。
 *
 * - いちばん回数の多い設定資料の抽出（6回）は、中央値11,445に対して
 *   最大12,023——**振れ幅は5%**。上乗せ25%はその5倍を見ていることになる
 * - いちばん荒れた逸脱検知（5回）は、中央値3,518に対して最大9,758。
 *   **中央値からの伸びを見込むなら2.8倍**要るが、それでは全機能が設定値に
 *   張り付いて、測った意味が無くなる。**見込むのは中央値ではなく最大値**
 *   なので、荒れた機能ほど既に大きい値を採っている
 * - どの機能も実測が1〜6回しか無い。まだ見ていない上振れはあるが、
 *   足りなければ**切り詰められたことが記録に残り、その機能は設定値へ戻る**
 *   （`recordFeatureOutputTokens` の `truncated`）。取り返しはつく
 */
export const FEATURE_OUTPUT_MARGIN = 1.25;

/**
 * 見込みを丸める刻み。
 *
 * 端数の付いた上限（15,029 など）には意味が無い。`MINIMUM_OUTPUT_TOKENS`
 * と同じ 1,024 で切り上げると、読める値になり、**上乗せもそのぶん増える**
 * （実際の余裕は25〜50%になる）。切り上げなので、丸めで下がることは無い。
 */
export const FEATURE_OUTPUT_STEP = 1024;

/**
 * これだけ実測が貯まるまで、見込みに使わない。
 *
 * **1回では「たまたま短かった回」と区別が付かない。** 短い回を根拠に
 * 上限を下げると、次の長い回が切れて丸ごと捨てられる。字/トークンの
 * `MIN_CHARS_PER_TOKEN_SAMPLES`（`core/sizeBudget.ts`）と同じ考え方で、
 * **届くまでは従来どおり（設定値）で動く**——悪くならない。
 */
export const MIN_FEATURE_OUTPUT_SAMPLES = 3;

/** 1機能ぶんの記録。**どれも省略できる**（採れたものだけ入る） */
export interface FeatureOutputTuning {
  /** 切り詰められていない回の、実測の最大トークン数 */
  readonly outputTokens?: number;
  /**
   * 切り詰められていない回の、実測の**平均**トークン数（0.71.5 で追加）。
   *
   * **最大と用途が違う。** 上の `outputTokens` は容量の見積もり
   * （`featureOutputCeiling`）のためのもので、**足りなければ応答が切れて
   * そのチャンクが丸ごと捨てられる**から最大が正しい。だが
   * **所要時間の見積もりに最大を使えば、必ず過大になる。**
   *
   * 2026-09-21、実機で外した——プロット逸脱を10話に掛けると
   * 「10件 ≒ およそ15分」と出て、**実際は39秒**だった。しかも覚える値が
   * 最大なので、**使うほど見積もりは伸びる。**放っておいて直らない。
   *
   * **見るのは時間の見積もり（`views/progress.ts`）だけ。** 容量の側は
   * この欄を一切見ない（見たら、足りなくて落ちる側へ倒れる）。
   *
   * 整数に丸めて持つ。トークンは整数で、台帳は作者が開いて読めるファイル
   * なので、`366.6666666666667` のような値を残す意味が無い。**丸めの誤差は
   * 1回あたり0.5トークン未満**で、「およそ5分」の粒度には響かない。
   */
  readonly outputTokensAverage?: number;
  /** それを何回ぶんから採ったか（`charsPerTokenSamples` と同じ数え方） */
  readonly outputTokenSamples?: number;
  /**
   * **一度でも出力上限で切り詰められた**か。
   *
   * 切られた回の `completion_tokens` は上限そのものなので、「要った量」
   * ではない。むしろ「**上限以上に要る**」という、実測とは逆向きの証拠で
   * ある。印が付いている機能は見込みを出さず、設定値に任せる。
   *
   * **印は消えない。** 一度足りなかった機能をこちらの判断で絞り直すと、
   * 同じことがもう一度起きる。測り直したいときは、詳細メニューの
   * 「AIチューニングの記録を消す」でその行を消す。
   */
  readonly outputTruncated?: true;
  /** 最後に書いた時刻（ISO 8601）。古い記録だと分かるように残す */
  readonly measuredAt?: string;
  /** この行が**同梱の初期値**か（読むときにだけ付く印。台帳には書かない） */
  readonly bundled?: true;
}

/**
 * その機能の記録。**同梱の初期値（`core/bundledTuning.ts`）を混ぜて返す。**
 *
 * **作者の実測が常に勝つ。** モデルの側（`mergeBundledTuning`）は欄ごとに
 * 埋めるが、こちらは**行ごと**である——`outputTokens` と
 * `outputTokenSamples` は必ず一緒に書かれる対なので、片方だけ同梱から
 * 借りると「作者の最大値を、同梱の件数で信じる」という、どちらの実測でも
 * ない数字になる。
 */
export function featureOutputTuning(
  feature: string | undefined
): FeatureOutputTuning | undefined {
  if (feature === undefined || feature.length === 0) return undefined;

  const own = featureOutputTuningRaw(feature);
  if (own !== undefined) return own;

  const seed = bundledFeatureOutput(feature);
  if (!seed) return undefined;
  // **同梱の表に平均は無い**（集計したのが最大だけだった）。無いままにする
  // ——ここで最大を平均として置くと、時間の見積もりが同梱の最大に戻る
  return {
    outputTokens: seed.outputTokens,
    outputTokenSamples: seed.samples,
    measuredAt: seed.measuredAt,
    bundled: true,
  };
}

/**
 * **同梱を混ぜずに**、台帳そのものを引く。
 *
 * 使うのは書き込み側だけである。混ぜたものを土台にすると、同梱の件数が
 * 数え始めになり（1回測っただけで「7回ぶん」になる）、同梱の最大値が
 * 作者の実測に勝ち続ける——`modelTuningRaw` を分けたのと同じ理由。
 */
export function featureOutputTuningRaw(
  feature: string
): FeatureOutputTuning | undefined {
  const raw = tuningStoreTable()[featureOutputKey(feature)];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return undefined;
  }
  const entry = raw as Record<string, unknown>;
  const outputTokens = positiveNumber(entry.outputTokens);
  const outputTokensAverage = positiveNumber(entry.outputTokensAverage);
  const outputTokenSamples = positiveNumber(entry.outputTokenSamples);
  const outputTruncated = entry.outputTruncated === true ? true : undefined;
  const measuredAt =
    typeof entry.measuredAt === "string" && entry.measuredAt.trim().length > 0
      ? entry.measuredAt
      : undefined;
  if (
    outputTokens === undefined &&
    outputTokensAverage === undefined &&
    outputTokenSamples === undefined &&
    outputTruncated === undefined
  ) {
    // 読める中身が1つも無い行は、持っていても引く値が無い
    return undefined;
  }
  return {
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(outputTokensAverage !== undefined ? { outputTokensAverage } : {}),
    ...(outputTokenSamples !== undefined ? { outputTokenSamples } : {}),
    ...(outputTruncated !== undefined ? { outputTruncated } : {}),
    ...(measuredAt !== undefined ? { measuredAt } : {}),
  };
}

/**
 * その機能に見込む出力トークン数。**分からなければ undefined。**
 *
 * 分からないときに数字を作らないのが要点である——呼び出し側
 * （`ai/outputLimit.ts`）は undefined を「これまでどおり」と読む。
 * ここで当て推量を返すと、測っていない機能の挙動まで静かに変わる。
 */
export function featureOutputCeiling(
  feature: string | undefined
): number | undefined {
  const tuning = featureOutputTuning(feature);
  if (!tuning) return undefined;
  // 上限に当たった実績がある機能は、要る量を知らない（上の `outputTruncated`）
  if (tuning.outputTruncated === true) return undefined;
  const max = tuning.outputTokens;
  if (max === undefined) return undefined;
  if ((tuning.outputTokenSamples ?? 0) < MIN_FEATURE_OUTPUT_SAMPLES) {
    return undefined;
  }
  return Math.ceil((max * FEATURE_OUTPUT_MARGIN) / FEATURE_OUTPUT_STEP) *
    FEATURE_OUTPUT_STEP;
}

/**
 * 1回の応答から、実測を台帳へ足す（`ai/meteredProvider.ts` の関所が呼ぶ）。
 *
 * **最大と平均の両方を覚える。** 最大は容量のため、平均は所要時間のため
 * （上の `outputTokensAverage`）。**最大の決め方は0.71.5でも1文字も変えて
 * いない**——容量の見積もりがそこにぶら下がっている。
 *
 * ## 書き込みの抑制をやめた（0.71.5、リーダーの判断）
 *
 * 0.71.4 までは「最大が上がらず、件数もしきい値に届いているなら書かない」
 * と抑えていた。**平均は毎回動くので、そのままでは追随できない**
 * ——短い回が何回続いても平均が下がらず、見積もりは伸びたきり戻らない。
 *
 * 抑制を外すぶん、呼び出しごとに小さなJSONが1回書かれる。**これに付随して
 * いるのはAIの呼び出し（数秒〜数分）**なので、そこに1回の書き込みを足しても
 * 作者には分からない（実装ルール4「処理量を節約する」は、**AIへ送る量**を
 * 指している。ディスクの数キロバイトは同じ天秤に載らない）。
 *
 * おかげで `outputTokenSamples` は**呼び出し回数そのもの**になった
 * （0.71.4 までは、上がった回しか数えていなかった）。
 *
 * **`outputTruncated` の扱いは変えない。** 切られた回の量は「要った量」
 * ではないので、最大にも平均にも混ぜない。
 *
 * **投げない。** 見込みが更新できなかっただけで、AIの応答は作者へ返す。
 * 失敗の中身は呼び出し側が記録に残す（CLAUDE.md 規則5）。
 */
export async function recordFeatureOutputTokens(
  feature: string | undefined,
  tokens: number,
  truncated: boolean
): Promise<void> {
  if (feature === undefined || feature.length === 0) return;
  if (!Number.isFinite(tokens) || tokens <= 0) return;

  const current = featureOutputTuningRaw(feature);
  const now = new Date().toISOString();

  if (truncated) {
    // 既に印が付いているなら、書き直す意味が無い
    if (current?.outputTruncated === true) return;
    await writeTuningEntry(featureOutputKey(feature), {
      outputTruncated: true,
      measuredAt: now,
    });
    return;
  }

  const previous = current?.outputTokens;
  const samples = current?.outputTokenSamples ?? 0;
  const next = previous === undefined ? tokens : Math.max(previous, tokens);

  /*
    移動平均。件数を重みにして、これまでの平均へ今回を1件ぶん混ぜる。

    **平均がまだ無い行（0.71.4 以前に書かれた行）は、今回の値から始める。**
    その行の件数は既にいくつか立っているので、次の1回では今回の値が重く
    効く。厳密ではないが、**一度も測っていない機能に数字を作るよりはよい**
    ——数回まわれば普段の量へ寄る。
  */
  const previousAverage = current?.outputTokensAverage;
  const average =
    previousAverage === undefined
      ? tokens
      : (previousAverage * samples + tokens) / (samples + 1);

  await writeTuningEntry(featureOutputKey(feature), {
    outputTokens: next,
    outputTokensAverage: Math.round(average),
    outputTokenSamples: samples + 1,
    measuredAt: now,
  });
}

/**
 * 正の有限数のときだけ返す（`core/modelTuning.ts` の `positiveNumber` と
 * 同じ約束。**あちらは `vscode` を引き込むので、借りずに置く**）。
 */
function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}
