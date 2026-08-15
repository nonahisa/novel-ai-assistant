import {
  isCharacterTextField,
  type Character,
} from "../models/character";
import {
  findChange,
  hasChange,
  mergeChangeLists,
  recordChangeChapters,
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

/**
 * 抽出した値と、それが出てきた話数を履歴へ残す。
 *
 * **空欄を埋めるときにも呼ぶ。** ここで話数を残しておかないと、次に違う値が
 * 来たときに「作中で変わった」のか「同じ話の中で矛盾した」のかを見分けられない。
 * 見分けられないと、AIの取り違えまで変化として畳んでしまう。
 *
 * 1件しか無い項目は「変わっていない」ので、表示には出さない
 * （`changedFields` が2件以上の項目だけを返す）。
 */
export function recordValue(
  changes: RecordChange[],
  field: string,
  value: string,
  chapters: number[],
  evidence: string | null = null
): boolean {
  if (hasChange(changes, field, value)) {
    return recordChangeChapters(changes, field, value, chapters);
  }
  changes.push({
    field,
    value,
    chapters: sortedChapters(chapters),
    timepointId: null,
    note: null,
    evidence,
    source: "extracted",
  });
  return true;
}

/**
 * 同じ事実をより詳しく書き直したものへ差し替える
 * （「黒髪」→「短く切った黒髪」）。
 *
 * これは変化ではないので履歴を増やさない。増やすと
 * 「黒髪（第1話）→ 短く切った黒髪（第1話）」と、起きていない変化が資料に載る。
 */
export function refineValue(
  changes: RecordChange[],
  field: string,
  from: string,
  to: string,
  chapters: number[]
): void {
  const existing = findChange(changes, field, from);
  if (!existing) {
    recordValue(changes, field, to, chapters);
    return;
  }
  existing.value = to;
  existing.chapters = sortedChapters([...existing.chapters, ...chapters]);
}

/** その値がどの話のものか。履歴に無ければ undefined（判定できない） */
export function chaptersOfValue(
  changes: RecordChange[],
  field: string,
  value: string
): number[] | undefined {
  return findChange(changes, field, value)?.chapters;
}

/** 同じ話に両方が出ているか。出ていれば作中の変化では説明できない */
export function overlaps(left: number[], right: number[]): boolean {
  const seen = new Set(left);
  return right.some((chapter) => seen.has(chapter));
}

/**
 * 履歴のうち、いちばん後ろの話に出てきた値を「今の値」として返す。
 * どれにも話数が無ければ undefined（元の値をそのまま残す）。
 */
export function latestValueOfField(
  changes: RecordChange[],
  field: string
): string | undefined {
  return latestValue(
    changes
      .filter((change) => change.field === field)
      .map((change) => ({ value: change.value, chapters: change.chapters }))
  );
}

function sortedChapters(chapters: number[]): number[] {
  return [...new Set(chapters.filter((chapter) => Number.isSafeInteger(chapter)))].sort(
    (a, b) => a - b
  );
}

/**
 * 作中で変わらない項目。
 *
 * 読み仮名は人物の同定情報であって、その時点の描写ではない。
 * 話によって違う読みが出たら、それは作中の変化ではなく**AIの読み違い**である。
 * 畳むと「第13話までは『ふとし』だった」という、起きていない年表が資料に載る
 * （実データで太志と密倉文佳の両方で起きた）。
 *
 * 性別はここに入れない。この作者の作品には転生・転性があり
 * （`world_012_転生と転性`）、実際に変わりうるためである。
 */
const UNCHANGING_FIELDS = new Set(["reading"]);

/**
 * その食い違いを、作者に聞かずに変化として畳んでよいか。
 *
 * **判断の分かれ目は「同じ話の中で矛盾しているか」である。**
 *   - 第1話で「黒髪」、第7話で「銀髪」→ 作中で変わったと読むのが自然。畳む
 *   - 同じ第7話で「黒髪」と「銀髪」→ 両方が同時に正しいことはない。
 *     AIの取り違えの可能性が高いので、作者の判断へ回す
 *
 * 話数の無い値（食い違いに気づく前から入っていた値）は「それ以前」として
 * 最古に置けるので1つまで許す。2つ以上あると前後を決められないため畳まない。
 *
 * この判定を入れるまで、話ごとに違う言い方をされた要約が
 * すべて食い違いとして積み上がっていた（実データで太志のsummaryが9段）。
 */
export function isFoldableConflict(conflict: RecordConflict): boolean {
  if (UNCHANGING_FIELDS.has(conflict.field)) return false;

  const entries = observationsOf(conflict);
  if (entries.length < 2) return false;

  // **話数の分かる値が2つ以上あること。**
  // 「変わった」と言うには、違う時点での値を2つ見る必要がある。
  // 片方の話数が分からないと前後を決められず、作者が手で書いた値を
  // AIの読みで押し流しかねない（品質ゲートの「印章師」で実際に起きた）。
  const dated = entries.filter((entry) => entry.chapters.length > 0);
  if (dated.length < 2) return false;

  // 話数の分からない値は「それ以前」として最古に置けるので1つまで。
  // 2つ以上あると、その間の前後を決められない
  const undated = entries.length - dated.length;
  if (undated > 1) return false;

  const seen = new Set<number>();
  for (const entry of dated) {
    for (const chapter of entry.chapters) {
      // 同じ話に2つの値が出ている。作中の変化では説明できない
      if (seen.has(chapter)) return false;
      seen.add(chapter);
    }
  }
  return true;
}

export interface FoldResult {
  character: Character;
  /** 畳んだ項目名。作者へ「黙って書き換えていない」と伝えるために返す */
  folded: string[];
}

/**
 * 畳める食い違いを、まとめて変化へ移す。
 *
 * **既存の値は消えない。** 変化の記録として残り、レコード本体には
 * いちばん後ろの話の値が入る。設計書5.4の「上書きせず作者に委ねる」を
 * 緩めているように見えるが、失われるものは無く、
 * 資料には「A（第1話）→ B（第7話）」と両方が並ぶ（設計書6.18）。
 *
 * **作者が確定させたレコード（`autoGenerated: false`）には使わない。**
 * 呼び出し側で除くこと。
 */
export function foldCharacterConflicts(character: Character): FoldResult {
  let result = character;
  const folded: string[] = [];

  // 走査中に conflicts が変わるので、対象は先に決めておく
  const targets = character.conflicts
    .filter((conflict) => isFoldableConflict(conflict))
    .map((conflict) => conflict.field);

  for (const field of targets) {
    const promotion = promoteConflictToChanges(result, field);
    if (!promotion) continue;
    result = applyPromotion(result, field, promotion);
    folded.push(field);
  }

  return { character: result, folded };
}

/** その項目の変化を、古い順に並べて返す */
export function changesOfField(
  changes: RecordChange[],
  field: string
): RecordChange[] {
  return sortChanges(changes.filter((change) => change.field === field));
}

/**
 * 実際に変わった項目を返す。
 *
 * **値が1件しか記録されていない項目は含めない。** 空欄を埋めたときにも
 * 履歴を残しているので（`recordValue`）、全項目をそのまま返すと
 * 変わっていない項目まで「変化」として資料に載ってしまう。
 */
export function changedFields(changes: RecordChange[]): string[] {
  const counts = new Map<string, number>();
  for (const change of changes) {
    counts.set(change.field, (counts.get(change.field) ?? 0) + 1);
  }
  return [...new Set(changes.map((change) => change.field))].filter(
    (field) => (counts.get(field) ?? 0) >= 2
  );
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
