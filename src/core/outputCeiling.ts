import { bundledFeatureOutput, bundledTuning } from "./bundledTuning";

/**
 * 機能ごとの出力の見込み（`core/featureOutputTokens.ts`）の**計算だけ**を
 * 切り出したもの（2026-10-08）。
 *
 * ## なぜ分けたか
 *
 * 見込みは製品（拡張機能）と MCP の `novel.run` の**両方**が使う。ところが
 * `featureOutputTokens.ts` は台帳（`modelTuningStore.ts`）を通じて `vscode` に
 * 届くので、MCP の束からは借りられない（`test/unit/cross/mcpReach.test.ts`）。
 * かといって MCP 側に `1.25` や `1024` を書き写すと、**片方だけ直す日が来る。**
 *
 * そこで、`vscode` に触らない計算（余裕・刻み・件数のしきい値と、思考のぶん）
 * だけをここへ置き、**製品は台帳を混ぜた記録を、MCP は同梱の記録を、同じ関数へ
 * 通す。** 違うのは材料の出どころだけになる。
 */

/**
 * 実測に上乗せする余裕。理由は `featureOutputTokens.ts` の同名の再輸出に
 * 書いてある（作者の実測のばらつきから決めた25%）。
 */
export const FEATURE_OUTPUT_MARGIN = 1.25;

/** 見込みを丸める刻み（`MINIMUM_OUTPUT_TOKENS` と同じ 1,024 で切り上げる） */
export const FEATURE_OUTPUT_STEP = 1024;

/** これだけ実測が貯まるまで、見込みに使わない（1回では偶然と区別が付かない） */
export const MIN_FEATURE_OUTPUT_SAMPLES = 3;

/** 見込みの計算に要る欄だけ（台帳の行も同梱の行も、この形で渡せる） */
export interface FeatureOutputRecord {
  readonly outputTokens?: number;
  readonly outputTokenSamples?: number;
  readonly outputTruncated?: true;
}

/**
 * 記録から、その機能に見込む出力トークン数を出す。**分からなければ undefined。**
 *
 * - 一度でも上限で切られた機能は、要る量を知らない（undefined）
 * - 件数がしきい値に届かない記録は信じない（undefined）
 * - 届いていれば、最大値に余裕を乗せて刻みで切り上げる
 */
export function ceilingOfFeatureOutput(
  record: FeatureOutputRecord | undefined
): number | undefined {
  if (!record) return undefined;
  if (record.outputTruncated === true) return undefined;
  const max = record.outputTokens;
  if (max === undefined) return undefined;
  if ((record.outputTokenSamples ?? 0) < MIN_FEATURE_OUTPUT_SAMPLES) {
    return undefined;
  }
  return (
    Math.ceil((max * FEATURE_OUTPUT_MARGIN) / FEATURE_OUTPUT_STEP) *
    FEATURE_OUTPUT_STEP
  );
}

/** 思考のぶんの計算に要る欄だけ（台帳の行も同梱の行も、この形で渡せる） */
export interface ThinkingOverheadRecord {
  readonly thinkingOffWorks?: boolean;
  readonly thinkingOverheadTokens?: number;
}

/**
 * 思考を止める指定が効かないモデルの、1回あたりの思考のぶん（設計書6.49.9）。
 * 効くモデル・分からないモデルは0。中身は `core/modelTuning.ts` の
 * `unsuppressedThinkingTokens` がそのまま借りる。
 */
export function thinkingOverheadOf(
  record: ThinkingOverheadRecord | undefined
): number {
  if (record?.thinkingOffWorks !== false) return 0;
  return record.thinkingOverheadTokens ?? 0;
}

/**
 * **同梱の記録だけ**から見込む、その機能の出力の上限（MCP の `novel.run` が使う）。
 *
 * MCP の束は作者の台帳を読めない（上の「なぜ分けたか」）。だから同梱の値で
 * 決める。製品が台帳の空いている機能で使う値（`featureOutputTuning` が同梱へ
 * 落ちる道）と同じになる。
 *
 * **同梱の見込みには、止められない思考のぶんを足す**——製品の
 * `ai/outputLimit.ts` の `withThinkingOverhead` と同じ扱い（同梱の表は答えの
 * 量だけで、考えるぶんが入っていない）。
 */
export function bundledFeatureOutputCeiling(
  feature: string | undefined,
  providerId: string,
  model: string
): number | undefined {
  if (feature === undefined || feature.length === 0) return undefined;
  const seed = bundledFeatureOutput(feature);
  const ceiling = ceilingOfFeatureOutput(
    seed && { outputTokens: seed.outputTokens, outputTokenSamples: seed.samples }
  );
  if (ceiling === undefined) return undefined;
  return ceiling + thinkingOverheadOf(bundledTuning(providerId, model));
}
