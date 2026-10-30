/**
 * 正の有限数のときだけ返す。
 *
 * 0や負や `"131072"` のような文字列は、**読まずに捨てる。** 半端に
 * 読むと「上限0トークン」のような、送る前から失敗が決まった値になる。
 *
 * `modelTuning.ts` と `featureOutputTokens.ts` に同じ関数が写されていた
 * （`modelTuning.ts` は vscode を引き込むので、`featureOutputTokens.ts` は借りずに
 * 写していた）。どこにも依存しない葉の部品にして、両方から読む。
 */
export function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}
