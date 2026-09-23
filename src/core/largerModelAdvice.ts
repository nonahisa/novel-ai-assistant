import { parameterSizeInBillions } from "../ai/types";
import { isLocalProviderId } from "./localProviders";
import {
  describeRunTimeEstimate,
  estimateCallsTime,
  type RunTimeEstimateBasis,
} from "./etaEstimate";
import {
  accuracyRate,
  accuracyRecordFor,
  BUNDLED_FEATURE_ACCURACY,
  describeAccuracyComparison,
  type AccuracyFeature,
  type FeatureAccuracyRecord,
} from "./bundledFeatureAccuracy";

/**
 * **この機械で待ち時間の上限内に終わる、いちばん大きいモデル**を探す
 * （作者の裁定、2026-09-23。A3④）。
 *
 * 作者の問い「パソコンの性能を自動で見て可能なら上位を勧めることは
 * 可能ですか？」への答え。**押したときに案内して選ばせる**——勝手には
 * 切り替えない。
 *
 * ## 何から決めるか
 *
 * | 決めるもの | 出どころ |
 * |---|---|
 * | 入っているモデルと大きさ | AI の API（Ollama の `/api/tags`・`/api/show` の `parameter_size`）。**名前で決め打ちしない** |
 * | この機械での速さ | 台帳の実測（`inputTokensPerSecond`・`outputTokensPerSecond`）。**測っていなければ時間を作らない** |
 * | 1回の待ち時間の上限 | `maxTimeoutSeconds(providerId)`（手元1800秒） |
 * | 当たりの記録 | 同梱の測定（`core/bundledFeatureAccuracy.ts`）。**あれば添えるだけ**で、順位には使わない |
 *
 * ## 勧めないもの
 *
 * - **クラウドのAIを割り当てているとき**（手元のモデルの話である）
 * - いまのモデルの大きさが分からないとき（大きいかどうかを比べられない）
 * - 大きさの分からないモデル（比べられない）
 * - **クラウドへ中継するモデル**（Ollama の `…-cloud`／`…:cloud`）。手元の
 *   AIを選んでいる作者の原稿を、案内1つで外へ出さない
 * - **同梱の記録が「当たらない」と言っているもの**——記録が0件当たり、または
 *   いまのモデルの記録以下（大きいだけで当たらないモデルが実際にあった。
 *   `granite4.2:30b` は誤字脱字 0/12）
 *
 * VS Code API に依存しない（台帳・API を引くのは `features/largerModelOffer.ts`）。
 */

/** 手元に入っているモデル（API が返したもの） */
export interface InstalledModel {
  readonly id: string;
  /** API が申告したパラメータ数の表記（"25.2B" など）。無ければ null */
  readonly parameterSize: string | null;
}

/** 見込みに使う速さ。**どれも台帳の実測**（`ai/runTimeEstimate.ts` の `lookupCallSpeeds`） */
export interface CandidateSpeeds {
  readonly inputTokensPerSecond?: number;
  readonly outputTokensPerSecond?: number;
  /** その機能が1回に書く量 */
  readonly outputTokensPerCall?: number;
  readonly tokensPerChar: number;
  /** 1回に書く量の出どころ（平均・最大・同梱の最大） */
  readonly basis: RunTimeEstimateBasis;
}

/** 上限内に終わる見込みの候補 */
export interface FittingModel {
  readonly id: string;
  readonly parameterSize: string;
  /** 全件の見込み（ミリ秒） */
  readonly totalMs: number;
  /** いちばん長い1回の見込み（ミリ秒）。上限と比べたもの */
  readonly longestCallMs: number;
  readonly basis: RunTimeEstimateBasis;
  /** 同梱の当たりの記録（いまの版のもの）。無ければ undefined */
  readonly record?: FeatureAccuracyRecord;
}

/** 速さを測っていないので、所要時間が分からない候補 */
export interface UnmeasuredModel {
  readonly id: string;
  readonly parameterSize: string;
  readonly record?: FeatureAccuracyRecord;
}

export interface LargerModelAdvice {
  /** いまのモデル（比べる相手） */
  readonly current: {
    readonly id: string;
    readonly parameterSize: string;
    readonly record?: FeatureAccuracyRecord;
  };
  /** 上限内に終わる見込みの、いちばん大きいモデル */
  readonly fits?: FittingModel;
  /**
   * `fits` より大きいのに、**速さを測っていない**いちばん大きいモデル。
   * 「一度測ってみますか」を出す相手（当て推量の時間は出さない）
   */
  readonly unmeasured?: UnmeasuredModel;
}

export function adviseLargerModel(params: {
  readonly providerId: string;
  readonly feature: AccuracyFeature;
  /** いまのプロンプトの版（記録が古くないかを見る） */
  readonly promptVersion: string;
  readonly current: InstalledModel;
  readonly installed: readonly InstalledModel[];
  /** 1回の待ち時間の上限（秒） */
  readonly timeoutSeconds: number;
  /** これから送る1回ごとの字数（いまの分け方で数えたもの） */
  readonly inputChars: readonly number[];
  /** 候補ごとの速さ（台帳の実測） */
  readonly speedsOf: (modelId: string) => CandidateSpeeds;
  readonly records?: readonly FeatureAccuracyRecord[];
}): LargerModelAdvice | undefined {
  if (!isLocalProviderId(params.providerId)) return undefined;
  if (params.inputChars.length === 0) return undefined;
  if (!(params.timeoutSeconds > 0)) return undefined;

  const currentBillions = parameterSizeInBillions(params.current.parameterSize);
  if (currentBillions === undefined || !params.current.parameterSize) {
    return undefined;
  }
  const records = params.records ?? BUNDLED_FEATURE_ACCURACY;
  const recordOf = (model: string): FeatureAccuracyRecord | undefined =>
    accuracyRecordFor(
      {
        feature: params.feature,
        providerId: params.providerId,
        model,
        promptVersion: params.promptVersion,
      },
      records
    );
  const currentRecord = recordOf(params.current.id);

  const candidates = params.installed
    .filter((model) => model.id !== params.current.id)
    .filter((model) => !isCloudRelay(model.id))
    .map((model) => ({
      model,
      billions: parameterSizeInBillions(model.parameterSize),
    }))
    .filter(
      (entry): entry is { model: InstalledModel; billions: number } =>
        entry.billions !== undefined && entry.billions > currentBillions
    )
    .filter((entry) => !recordSaysWorse(recordOf(entry.model.id), currentRecord))
    // **大きい順。** 同じ大きさなら名前の順にして、毎回同じものを勧める
    .sort(
      (left, right) =>
        right.billions - left.billions ||
        left.model.id.localeCompare(right.model.id)
    );
  if (candidates.length === 0) return undefined;

  let unmeasured: UnmeasuredModel | undefined;
  let fits: FittingModel | undefined;
  for (const { model } of candidates) {
    const record = recordOf(model.id);
    const parameterSize = model.parameterSize ?? "";
    const speeds = params.speedsOf(model.id);
    const estimate = estimateFor(params.inputChars, speeds);
    if (!estimate) {
      // **いちばん大きい未測定だけ**を覚える（測る案内は1つで足りる）
      unmeasured ??= { id: model.id, parameterSize, ...(record ? { record } : {}) };
      continue;
    }
    if (estimate.longestCallMs > params.timeoutSeconds * 1000) continue;
    fits = {
      id: model.id,
      parameterSize,
      totalMs: estimate.totalMs,
      longestCallMs: estimate.longestCallMs,
      basis: speeds.basis,
      ...(record ? { record } : {}),
    };
    break;
  }
  if (!fits && !unmeasured) return undefined;

  return {
    current: {
      id: params.current.id,
      parameterSize: params.current.parameterSize,
      ...(currentRecord ? { record: currentRecord } : {}),
    },
    ...(fits ? { fits } : {}),
    ...(unmeasured ? { unmeasured } : {}),
  };
}

/** 確認画面へ添えるボタン。**出せないものは undefined** */
export interface LargerModelButtons {
  /** 押すと、この機能の割当を `fits` へ変えて、もう一度確認を出す */
  readonly switchLabel?: string;
  /** 押すと、`unmeasured` の速さを測る（AIチューニング） */
  readonly measureLabel?: string;
}

export function largerModelButtons(advice: LargerModelAdvice): LargerModelButtons {
  return {
    ...(advice.fits ? { switchLabel: `${advice.fits.id} に切り替える` } : {}),
    ...(advice.unmeasured
      ? { measureLabel: `${advice.unmeasured.id} の速さを測る` }
      : {}),
  };
}

/**
 * 確認画面の詳細へ足す文。
 *
 * **時間は台帳の実測からしか言わない。** 出どころ（平均・最大・同梱の最大）は
 * 確認の目安と同じ名乗り（`describeRunTimeEstimate`）で添える。
 */
export function describeLargerModelAdvice(
  advice: LargerModelAdvice,
  params: {
    /** 送る件数と単位（確認の目安と同じもの） */
    readonly count: number;
    readonly unit: string;
    /** 機能の表示名（「矛盾検知」など） */
    readonly featureLabel: string;
  }
): string {
  const current = `いまの ${advice.current.id} は ${advice.current.parameterSize}`;
  /** 当たりの記録の言い方は1か所（`describeAccuracyComparison`）に任せる */
  const accuracyOf = (
    model: string,
    record: FeatureAccuracyRecord | undefined
  ): string =>
    describeAccuracyComparison({
      candidateModel: model,
      candidate: record,
      currentModel: advice.current.id,
      current: advice.current.record,
    });
  const lines: string[] = [];
  if (advice.fits) {
    const fits = advice.fits;
    const time = describeRunTimeEstimate({
      count: params.count,
      unit: params.unit,
      ms: fits.totalMs,
      basis: fits.basis,
    });
    lines.push(
      `より大きいモデルが入っています。この機械なら ${fits.id}` +
        `（${fits.parameterSize}。${current}）で ${time}。` +
        "1回ずつが待ち時間の上限内に収まる見込みです。"
    );
    const accuracy = accuracyOf(fits.id, fits.record);
    if (accuracy) lines.push(accuracy);
    lines.push(
      `切り替えると「${params.featureLabel}」の割当が ${fits.id} になり、` +
        "もう一度この確認を出します（割当は「機能ごとのAI割当」で戻せます）。"
    );
  }
  if (advice.unmeasured) {
    const unmeasured = advice.unmeasured;
    lines.push(
      `${unmeasured.id}（${unmeasured.parameterSize}` +
        (advice.fits ? "" : `。${current}`) +
        "）も入っていますが、この機械での速さをまだ測っていないので、" +
        "どれくらいかかるか分かりません。一度測ってみますか（AIチューニング）。"
    );
    const accuracy = accuracyOf(unmeasured.id, unmeasured.record);
    if (accuracy) lines.push(accuracy);
  }
  return lines.join("\n");
}

/**
 * 同梱の記録が「このモデルは当たらない」と言っているか。
 *
 * **記録の無いものは落とさない**（分からないのであって、当たらないのではない）。
 */
function recordSaysWorse(
  candidate: FeatureAccuracyRecord | undefined,
  current: FeatureAccuracyRecord | undefined
): boolean {
  if (!candidate) return false;
  if (candidate.hits === 0) return true;
  return current !== undefined && accuracyRate(candidate) <= accuracyRate(current);
}

/**
 * Ollama がクラウドへ中継するモデル（`gpt-oss:120b-cloud` など）。
 *
 * **名前で見るのは、ここが「勧めない」側の安全弁だから**である。見落とせば
 * 原稿が外へ出るが、見過ぎても案内が1つ減るだけで済む。
 */
function isCloudRelay(modelId: string): boolean {
  return /(?:^|[:-])cloud$/i.test(modelId.trim());
}

/**
 * 全件と、いちばん長い1回の見込み。**書き出しの速さが測れていなければ作らない**
 * （読み込みだけの見込みは下限でしかなく、「上限内に終わる」とは言えない）。
 *
 * 式は確認画面の目安と同じ `estimateCallsTime`（写しを作らない）。
 */
function estimateFor(
  inputChars: readonly number[],
  speeds: CandidateSpeeds
): { totalMs: number; longestCallMs: number } | undefined {
  const shared = {
    tokensPerChar: speeds.tokensPerChar,
    inputTokensPerSecond: speeds.inputTokensPerSecond,
    outputTokensPerSecond: speeds.outputTokensPerSecond,
    outputTokensPerCall: speeds.outputTokensPerCall,
  };
  const total = estimateCallsTime({ inputChars, ...shared });
  if (!total || total.source !== "measured") return undefined;
  const longestChars = Math.max(
    0,
    ...inputChars.map((chars) => (Number.isFinite(chars) ? chars : 0))
  );
  const longest = estimateCallsTime({ inputChars: [longestChars], ...shared });
  if (!longest) return undefined;
  return { totalMs: total.ms, longestCallMs: longest.ms };
}
