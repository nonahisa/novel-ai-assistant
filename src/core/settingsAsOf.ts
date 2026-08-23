import type { RecordChange } from "../models/jsonValidation";

/**
 * 設定資料を「第N話の時点で分かっていること」に絞る（設計書6.10.3）。
 *
 * 作者の指摘（2026-08-23）：「矛盾検知の時系列把握が甘いです。4話で判明する
 * 内容を3話で矛盾として検知していました」。
 *
 * ## なぜ起きたか
 *
 * **設定資料は作品全体から作られている。** 第4話で「退学扱いになった」と
 * 明かされれば、資料の役割欄には「定時制高校生（退学扱い）」と入る。
 * その資料をそのまま第3話と突き合わせれば、**まだ明かされていない事実**と
 * 食い違って見えるのは当たり前である。
 *
 * これは本文の誤りではなく、**読者がまだ知らないことを先に知っている**
 * こちらの落ち度である。
 *
 * ## いつ分かったかは、記録されている
 *
 * `characterMerge.ts` は**空欄を埋めるときにも話数を残す**（`recordValue`）。
 * つまり `changes` は「どの値が何話で出てきたか」の記録になっている。
 * それを使って、第N話の時点の値へ巻き戻せる。
 *
 * **記録の無い項目は落とさない。** この仕組みが入る前に作られた資料や、
 * 作者が手で書いた項目には話数が無い。**分からないものを消すと、
 * 作者の書いたものが黙って消える。**
 *
 * VS Code APIに依存しない。
 */

/**
 * その項目が、第N話の時点でどう書かれていたか。
 *
 * @param current いまの値（いちばん後ろの話の値）
 * @param chapter どの話の時点で見るか。`null` なら絞らない
 * @returns その時点の値。まだ分かっていなければ `null`
 */
export function valueAsOf(
  changes: readonly RecordChange[],
  field: string,
  current: string | null,
  chapter: number | null
): string | null {
  if (chapter === null) return current;

  const history = changes.filter((change) => change.field === field);
  // **記録が無ければ、そのまま通す。** 話数の分からない項目を消すと、
  // 作者が手で書いたものまで消える
  if (history.length === 0) return current;

  let best: { value: string; at: number } | undefined;
  for (const change of history) {
    const known = change.chapters.filter((at) => Number.isFinite(at));
    // 話数の分からない記録は「それ以前」とみなす（0扱い）
    const at = known.length > 0 ? Math.min(...known) : 0;
    if (at > chapter) continue;
    if (!best || at >= best.at) best = { value: change.value, at };
  }

  // どの記録も先の話のものだった＝この時点ではまだ分かっていない
  return best ? best.value : null;
}

/**
 * その記録は、第N話の時点で登場しているか。
 *
 * **まだ出ていない人物や場所は、そもそも突き合わせる相手ではない。**
 * 登場話数が空のものは判断できないので、通す（落とさない側へ倒す）。
 */
export function hasAppearedBy(
  appearedChapters: readonly number[],
  chapter: number | null
): boolean {
  if (chapter === null) return true;
  const known = appearedChapters.filter((at) => Number.isFinite(at));
  if (known.length === 0) return true;
  return Math.min(...known) <= chapter;
}

/** 巻き戻しの対象にする項目 */
export type AsOfField = string;

/**
 * レコードの文字列項目を、第N話の時点へ巻き戻す。
 *
 * **項目を消すことがある。** その時点でまだ分かっていない項目は、
 * 突き合わせの材料にしてはいけない。
 */
export function recordAsOf<T extends object>(
  record: T,
  fields: readonly AsOfField[],
  chapter: number | null
): T {
  if (chapter === null) return record;

  const source = record as { changes?: RecordChange[] };
  // **変化の記録を持たない種類がある**（場所など）。そこは巻き戻せないので
  // そのまま通す。登場話数での絞り込み（`hasAppearedBy`）は効く
  const changes = source.changes;
  if (!changes) return record;

  const rolled = { ...record } as Record<string, unknown>;
  for (const field of fields) {
    const current = rolled[field];
    if (typeof current !== "string" && current !== null) continue;
    rolled[field] = valueAsOf(
      changes,
      field,
      (current as string | null) ?? null,
      chapter
    );
  }
  return rolled as T;
}

/**
 * 巻き戻した結果、何も残らなかったか。
 *
 * **名前しか分かっていない記録を送っても、突き合わせる材料にならない。**
 * 送るだけ指示が長くなり、AIが「材料がある」と誤解する。
 */
export function isEmptyAfterRollback(
  record: object,
  fields: readonly AsOfField[]
): boolean {
  const values = record as Record<string, unknown>;
  return fields.every((field) => {
    const value = values[field];
    return typeof value !== "string" || value.trim().length === 0;
  });
}
