/**
 * 「あとどれくらいかかるか」の見当（設計書6.8.19）。
 *
 * ## なぜ要るか（作者の指摘、2026-09-20）
 *
 * 219話の作品に矛盾検知を掛けると**6時間規模**になる。ところが押す前に
 * 画面へ出ていたのは「210チャンク中 208件を処理します」だけで、**それが
 * 10分なのか6時間なのかはどこにも出ていなかった。** 走り出したあとも
 * ステータスバーは「42/210」だけである。
 *
 * 作者が決めたいのは「夜に回すか、いま回すか」であって、正確な秒数では
 * ない。**だから粒度は粗くてよく、代わりに当てずっぽうを書かない。**
 *
 * ## 出どころは2つ
 *
 * 1. **走っている最中**……済んだぶんの平均に、残りの件数を掛ける。
 *    実測なので、これがいちばん当たる
 * 2. **押す前**……速さの台帳（`core/modelTuning.ts` の
 *    `outputTokensPerSecond`）と、機能ごとの出力量の実測
 *    （`core/featureOutputTokens.ts`）から見積もる。**どちらかが
 *    無ければ数字を作らない**——見当が付かないことを、そのまま言う
 *
 * VS Code API に依存しない（台帳を読むのは呼び出し側＝`views/progress.ts`）。
 */

/**
 * 残りの見当を出し始めるまでの件数。
 *
 * **1件では、たまたま速かった回と区別が付かない。** 立ち上がりの遅れ
 * （モデルの読み込みなど）も1件目に丸ごと乗るので、そのまま残り208件へ
 * 掛けると何時間もずれる。3件あれば均されるうえ、実行前の案内で
 * 「数チャンク進んだところで目安を出します」と断った約束にも合う。
 */
export const MIN_ETA_SAMPLES = 3;

/**
 * 所要時間を、作者が読んで判断できる粒度で言う。
 *
 * **秒は出さない。** 「4時間28分53秒」は正確だが、そこまで細かい数字は
 * 判断の材料にならないうえ、1件進むたびに数字が踊って落ち着かない。
 *
 * 丸め方は長さで変える——短いうちは1分刻み、1時間を超えたら30分刻み。
 * 残り6時間のときに「5時間58分」と出しても、「およそ6時間」以上のことは
 * 何も言っていない。
 */
export function describeDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 60_000) return "1分未満";

  const raw = ms / 60_000;
  let minutes: number;
  if (raw < 10) {
    // 短いときだけ1分刻み。**0分にはしない**（「およそ0分」は無意味）
    minutes = Math.max(1, Math.round(raw));
  } else if (raw < 60) {
    minutes = Math.round(raw / 5) * 5;
  } else {
    minutes = Math.round(raw / 30) * 30;
  }

  // 丸めで60分へ届いたら時間へ繰り上げる（「およそ60分」とは言わない）
  if (minutes < 60) return `およそ${minutes}分`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `およそ${hours}時間` : `およそ${hours}時間${rest}分`;
}

/**
 * 済んだぶんの平均から、残りの所要時間を見積もる。
 *
 * **数字を作れないときは undefined を返す。** 呼び出し側はそれを
 * 「まだ言えない」と読んで、何も添えない。
 *
 * @param done これまでに終わった件数
 * @param total 全体の件数
 * @param elapsedMs 始めてからここまでの実時間
 */
export function estimateRemainingMs(
  done: number,
  total: number,
  elapsedMs: number
): number | undefined {
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return undefined;
  if (done < MIN_ETA_SAMPLES) return undefined;
  if (total <= done) return undefined;
  return (elapsedMs / done) * (total - done);
}

/**
 * 押す前の見積もり（トークン/秒 × 1回に書く量）。
 *
 * **どちらかが欠けたら undefined。** ここで既定値を置くと、測っていない
 * モデルにも数字が出てしまい、**当てずっぽうが実測の顔をして並ぶ。**
 *
 * @param count これからAIへ送る件数
 * @param outputTokensPerSecond そのモデルの出力の速さ（台帳の実測）
 * @param outputTokensPerCall その機能が1回に書くトークン数（実測の最大）
 */
export function estimateRunMs(
  count: number,
  outputTokensPerSecond: number | undefined,
  outputTokensPerCall: number | undefined
): number | undefined {
  if (!Number.isFinite(count) || count <= 0) return undefined;
  if (
    outputTokensPerSecond === undefined ||
    !Number.isFinite(outputTokensPerSecond) ||
    outputTokensPerSecond <= 0
  ) {
    return undefined;
  }
  if (
    outputTokensPerCall === undefined ||
    !Number.isFinite(outputTokensPerCall) ||
    outputTokensPerCall <= 0
  ) {
    return undefined;
  }
  return (outputTokensPerCall / outputTokensPerSecond) * count * 1000;
}

/**
 * 押す前の見積もりが、どこまで実測から来ているか（設計書6.8.19）。
 *
 * - `measured`……速さも書く量も、この機械での実測から出した
 * - `partial`……読み込みの速さは実測だが、書く側は決め打ちの秒数で埋めた
 * - `fixed`……速さを測っていないので、機能ごとの決め打ちの秒数だけで出した
 */
export type CallTimeSource = "measured" | "partial" | "fixed";

/** 押す前の見積もり。**出どころを必ず連れて歩く**（数字だけを渡さない） */
export interface CallTimeEstimate {
  readonly ms: number;
  readonly source: CallTimeSource;
}

/**
 * 押す前の所要時間を、**送る量と速さから**見積もる（設計書6.8.19）。
 *
 * ## なぜ送る量を見るか（ノートPCの実機、2026-09-23）
 *
 * CPUだけの Ollama（gemma4:e2b）で人物抽出を5チャンクに掛けると、確認画面は
 * 「目安 2 分程度」、**実際は約31分**だった（15倍）。目安は「1チャンク20秒」の
 * 決め打ちで、送る量をまったく見ていなかった。**CPUだけの機械では本文の
 * 読み込み（25〜28トークン/秒）が時間の大半**で、1万字のチャンクなら
 * 読むだけで数分かかる。
 *
 * ## 式
 *
 * 送る字数 × 字→トークン ÷ 読み込みの速さ ＋ 1回に書く量 ÷ 書き出しの速さ
 * を、回数ぶん足す。
 *
 * ## 速さが分からないとき
 *
 * - **読み込みの速さが無い**（クラウド・LM Studio・まだ測っていない）……
 *   書き出しの側だけで見る。普段の呼び出しで採る出力の速さは、応答全体の
 *   所要時間で割ったもので、**読み込みの時間を既に含んでいる**
 *   （`ai/meteredProvider.ts`）。足し直すと二重に数える
 * - **書き出しの側が分からない**……`fallbackSecondsPerCall` があれば
 *   その回数ぶんを足す（読み込みの実測があれば `partial`、無ければ `fixed`）
 * - **決め打ちも渡されない**……数字を作らない（`undefined`）。当てずっぽう
 *   が実測の顔をして並ぶのを避ける（`estimateRunMs` と同じ約束）
 *
 * **勝手に遅い値を仮定しない。** 分からないときに落ちる先は、これまで
 * 各機能が使っていた決め打ちの秒数そのものである。
 *
 * VS Code API に依存しない。台帳を引くのは呼び出し側
 * （`ai/runTimeEstimate.ts` の `estimateCallsTimeFor`）。
 */
export function estimateCallsTime(params: {
  /** 1回ごとに送る字数（指示や資料を含む、送るぶんそのもの）。長さが回数 */
  readonly inputChars: readonly number[];
  /** 1字あたりのトークン数（`core/sizeBudget.ts` の `resolveTokensPerChar`） */
  readonly tokensPerChar: number;
  /** 読み込みの速さ（トークン/秒）。AIが読み込みの時間を返したときだけ測れる */
  readonly inputTokensPerSecond?: number;
  /** 書き出しの速さ（トークン/秒。台帳の `outputTokensPerSecond`） */
  readonly outputTokensPerSecond?: number;
  /** その機能が1回に書くトークン数（機能ごとの実測） */
  readonly outputTokensPerCall?: number;
  /** 分からないときの、1回あたりの決め打ちの秒数。無ければ数字を作らない */
  readonly fallbackSecondsPerCall?: number;
}): CallTimeEstimate | undefined {
  const count = params.inputChars.length;
  if (count === 0) return undefined;

  const inputSpeed = positiveOrUndefined(params.inputTokensPerSecond);
  const outputSpeed = positiveOrUndefined(params.outputTokensPerSecond);
  const perCall = positiveOrUndefined(params.outputTokensPerCall);
  const tokensPerChar = positiveOrUndefined(params.tokensPerChar);
  const fallback = positiveOrUndefined(params.fallbackSecondsPerCall);

  const inputKnown = inputSpeed !== undefined && tokensPerChar !== undefined;
  const outputKnown = outputSpeed !== undefined && perCall !== undefined;

  if (!inputKnown && !outputKnown) {
    return fallback === undefined
      ? undefined
      : { ms: count * fallback * 1000, source: "fixed" };
  }

  let inputMs = 0;
  if (inputKnown) {
    // 字数の壊れた要素（負・NaN）は0字として数える。1件のせいで全体を捨てない
    const chars = params.inputChars.reduce(
      (total, value) =>
        total + (Number.isFinite(value) && value > 0 ? value : 0),
      0
    );
    inputMs = inputReadMs(chars, tokensPerChar, inputSpeed) ?? 0;
  }

  if (outputKnown) {
    const outputMs = (perCall / outputSpeed) * count * 1000;
    return { ms: inputMs + outputMs, source: "measured" };
  }
  // 読み込みは分かるが、書く側が分からない。決め打ちで埋めるか、作らないか
  if (fallback === undefined) return undefined;
  return { ms: inputMs + count * fallback * 1000, source: "partial" };
}

/**
 * 読み込みにかかる時間（ミリ秒）。字数 × 字→トークン ÷ 読み込みの速さ。
 * どれかが分からなければ undefined。
 *
 * **式はここ1か所**。確認画面の目安（上の `estimateCallsTime`）と、チャンクの
 * 大きさを待ち時間に収める側（`core/chunkTimeFit.ts`）が同じものを使う——
 * 写しを作ると、目安は「収まる」と言うのに大きさは縮む、という食い違いになる。
 */
export function inputReadMs(
  chars: number,
  tokensPerChar: number | undefined,
  inputTokensPerSecond: number | undefined
): number | undefined {
  const speed = positiveOrUndefined(inputTokensPerSecond);
  const perChar = positiveOrUndefined(tokensPerChar);
  if (speed === undefined || perChar === undefined) return undefined;
  const safeChars = Number.isFinite(chars) && chars > 0 ? chars : 0;
  return ((safeChars * perChar) / speed) * 1000;
}

/**
 * 押す前の目安を、確認画面の言い方（「目安 ◯ 分程度」）で言う。
 *
 * **分は切り上げる**（これまでの `Math.ceil(秒 / 60)` と同じ）。1分に
 * 満たない見積もりを「0分」と言わないため。
 *
 * **出どころを必ず添える**（実装ルール6の例外条件3と同じ流儀）。決め打ちの
 * 数字に、実測と同じ顔をさせない——ノートPCの実機では、決め打ちの
 * 「2分」をそのまま信じて31分待たされた。
 */
export function describeCallTimeEstimate(estimate: CallTimeEstimate): string {
  const minutes = Math.max(1, Math.ceil(estimate.ms / 60_000));
  const label = CALL_TIME_SOURCE_LABEL[estimate.source];
  // 1時間を超えたら、進み具合の表示と同じ言い方（「およそ8時間」）にそろえる。
  // 実測の速さで見積もると、CPUだけの機械では何百分にもなる——
  // 「目安 480 分程度」は、読んでから割り算させる数字になる
  if (minutes >= 60) {
    return `目安 ${describeDuration(estimate.ms)}（${label}）`;
  }
  return `目安 ${minutes} 分程度（${label}）`;
}

/** 出どころごとの名乗り。**決め打ちが混ざったなら、必ずそう言う** */
const CALL_TIME_SOURCE_LABEL: Readonly<Record<CallTimeSource, string>> = {
  measured: "これまでの実測から",
  partial: "読み込みは実測、書き出しはまだ測っていないので決め打ちの見込みです",
  fixed: "この機械ではまだ速さを測っていないので、決め打ちの見込みです",
};

function positiveOrUndefined(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

/**
 * 見積もりに使った、1回あたりの出力量の出どころ。
 *
 * **「同梱かどうか」ではなく「最大か平均か」で分ける**（0.71.5）。
 * 0.71.4 では同梱かどうかで名乗りを分けたが、**台帳の最大も同じだけ
 * 過大**なので、線を引く場所が違っていた。
 */
export type RunTimeEstimateBasis =
  /** この機械の実測の**平均**。普段の量なので、そのまま読んでよい */
  | "average"
  /** この機械の実測の**最大**。実測ではあるが、必ず多めに出る */
  | "max"
  /** 同梱の表の**最大**（`core/bundledTuning.ts`）。この機械では測っていない */
  | "bundled-max";

/**
 * 押す前の見積もりを、**出どころつきで**言う（実装ルール6の例外条件3）。
 *
 * **2026-09-21、実機で外した。** プロット逸脱を10話に掛けると
 * 「10件 ≒ およそ15分（**これまでの実測から**）」と出たが、**実際は39秒**
 * だった。作者が「15分なら夜に回そう」と判断してもおかしくない差である。
 *
 * **数字が嘘だったのではない。** 1回あたりの出力量は「切り詰められていない
 * 回の実測の**最大**」だった。**容量の見積もりには最大が正しい**——足りな
 * ければ落ちるのだから。**だが所要時間に最大を使えば、必ず過大になる。**
 *
 * 0.71.5 で、台帳が平均も覚えるようにした（`core/featureOutputTokens.ts`）。
 * 平均が使えたときだけ「これまでの実測から」と名乗り、**最大へ落ちたときは、
 * 同梱でなくても「多めに見ています」と言う。** 名乗りを変えるだけでは、
 * 作者は15分という数字をそのまま受け取る。割り引いて読めるようにしておく。
 */
export function describeRunTimeEstimate(params: {
  /** これからAIへ送る件数 */
  readonly count: number;
  /** 数えているもの。話ごとに送る検知は「話」 */
  readonly unit: string;
  /** 見積もった所要時間。**見当が付かなければ `undefined`** */
  readonly ms: number | undefined;
  /** 1回あたりの出力量を、どこから採ったか */
  readonly basis: RunTimeEstimateBasis;
}): string {
  if (params.ms === undefined) {
    return (
      "このモデルでどれくらいかかるかは、まだ測っていないので見当が付きません。\n" +
      `${MIN_ETA_SAMPLES}${params.unit}進んだところで、残り時間の目安を出します。`
    );
  }
  const source = RUN_TIME_BASIS_LABEL[params.basis];
  return `${params.count}件 ≒ ${describeDuration(params.ms)}（${source}）`;
}

/** 出どころごとの名乗り。**最大を使ったなら、必ず「多め」と言う** */
const RUN_TIME_BASIS_LABEL: Readonly<Record<RunTimeEstimateBasis, string>> = {
  average: "これまでの実測から",
  max: "これまでの実測の最大から。多めに見ています",
  "bundled-max": "同梱の目安から。多めに見ています",
};
