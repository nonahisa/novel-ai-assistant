/**
 * 数を2桁にそろえる（日付・時刻の月・日・時・分に使う）。
 *
 * 4か所に同じ1行が写されていたので1つにまとめた。どこにも依存しない葉の部品。
 */
export function pad2(value: number): string {
  return String(value).padStart(2, "0");
}
