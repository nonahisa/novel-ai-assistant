/**
 * 3桁ごとに区切る。
 *
 * `toLocaleString()` は環境の地域設定で区切りが変わるので使わない
 * （試験の期待値が端末によって変わる）。
 *
 * `finishNewWork.ts`・`proofreadingSuite.ts` に同じ関数が写されていたので1つにまとめた。
 * どこにも依存しない葉の部品。
 */
export function withCommas(value: number): string {
  const digits = String(Math.trunc(Math.abs(value)));
  let out = "";
  for (let i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += ",";
    out += digits[i];
  }
  return value < 0 ? `-${out}` : out;
}
