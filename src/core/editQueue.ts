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

export type ApplyText<T = string> = (item: T) => Promise<void>;

/**
 * 画面から届いた1便（設計書6.25.9）。
 *
 * `seq` は画面が付けた便の番号。**入ったかどうかを、この番号で画面へ返す。**
 * 番号の無い便（番号を付ける前の画面）には返さない。
 */
export interface SentEdit {
  text: string;
  seq?: number;
  /**
   * 元にした本文の指紋（`core/screenEditRebase.ts`。作者の裁定「塞ぐ」、2026-10-04）。
   * 本体の変更が画面へ届く前に打った便でも、その変更を戻さずに当て直すために使う
   */
  base?: string;
}

/** 画面へ返す「入ったか」の知らせ */
export interface EditAck {
  type: "editApplied";
  seq: number;
  ok: boolean;
  /**
   * 打った所が、画面のまだ知らない本体の変更と重なったので**当てなかった**
   * （設計書6.25.9）。`ok` は true（送り直しても同じなので、送り直させない）。
   * `text` は当てなかった画面の本文——画面はこれを控えて帯で知らせる
   */
  conflict?: true;
  text?: string;
}

/** 1便を当てた結果。`"conflict"` は当てずに画面へ控えさせる（`EditAck.conflict`） */
export type ApplyOutcome = boolean | "conflict";

/**
 * 1便を当てて、**入ったかどうかを画面へ返す**（設計書6.25.9）。
 *
 * 作者の報告（2026-09-28）：「×ボタンで消したら400文字ぐらいが消えました」。
 * 打った字は画面にだけあり、文書は空のままだった。**当てられなかったときに
 * 画面が何も知らない**と、字は画面にだけ残り、作者は保存できていると
 * 思ったまま閉じる。
 *
 * - 当てる処理が投げても止めない（`onError` へ渡し、ok:false を返す）。
 *   投げたまま順番待ちへ返すと、その間に畳まれた次の便が当たらずに残る
 * - 返すのは、当て終わったあと。当てる前に返すと「入った」と偽ることになる
 *
 * - 当てずに控えさせる（`"conflict"`）ときは、ok:true と打った本文を添えて返す
 *   （ok:false にすると画面は4秒ごとに送り直し、同じ理由で当たらないまま回り続ける）
 *
 * @returns 入ったか（変わる所が無かったときも true）。当てずに控えさせたときは `"conflict"`
 */
export async function applySentEdit(
  item: SentEdit,
  apply: (text: string) => Promise<ApplyOutcome>,
  report: (ack: EditAck) => void,
  onError: (error: unknown) => void
): Promise<ApplyOutcome> {
  let outcome: ApplyOutcome = false;
  try {
    outcome = await apply(item.text);
  } catch (error) {
    outcome = false;
    onError(error);
  }
  if (typeof item.seq === "number") {
    report(
      outcome === "conflict"
        ? { type: "editApplied", seq: item.seq, ok: true, conflict: true, text: item.text }
        : { type: "editApplied", seq: item.seq, ok: outcome }
    );
  }
  return outcome;
}

/**
 * 当てている間に届いた2便を1つに畳む（設計書6.25.9）。
 *
 * 後の便の元が前の便の本文なら、**前の便の元を引き継いで**1つにする——
 * 後の便の元だけを持たせると、前の便で打った字が「もう入った」ことになり、
 * 当て直しの道で落ちる。つながっていなければ畳まない（`undefined`。順に当てる）。
 * 指紋の無い便どうしは今までどおり後の便だけを残す。
 */
export function combineSentEdits(
  older: SentEdit,
  newer: SentEdit,
  fingerprint: (text: string) => string
): SentEdit | undefined {
  if (older.base === undefined && newer.base === undefined) return newer;
  if (older.base === undefined || newer.base === undefined) return undefined;
  if (newer.base !== fingerprint(older.text)) return undefined;
  return { ...newer, base: older.base };
}

/**
 * 順番待ちの窓口を作る。
 *
 * 返した関数は、**当て終わるまで次を当てない**。当てている間に呼ばれた
 * ぶんは畳む——`combine` が無ければ最後の1つだけが残る。`combine` が
 * `undefined` を返したら畳まずに後ろへ並べる（届いた順に当てる）。
 */
export function createEditQueue<T = string>(
  apply: ApplyText<T>,
  combine?: (older: T, newer: T) => T | undefined
): ApplyText<T> {
  const queued: T[] = [];
  let applying = false;

  return async (text: T): Promise<void> => {
    const last = queued.length > 0 ? queued[queued.length - 1] : undefined;
    const combined =
      last === undefined ? undefined : combine ? combine(last, text) : text;
    if (combined !== undefined) queued[queued.length - 1] = combined;
    else queued.push(text);
    if (applying) return;

    applying = true;
    try {
      while (queued.length > 0) {
        const next = queued.shift() as T;
        await apply(next);
      }
    } finally {
      // **必ず下ろす。** 当てるのに失敗したまま立てておくと、
      // それ以降いっさい打てなくなる
      applying = false;
    }
  };
}
