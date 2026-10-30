/**
 * 中央値（数が偶数個なら、真ん中の2つの平均）。並びが空のときは呼ばない（呼び手が確かめる）。
 *
 * `gpuLoad.ts`・`locationSketch.ts` に同じ関数が写されていたので1つにまとめた。
 * どこにも依存しない葉の部品。
 */
export function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}
