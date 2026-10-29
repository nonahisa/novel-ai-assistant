/**
 * 文字列ならそのまま、それ以外は空文字にする（読んだ JSON の欄を文字列として扱うとき）。
 *
 * core の3か所に同じ1行が `str` の名前で写されていたので1つにまとめた。
 * `models/finding.ts` にも同じものがあるが、models は core を読まない決まりなので残す。
 * どこにも依存しない葉の部品。
 */
export function stringOrEmpty(value: unknown): string {
  return typeof value === "string" ? value : "";
}
