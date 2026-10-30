/**
 * 組の鍵。向きで変わらないよう、2つの id を並べて作る（A→B と B→A が同じ鍵になる）。
 *
 * 場所の間の移動（`travelCues.ts`・`travelTable.ts`）に同じ関数が写されていたので
 * 1つにまとめた。どこにも依存しない葉の部品。
 */
export function pairKey(a: string, b: string): string {
  return JSON.stringify(a < b ? [a, b] : [b, a]);
}
