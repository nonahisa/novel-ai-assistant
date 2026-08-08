import * as vscode from "vscode";

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
