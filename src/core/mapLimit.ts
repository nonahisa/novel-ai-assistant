/**
 * 配列の各要素に非同期の処理をかけ、**同時に走る数に上限を付ける**。
 * 結果は入力と同じ並びで返す（早く終わった順にはならない）。
 *
 * 置き場ごとの git の読みを並べるのに使う（設計書5.5.18）。上限なしの
 * `Promise.all` だと、置き場が多い作者の機械で git が一度に何十本も起き、
 * ディスクを奪い合って、かえって遅くなる。
 *
 * どれかが失敗したら、その失敗で全体が失敗する（`Promise.all` と同じ）。
 * 1件の失敗を握りつぶして続けたいときは、呼び出し側の `fn` の中で捕まえる。
 */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  const width = Math.max(1, Math.min(Math.floor(limit) || 1, items.length));
  let next = 0;
  let failed = false;
  const worker = async (): Promise<void> => {
    while (!failed) {
      const index = next++;
      if (index >= items.length) return;
      try {
        results[index] = await fn(items[index], index);
      } catch (error) {
        // 失敗したら、まだ始めていない分は始めない
        failed = true;
        throw error;
      }
    }
  };
  await Promise.all(Array.from({ length: width }, worker));
  return results;
}
