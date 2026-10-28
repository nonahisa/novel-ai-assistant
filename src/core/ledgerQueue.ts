/**
 * 順番待ちの鎖（台帳の書き込みを、同じ台帳では1本ずつ通す）。
 *
 * 提案・ロックの台帳は「読む → 足す → 書き戻す」で更新する。2つの書き込みが
 * 重なると、後から書いたほうが先の行を巻き戻して**行が消える**（採否の書き込みと
 * 編集部からの取り込みが同時に走ったとき）。台帳ごとに1本の鎖を持ち、書き込みを
 * その鎖に通す。
 *
 * VS Code にも Node にも依存しない。
 */

const chains = new Map<string, Promise<unknown>>();

/**
 * `key`（台帳の道）ごとに、`task` を1本ずつ順に走らせる。
 *
 * 前の仕事が失敗しても次を止めない（失敗は前の呼び手が受け取る）。
 */
export function runSerialized<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = chains.get(key) ?? Promise.resolve();
  const run = previous.then(task, task);
  const tail = run.then(
    () => undefined,
    () => undefined
  );
  chains.set(key, tail);
  // 鎖が伸び続けないよう、自分が最後尾ならあとで外す
  void tail.then(() => {
    if (chains.get(key) === tail) chains.delete(key);
  });
  return run;
}
