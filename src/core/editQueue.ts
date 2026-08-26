/**
 * 打たれた本文を、1つずつ順に当てる（設計書6.25.2）。
 *
 * 作者の指摘（2026-08-24）：「改行した際に勝手に空行が入ります」。
 *
 * ## 待っている間に、次が届く
 *
 * 原稿エディタは、画面で打たれた本文を丸ごと送ってくる。受け取った側は
 * **いまの文書と見比べて、変わった1か所だけ**を当てる（`textEdit.ts`）。
 * この「見比べて当てる」は待ち時間のある処理で、**待っている間に次の便が
 * 届く**。
 *
 * 1. 1通目：文書「あ」／画面「あ＋改行」 → 「位置1へ改行」を当てはじめる
 * 2. 2通目：**まだ文書は「あ」のまま**なので、また「位置1へ改行」を作る
 * 3. 両方が当たり、**改行が2つ入る**
 *
 * 打つのが速いほど当たりやすい。**日本語入力では、変換の確定と次の打鍵が
 * 重なるので、ふつうに起きる。**
 *
 * ## 溜めずに、最後の1つだけを当てる
 *
 * 当てている間に届いたものは、**上書きして1つに畳む**。画面が持っている
 * のは「いまの本文ぜんぶ」なので、途中の状態を順に当てても行き着く先は
 * 同じである。**畳んだほうが、当てる回数も減る。**
 */

export type ApplyText = (text: string) => Promise<void>;

/**
 * 順番待ちの窓口を作る。
 *
 * 返した関数は、**当て終わるまで次を当てない**。当てている間に呼ばれた
 * ぶんは最後の1つだけが残る。
 */
export function createEditQueue(apply: ApplyText): ApplyText {
  let queued: string | undefined;
  let applying = false;

  return async (text: string): Promise<void> => {
    queued = text;
    if (applying) return;

    applying = true;
    try {
      while (queued !== undefined) {
        const next = queued;
        queued = undefined;
        await apply(next);
      }
    } finally {
      // **必ず下ろす。** 当てるのに失敗したまま立てておくと、
      // それ以降いっさい打てなくなる
      applying = false;
    }
  };
}
