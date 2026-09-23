import { MIN_CHUNK_CHARS } from "./chunker";
import { estimateRunMs, inputReadMs } from "./etaEstimate";

/**
 * **チャンクの大きさを、測った速さから待ち時間の上限に収まる大きさにする**
 * （作者の裁定、2026-09-23。残課題 A8。設計書6.23）。
 *
 * ## なぜ要るか
 *
 * CPUだけのノートPC（gemma4:e2b。読み込み約26.7・書き出し約6.3トークン/秒）
 * では、抽出の13,000字のチャンクが526秒かかった。当時の上限600秒まで74秒
 * しか無く、少し重い回が来れば切れる。チャンクの大きさはモデルの
 * コンテキスト長からしか決めておらず、**機械の遅さを見ていなかった。**
 *
 * ## 式
 *
 * 1回の所要時間 ＝（指示や資料 ＋ 本文）× 字→トークン ÷ 読み込みの速さ
 *               ＋ 1回に書く量 ÷ 書き出しの速さ
 *
 * **式は確認画面の目安（`core/etaEstimate.ts` の `estimateCallsTime`）と同じ
 * ものを使う**——写しを作ると、目安は「収まる」と言うのに大きさは縮む、
 * といった食い違いが生まれる。
 *
 * - **読み込みの速さが測れていなければ、何もしない**（これまでどおり）。
 *   読み込みの速さはAIが自分で申告した回からしか採らない（いまは Ollama）
 * - **1回に書く量が測れていなければ、読み込みの時間だけで見る**。これは
 *   所要時間の下限なので、「読むだけで上限を超える」大きさだけを確実に削る。
 *   当て推量で書く量を足して、測っていない機械のチャンクを縮めすぎない
 *
 * ## 余白と揺れ止め
 *
 * - 目標は**上限の7割**（`CHUNK_TIME_FIT_RATIO`）。速さは直近の実測1回で、
 *   話によって書く量も変わるので、ぴったりに合わせると半分の回で切れる
 * - **大きさは決まった段（`CHUNK_TIME_LADDER`）から選ぶ。** チャンクの大きさが
 *   変わると内容ハッシュが総入れ替えになり、処理済みのキャッシュが全部外れる。
 *   速さが少し揺れるたびに1字単位で動くと、毎回全部やり直しになる
 * - **前回選んだ段を覚えておき、よほどでなければ動かさない**（履歴つきの
 *   切り替え）。前回の段が上限の8割を超える見込みになったら縮め、1段上が
 *   上限の6割に楽に収まるほど速くなったら広げる。その間は前回のまま
 *
 * VS Code API に依存しない（台帳を読むのは呼び出し側＝`features/chunkSettings.ts`）。
 */

/** 目標：1回の所要時間を、待ち時間の上限のこの割合に収める */
export const CHUNK_TIME_FIT_RATIO = 0.7;

/**
 * 前回の段を捨てて縮め直す線。**上限の8割を超える見込み**になったら。
 *
 * 7割と8割の間は「前回のまま」にする。ここを7割にすると、速さが1%揺れた
 * だけで段が動く（境目の真上にいるとき）。
 */
export const CHUNK_TIME_SHRINK_RATIO = 0.8;

/**
 * 前回の段より広げ直す線。**1段上が上限の6割に収まる**ほど速くなったら。
 *
 * 広げる側は急がない。広げたあとで少し遅い回が来て縮め直すと、キャッシュが
 * 2回外れる。
 */
export const CHUNK_TIME_GROW_RATIO = 0.6;

/**
 * 選んでよい大きさの段（字。大きい順）。
 *
 * 隣どうしがおよそ2割ずつ違う。**段の間隔が揺れ止めの幅**になる——速さが
 * 数%揺れても、たいていは同じ段に落ちる。作者がログで読む数字なので、
 * 切りのよい値にしてある。いちばん下は `MIN_CHUNK_CHARS`（それより小さく
 * すると1文の途中で切れて誤検出のもとになる）。
 */
export const CHUNK_TIME_LADDER: readonly number[] = [
  20000,
  16000,
  13000,
  10000,
  8000,
  6500,
  5000,
  4000,
  3000,
  2000,
  MIN_CHUNK_CHARS,
];

/** 見込みに使う速さ。**どれも台帳の実測**（`ai/runTimeEstimate.ts` が引く） */
export interface ChunkTimeSpeeds {
  /** 読み込みの速さ（トークン/秒）。無ければ見込まない */
  readonly inputTokensPerSecond?: number;
  /** 書き出しの速さ（トークン/秒） */
  readonly outputTokensPerSecond?: number;
  /** その機能が1回に書く量（トークン。実測の平均）。無ければ読み込みだけで見る */
  readonly outputTokensPerCall?: number;
  /** 1字あたりのトークン数（`core/sizeBudget.ts` の `resolveTokensPerChar`） */
  readonly tokensPerChar: number;
}

/**
 * その大きさのチャンク1回に、何秒かかる見込みか。見込めなければ undefined。
 *
 * @param chunkChars 本文の字数
 * @param overheadChars 毎回いっしょに送る指示や資料の字数
 */
export function predictChunkSeconds(
  chunkChars: number,
  overheadChars: number,
  speeds: ChunkTimeSpeeds
): number | undefined {
  /*
    **確認画面の目安と同じ部品で数える**（`core/etaEstimate.ts`）。読み込みは
    `inputReadMs`、書き出しは `estimateRunMs`（1回ぶん）——`estimateCallsTime`
    の中身と同じ式である。書く量が分からないときは書き出しを足さない
    （読み込みだけ＝所要時間の下限）。
  */
  const readMs = inputReadMs(
    Math.max(0, chunkChars) + Math.max(0, overheadChars),
    speeds.tokensPerChar,
    speeds.inputTokensPerSecond
  );
  if (readMs === undefined) return undefined;
  const writeMs =
    estimateRunMs(1, speeds.outputTokensPerSecond, speeds.outputTokensPerCall) ?? 0;
  return (readMs + writeMs) / 1000;
}

/** 大きさを決めた結果 */
export interface ChunkTimeFit {
  /** 使う大きさ（字）。**望みの字数を超えない** */
  readonly chars: number;
  /** その大きさでの見込み（秒） */
  readonly predictedSeconds: number;
  /** 目標の秒数（上限 × `CHUNK_TIME_FIT_RATIO`） */
  readonly targetSeconds: number;
  /**
   * - `fits`……望みの字数のままで収まる（または前回どおりそのまま）
   * - `shrunk`……収まるように段を下げた
   * - `minimum`……いちばん小さい段でも収まらない見込み（それでも送る）
   */
  readonly reason: "fits" | "shrunk" | "minimum";
}

/**
 * 待ち時間の上限に収まる大きさを、段から選ぶ。**決められなければ undefined**
 * （呼び出し側はこれまでどおりの大きさを使う）。
 *
 * 候補は「望みの字数」と、それより小さい段。**望みの字数より大きくはしない**
 * ——この関数は時間に収めるためのもので、太らせるためのものではない。
 */
export function fitChunkCharsToTimeout(params: {
  /** これまでの決め方で決まった字数（自動・手動・未チューニングの抑え込みの後） */
  readonly requestedChars: number;
  /** その呼び出しで待つ秒数（いま効いている待ち時間） */
  readonly timeoutSeconds: number;
  /** 毎回いっしょに送る指示や資料の字数。分からなければ0 */
  readonly overheadChars: number;
  readonly speeds: ChunkTimeSpeeds;
  /** 前回この機能・このモデルで選んだ大きさ。揺れ止めに使う */
  readonly previousChars?: number;
}): ChunkTimeFit | undefined {
  const { requestedChars, timeoutSeconds, overheadChars, speeds } = params;
  if (!positive(requestedChars)) return undefined;
  if (!positive(timeoutSeconds)) return undefined;
  if (predictChunkSeconds(requestedChars, overheadChars, speeds) === undefined) {
    return undefined;
  }

  const seconds = (chars: number): number =>
    predictChunkSeconds(chars, overheadChars, speeds) ?? Number.POSITIVE_INFINITY;
  const candidates = [
    requestedChars,
    ...CHUNK_TIME_LADDER.filter((rung) => rung < requestedChars),
  ];
  const target = timeoutSeconds * CHUNK_TIME_FIT_RATIO;

  /** 目標に収まるいちばん大きい候補。無ければいちばん小さい候補 */
  const freshPick = (): number =>
    candidates.find((chars) => seconds(chars) <= target) ??
    candidates[candidates.length - 1];

  let chosen = freshPick();
  const previous = params.previousChars;
  const previousIndex =
    previous === undefined ? -1 : candidates.indexOf(previous);
  if (previous !== undefined && previousIndex >= 0) {
    const tooSlow =
      seconds(previous) > timeoutSeconds * CHUNK_TIME_SHRINK_RATIO;
    const above = previousIndex > 0 ? candidates[previousIndex - 1] : undefined;
    const roomToGrow =
      above !== undefined &&
      seconds(above) <= timeoutSeconds * CHUNK_TIME_GROW_RATIO;
    // どちらでもなければ前回のまま（ここが揺れ止め）
    if (!tooSlow && !roomToGrow) chosen = previous;
  }

  const predictedSeconds = seconds(chosen);
  const reason: ChunkTimeFit["reason"] =
    chosen === requestedChars
      ? "fits"
      : predictedSeconds > target &&
          chosen === candidates[candidates.length - 1]
        ? "minimum"
        : "shrunk";
  return { chars: chosen, predictedSeconds, targetSeconds: target, reason };
}

function positive(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value > 0;
}
