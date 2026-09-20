import {
  describeRunTimeEstimate,
  estimateRunMs,
  type RunTimeEstimateBasis,
} from "../core/etaEstimate";
import { modelTuning } from "../core/modelTuning";
import {
  MIN_FEATURE_OUTPUT_SAMPLES,
  featureOutputTuning,
} from "../core/featureOutputTokens";

/**
 * 押す前の所要時間の見当（設計書6.8.19）。
 *
 * **`views/` から出してある**（0.72.0）。中身は台帳（プロバイダID＋モデル名）を
 * 引くだけで、画面の部品ではない——`ai/capability.ts` が「モデルの地力で
 * 何が変わるか」を1か所に集めているのと同じ並びである。
 *
 * **ここに `vscode` を持ち込まない**（実装ルール7）。持ち込むと、外から呼ぶ束
 * （MCP）へ出す道が塞がる。**ただし今はまだ届いていない**——`core/modelTuning.ts`
 * と `core/featureOutputTokens.ts` が `vscode` を静的 import しているためで、
 * そちらを割るまでは MCP の束からは引けない（`test/unit/mcpReach.test.ts`）。
 */

/**
 * 押す前に「およそどれだけかかるか」を言う（設計書6.8.19）。
 *
 * **見当が付かないときは、正直にそう言う。** ここで既定値を置くと、
 * 一度も測っていないモデルにも数字が出て、当てずっぽうが実測の顔をして
 * 並ぶ。台帳（`core/modelTuning.ts` の `outputTokensPerSecond`）は作者
 * 自身の呼び出しからしか入らないので、無いということは本当に「この機械で
 * このモデルを動かしたことがない」である。
 *
 * **`speedMeasuredAt` はここでは見ない。** 古い測定でも、いまある唯一の
 * 実測である——粒度は「およそ5時間」なので、多少古くても判断は変わらない。
 * 黙って捨てると、代わりに出せるものが何も無くなる。
 */
export function estimateRunTimeText(params: {
  /** AIのプロバイダID（速さの台帳の鍵） */
  readonly providerId: string;
  /** モデル名（同上） */
  readonly model: string;
  /** 出力量の実測を引く機能名（`meta.feature` と同じもの） */
  readonly feature: string;
  /** これからAIへ送る件数 */
  readonly count: number;
  /** 数えているもの。話ごとに送る検知は「話」 */
  readonly unit?: string;
}): string {
  const unit = params.unit ?? "チャンク";
  const speed = modelTuning(params.providerId, params.model)
    ?.outputTokensPerSecond;
  // **出力量の実測もモデルごと**（0.71.6）。速さの台帳と同じ鍵で引く
  // ——同じ機能でも、思考を吐くモデルは書く量が違う
  const output = featureOutputTuning(
    params.feature,
    params.providerId,
    params.model
  );
  // **件数が足りない実測は使わない**（`core/featureOutputTokens.ts` の
  // しきい値と同じ線を引く）。1回ぶんでは、たまたま短かった回と区別が付かない
  const enough =
    (output?.outputTokenSamples ?? 0) >= MIN_FEATURE_OUTPUT_SAMPLES;
  /*
    **時間の見積もりは、平均を見る**（0.71.5。2026-09-21 に実機で外した）。

    台帳が覚えている最大（`outputTokens`）は容量のための値で、**所要時間に
    使えば必ず過大になる**——プロット逸脱10話で「およそ15分」と出て、実際は
    39秒だった。平均が無い（同梱の表、または0.71.4以前の行）ときだけ最大へ
    落ち、そのときは「多めに見ています」と名乗る。
  */
  const average = enough ? output?.outputTokensAverage : undefined;
  const max = enough ? output?.outputTokens : undefined;
  const perCall = average ?? max;

  const ms = estimateRunMs(params.count, speed, perCall);
  // **出どころを渡す。** 最大から出した数字に、普段の量と同じ顔をさせない
  const basis: RunTimeEstimateBasis =
    average !== undefined
      ? "average"
      : output?.bundled === true
        ? "bundled-max"
        : "max";
  return describeRunTimeEstimate({ count: params.count, unit, ms, basis });
}
