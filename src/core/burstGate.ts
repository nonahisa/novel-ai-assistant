/**
 * 続けざまに起きることを、**ひと続きの最初の1回だけ**通す関所（0.81.4）。
 *
 * 原稿エディタと普通のエディタで同じ原稿を開き、普通のエディタで打つと、
 * 「外で変わったので画面へ送り直します」が**1文字ごとに**操作ログへ入っていた。
 * この記録は「画面が古いまま」の切り分けのためのもので（実機確認 A-20）、
 * 要るのは「外で変わり始めた」ことと、その回数の見当である。
 *
 * **時間で間引くのではなく、切れ目で区切る。** 最後の出来事から `quietMs`
 * 何も起きなければ、ひと続きが終わったと見る。打ち続けている間は1回だけ、
 * 手を止めてまた打ち始めたら、また1回書く。「一定時間に1回」にすると、
 * 打ち続けるだけで同じ行が定期的に積み上がる。
 *
 * 時計は渡してもらう（テストで時刻を決められるように）。vscode には触れない。
 */
export interface BurstGate {
  /**
   * 出来事が1つ起きた。ひと続きの最初なら、直前のひと続きで通さなかった
   * 回数を添えて返す。途中なら undefined（書かない）。
   */
  hit(now: number): { skippedBefore: number } | undefined;
}

export function createBurstGate(quietMs: number): BurstGate {
  let lastAt: number | undefined;
  let skipped = 0;
  return {
    hit(now) {
      const inBurst = lastAt !== undefined && now - lastAt < quietMs;
      lastAt = now;
      if (inBurst) {
        skipped++;
        return undefined;
      }
      const skippedBefore = skipped;
      skipped = 0;
      return { skippedBefore };
    },
  };
}
