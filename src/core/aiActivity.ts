/**
 * AIがいま仕事をしているかどうか。
 *
 * 独り言（`chatter.ts`）は**Ollamaが空いているときにだけ**話しかける。
 * 抽出の最中に割り込むと、遅い機械では抽出そのものを遅くする。
 *
 * **数えるのはこの拡張機能が出した依頼だけである。** 別のアプリが
 * 同じOllamaを使っていても、こちらからは分からない。それでよい。
 * 判りようのないものを判った顔で扱うより、**分かる範囲で控えめにする。**
 *
 * **キューとは役目が別である**（設計書6.76）。あちらは「送ってよい順番」を
 * 決めるもの、こちらは「いま話しかけてよいか」を見るだけの目印である。
 *
 * 数（真偽値ではない）で持つのは、**数え始めと数え終わりが入れ子になる
 * ことがある**ためである。実際の送信は全体キューで1件ずつに直列化されて
 * いるが、真偽値だと内側の1本が終わった時点で「もう空いた」と言ってしまう。
 */
let inFlight = 0;

export function beginAiWork(): void {
  inFlight += 1;
}

export function endAiWork(): void {
  // 0を下回らせない。合わない呼び方をされても、
  // 「ずっと空いている」ことにして黙るより害が小さい
  inFlight = Math.max(0, inFlight - 1);
}

export function isAiBusy(): boolean {
  return inFlight > 0;
}

/** 試験用。実際の経路では使わない */
export function resetAiActivity(): void {
  inFlight = 0;
}

/** 依頼を1本、数えながら実行する */
export async function withAiWork<T>(run: () => Promise<T>): Promise<T> {
  beginAiWork();
  try {
    return await run();
  } finally {
    endAiWork();
  }
}
