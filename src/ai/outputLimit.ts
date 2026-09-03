import * as vscode from "vscode";
import { OUTPUT_RESERVE_TOKENS } from "./contextGuard";
import { modelTuning } from "../core/modelTuning";

/**
 * 1回の応答で受け取る出力トークンの上限。
 *
 * これを送らないと、モデルごとの既定値で動く。既定値は公開されていないことも多く、
 * **実行前に出す課金の目安が実態と合わなくなる。**
 * 金額に関わる表示なので、送る値と示す値を必ず一致させる。
 *
 * 小さすぎると応答が途中で切れ、そのチャンクの結果は丸ごと捨てられる
 * （部分的なJSONは解析できないため）。呼び出し1回分が無駄になるので、
 * 節約しすぎないほうがよい。
 */

/** 既定値。抽出のJSONが収まり、かつ極端に大きくない値 */
export const DEFAULT_MAX_OUTPUT_TOKENS = 16384;

/** これ以上小さいと抽出のJSONが収まらない */
const MINIMUM = 1024;

export function resolveMaxOutputTokens(): number {
  const config = vscode.workspace.getConfiguration("novelai");

  // 以前はClaude専用の設定だった。作者が明示的に変えていた場合は尊重する
  const legacy = config.get<number>("claude.maxOutputTokens", 0);
  const configured =
    legacy > 0
      ? legacy
      : config.get<number>("maxOutputTokens", DEFAULT_MAX_OUTPUT_TOKENS);

  return Math.max(MINIMUM, configured);
}

/** 設定値をモデルの上限に丸める */
export function clampToModelLimit(
  configured: number,
  modelLimit: number | undefined
): number {
  if (modelLimit === undefined || modelLimit <= 0) return configured;
  return Math.max(MINIMUM, Math.min(configured, modelLimit));
}

/**
 * チャンク予算（`planChunkBudget` の `outputTokens`）と num_ctx の確保
 * （`generate` へ渡す `maxOutputTokens`）に見込む出力トークン数
 * （設計書6.65.16の2）。
 *
 * 台帳（`core/modelTuning.ts`）に実測（`measuredOutputTokens`）があれば
 * `min(設定, 実測)`、無ければ `min(設定, OUTPUT_RESERVE_TOKENS)`。
 * gemma4:12bですら実測6,500トークンなのに、既定の16,384を常に見込むのは
 * 非力なマシンでは要らないぶんまで num_ctx として確保することになる。
 *
 * **決定はここ1か所に括る。** 呼び出し側ごとに `resolveMaxOutputTokens()`
 * をそのまま使うと、実測が付いても見込みが古いままになる
 * （`readChunkSettings` を1か所にしたのと同じ理由）。
 *
 * **注意：測定そのもの（`features/measureContext.ts` の
 * `measureOutputLimit`）はこの丸めを通さない。** あちらは「設定値まで
 * 実際に書けるか」を測るのが目的なので、丸めると測る意味が無くなる
 * ——`resolveMaxOutputTokens()` を直接呼ぶ。
 */
export function resolveOutputTokensForPlanning(
  providerId: string,
  model: string
): number {
  const configured = resolveMaxOutputTokens();
  const measured = modelTuning(providerId, model)?.measuredOutputTokens;
  const ceiling = measured !== undefined ? measured : OUTPUT_RESERVE_TOKENS;
  return Math.min(configured, ceiling);
}
