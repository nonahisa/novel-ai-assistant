import {
  isCharacterTextField,
  type Character,
} from "../models/character";
import {
  mergeChangeLists,
  type RecordChange,
  type RecordConflict,
} from "../models/jsonValidation";

/**
 * 食い違いを「作中での変化」へ昇格させる（設計書6.18）。
 *
 * 食い違い（`conflicts`）は「AIの取り違えかもしれない」ものとして
 * 作者の判断を待っている。作者が「これは作中で変わったのだ」と決めたら、
 * その判断を `changes` へ移す。移したあとは、
 *   - 資料に「変化かもしれない」ではなく変化として載る
 *   - 次の抽出で同じ食い違いが立て直されない（`characterMerge` が参照する）
 *
 * **判断そのものはAIにさせない。** どちらが正しいのか、あるいは両方正しくて
 * 作中で変わったのかは、書いた本人にしか分からない。
 */

export interface ConflictPromotion {
  /** 昇格後の変化の一覧 */
  changes: RecordChange[];
  /** 昇格した食い違いを取り除いたあとの一覧 */
  conflicts: RecordConflict[];
  /**
   * 「今の値」として項目へ入れ直す値。
   * いちばん後ろの話に出てきた値を選ぶ。決められなければ undefined
   * （そのときは元の値をそのまま残す）。
   */
  currentValue?: string;
}

export interface PromoteOptions {
  /** 作者が「今の値」を選んだ場合。省略すると話数から決める */
  currentValue?: string;
  /** 作中のいつのことか。時期を作っていなければ省略でよい */
  timepointId?: string | null;
}

/**
 * 指定した項目の食い違いを変化へ移す。
 * 対象の食い違いが無ければ undefined を返す（呼び出し側で「何もしない」）。
 */
export function promoteConflictToChanges(
  source: { changes: RecordChange[]; conflicts: RecordConflict[] },
  field: string,
  options: PromoteOptions = {}
): ConflictPromotion | undefined {
  const conflict = source.conflicts.find((entry) => entry.field === field);
  if (!conflict) return undefined;

  const entries = observationsOf(conflict);
  if (entries.length === 0) return undefined;

  const promoted: RecordChange[] = entries.map((entry, index) => ({
    field,
    value: entry.value,
    chapters: [...entry.chapters],
    timepointId: options.timepointId ?? null,
    // 食い違いの補足は値ごとではなく1件に付いている。
    // 捨てると作者が書いた文章が消えるので、先頭へ移して残す
    note: index === 0 ? conflict.note : null,
    evidence: null,
    source: "extracted",
  }));

  return {
    changes: mergeChangeLists(source.changes, promoted),
    conflicts: source.conflicts.filter((entry) => entry.field !== field),
    currentValue: options.currentValue ?? latestValue(entries),
  };
}

/** 人物へ昇格の結果を反映する。「今の値」は対象の項目へ入れ直す */
export function applyPromotion(
  character: Character,
  field: string,
  promotion: ConflictPromotion
): Character {
  const updated: Character = {
    ...character,
    changes: promotion.changes,
    conflicts: promotion.conflicts,
  };
  // 変化として並べたうえで、レコード本体には最新の値を残す。
  // 残さないと、資料の「外見」が第1話の姿のままになる
  if (promotion.currentValue && isCharacterTextField(field)) {
    updated[field] = promotion.currentValue;
  }
  return updated;
}

/** その項目の変化を、古い順に並べて返す */
export function changesOfField(
  changes: RecordChange[],
  field: string
): RecordChange[] {
  return sortChanges(changes.filter((change) => change.field === field));
}

/** 変化のある項目を、記録された順に返す */
export function changedFields(changes: RecordChange[]): string[] {
  return [...new Set(changes.map((change) => change.field))];
}

/**
 * 古い順に並べる。
 * 話数の無いものは「気づく前からあった値」なので先に置く
 * （`describeConflictValues` の並べ方と揃える）。
 */
export function sortChanges(changes: RecordChange[]): RecordChange[] {
  return [...changes].sort(
    (left, right) => firstChapter(left.chapters) - firstChapter(right.chapters)
  );
}

/**
 * 食い違いの値を、値ごとの話数と組にして取り出す。
 *
 * 古いデータには `observations`（値ごとの話数）が無い。そのときは話数なしの
 * 値として扱う。**記録のある値だけを並べると、既にあった食い違いが消える**ので、
 * `values` 側にしか無い値も必ず拾う（`describeConflictValues` と同じ理由）。
 */
function observationsOf(
  conflict: RecordConflict
): Array<{ value: string; chapters: number[] }> {
  const observations = conflict.observations ?? [];
  const missing = conflict.values
    .filter((value) => !observations.some((item) => item.value === value))
    .map((value) => ({ value, chapters: [] as number[] }));
  return (
    [...observations, ...missing]
      .filter((item) => item.value.trim())
      // **保存する時点で古い順に並べる。** 表示側でも並べ替えているが、
      // このJSONは作者が開いて読むものなので、ファイルの中でも
      // 「黒髪 → 銀髪」の順に並んでいてほしい
      .sort((a, b) => firstChapter(a.chapters) - firstChapter(b.chapters))
  );
}

/**
 * いちばん後ろの話に出てきた値。
 * どれにも話数が無ければ決められない（元の値をそのまま残す）。
 */
function latestValue(
  entries: Array<{ value: string; chapters: number[] }>
): string | undefined {
  let best: { value: string; chapter: number } | undefined;
  for (const entry of entries) {
    if (entry.chapters.length === 0) continue;
    const last = Math.max(...entry.chapters);
    if (!best || last > best.chapter) best = { value: entry.value, chapter: last };
  }
  return best?.value;
}

function firstChapter(chapters: number[]): number {
  return chapters.length > 0 ? Math.min(...chapters) : -1;
}
