/**
 * バイトの並びを2つつなぐ（記録のファイルへ1行を書き足すとき）。
 *
 * 記録の部品（`chatLog.ts`・`logger.ts`・`usageLog.ts`）に同じ関数が `concat` の名前で
 * 写されていたので1つにまとめた。どこにも依存しない葉の部品。
 */
export function concatBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  const merged = new Uint8Array(left.byteLength + right.byteLength);
  merged.set(left, 0);
  merged.set(right, left.byteLength);
  return merged;
}
