/**
 * 作者が手で編集するJSONを検証するための部品。
 *
 * 壊れたJSONを勝手に修復・上書きしないため、
 * 期待した形でなければ例外を投げて保存を止める。
 */

export function invalid(path: string): never {
  throw new Error(`${path} の形式が正しくありません。`);
}

export function objectValue(
  value: unknown,
  path: string
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalid(path);
  }
  return value as Record<string, unknown>;
}

export function requireNonEmptyString(value: unknown, path: string): void {
  if (typeof value !== "string" || value.trim().length === 0) invalid(path);
}

export function optionalString(value: unknown, path: string): void {
  if (value !== undefined && typeof value !== "string") invalid(path);
}

export function optionalNullableString(value: unknown, path: string): void {
  if (value !== undefined && value !== null && typeof value !== "string") {
    invalid(path);
  }
}

export function optionalBoolean(value: unknown, path: string): void {
  if (value !== undefined && typeof value !== "boolean") invalid(path);
}

export function optionalStringArray(value: unknown, path: string): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) invalid(path);
  for (const entry of value) {
    if (typeof entry !== "string") invalid(path);
  }
}

export function optionalNumberArray(value: unknown, path: string): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) invalid(path);
  for (const entry of value) {
    if (!Number.isSafeInteger(entry)) invalid(path);
  }
}

export function optionalEnum(
  value: unknown,
  path: string,
  allowed: readonly string[]
): void {
  if (value === undefined) return;
  if (typeof value !== "string" || !allowed.includes(value)) invalid(path);
}

export function optionalObjectArray<T>(
  value: unknown,
  path: string,
  map: (entry: Record<string, unknown>, path: string) => T
): T[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) invalid(path);
  return value.map((entry, index) =>
    map(objectValue(entry, `${path}[${index}]`), `${path}[${index}]`)
  );
}

/**
 * 値ごとの出どころ。
 *
 * **小説では登場人物が作中で変わる。** 髪を切る、立場が変わる、口調が変わる。
 * 値が2つ並んでいるだけでは「AIの取り違え」なのか「作中での変化」なのか
 * 読み分けられないが、**話数と並べれば「第1話では黒髪、第7話では銀髪」**と
 * 読める。作者の指摘（2026-08-11）による。
 */
export interface ConflictObservation {
  value: string;
  /**
   * その値が出てきた話数。
   * 空配列は「食い違いに気づく前から入っていた値」を意味する。
   * どの話で書かれたかを遡って知る手段が無いため、推測で埋めない。
   */
  chapters: number[];
}

/** 設定と本文の食い違い（作中での変化かもしれない）を表す共通の構造 */
export interface RecordConflict {
  field: string;
  values: string[];
  chapters: number[];
  note: string | null;
  /** 値ごとの話数。古いデータには無いので省略可能にしてある */
  observations?: ConflictObservation[];
}

/**
 * 値と、それが出てきた話数を記録する。
 *
 * 同じ値が別の話にも出てきたら、話数だけを足す。
 * 「第3話と第9話では黒髪、第7話では銀髪」のような読み方ができるようにする。
 */
export function recordObservation(
  conflict: RecordConflict,
  value: string,
  chapters: number[]
): boolean {
  const valid = chapters.filter((chapter) => Number.isSafeInteger(chapter));
  if (!conflict.observations) conflict.observations = [];
  const found = conflict.observations.find((item) => item.value === value);
  if (!found) {
    conflict.observations.push({ value, chapters: sortedUnique(valid) });
    return true;
  }
  const merged = sortedUnique([...found.chapters, ...valid]);
  // 増えていなければ書き換えない。呼ぶたびに「変更あり」と返すと、
  // 中身が同じままファイルを保存し直すことになる
  if (merged.length === found.chapters.length) return false;
  found.chapters = merged;
  return true;
}

function sortedUnique(chapters: number[]): number[] {
  return [...new Set(chapters)].sort((a, b) => a - b);
}

/**
 * 2つのレコードの食い違いを、項目ごとに1つへまとめる。
 *
 * 同一人物をまとめるときなど、両方に同じ項目の食い違いがあることがある。
 * **単に並べると、同じ見出しが2つ出るだけでは済まない。**
 * この先のマージは `field` で最初の1件しか見ないので、2件目は
 * 表示されるのに二度と更新されない取り残しになる。
 *
 * 作者が書いた `note` は捨てず、両方あれば繋ぐ。
 */
export function mergeConflicts(
  left: RecordConflict[],
  right: RecordConflict[]
): RecordConflict[] {
  const merged: RecordConflict[] = [];

  for (const conflict of [...left, ...right]) {
    const found = merged.find((entry) => entry.field === conflict.field);
    if (!found) {
      merged.push({
        ...conflict,
        values: [...conflict.values],
        chapters: [...conflict.chapters],
        observations: conflict.observations?.map((item) => ({
          value: item.value,
          chapters: [...item.chapters],
        })),
      });
      continue;
    }

    for (const value of conflict.values) {
      if (!found.values.includes(value)) found.values.push(value);
    }
    found.chapters = sortedUnique([...found.chapters, ...conflict.chapters]);
    for (const item of conflict.observations ?? []) {
      recordObservation(found, item.value, item.chapters);
    }
    // 作者のメモは片方を捨てない
    const notes = [found.note, conflict.note]
      .map((note) => note?.trim())
      .filter((note): note is string => Boolean(note));
    found.note = notes.length > 0 ? [...new Set(notes)].join("\n") : null;
  }

  return merged;
}

/**
 * 作中での変化。
 *
 * `RecordConflict`（食い違い）と役割を分ける。
 *   - `conflicts` ＝ 値が食い違ったが、**作者がまだ見ていない**もの
 *   - `changes`   ＝ 作者が「これは作中の変化だ」と**確定させた**もの
 *
 * 食い違いのままでは「AIの取り違え」と「作中での変化」を機械が区別できず、
 * 資料にも「変化かもしれない」としか書けない。作者が一度判断したことを
 * ここへ移すことで、以後は変化として扱える（設計書6.18）。
 *
 * **AIには書かせない。** 記録するのはコードと作者だけである。
 * 「省略可能な項目は小さいモデルが黙って落とす」という既知の問題は、
 * AIに書かせる項目の話であり、ここには当てはまらない。
 */
export interface RecordChange {
  /** どの項目が変わったか（"appearance" など） */
  field: string;
  /** そのときの値 */
  value: string;
  /** その値が書かれていた話数。空なら「それ以前」（記録が無い） */
  chapters: number[];
  /**
   * 作中のいつのことか（`設定/timeline.json` の時期ID）。
   * 未設定なら null。話数だけでも変化の記録としては成立する。
   */
  timepointId: string | null;
  /** 作者が書いた補足。AIは書き換えない */
  note: string | null;
  evidence: string | null;
  /** extracted ＝ 食い違いからの昇格、author ＝ 作者が直接書いた */
  source: "extracted" | "author";
}

export function findChange(
  changes: RecordChange[],
  field: string,
  value: string
): RecordChange | undefined {
  return changes.find(
    (change) => change.field === field && change.value === value
  );
}

/**
 * 既に変化として記録されている値か。
 *
 * 抽出のたびに同じ値を食い違いへ戻さないために使う。
 * 戻してしまうと、作者が昇格させたそばから同じ判断を求められ、
 * 操作そのものが無意味になる。
 */
export function hasChange(
  changes: RecordChange[],
  field: string,
  value: string
): boolean {
  return findChange(changes, field, value) !== undefined;
}

/**
 * 既に記録されている変化に話数を足す。
 * 対象が無ければ何もせず false を返す（新しい変化を勝手に作らない）。
 */
export function recordChangeChapters(
  changes: RecordChange[],
  field: string,
  value: string,
  chapters: number[]
): boolean {
  const change = findChange(changes, field, value);
  if (!change) return false;
  const merged = sortedUnique([
    ...change.chapters,
    ...chapters.filter((chapter) => Number.isSafeInteger(chapter)),
  ]);
  // 増えていなければ書き換えない。呼ぶたびに「変更あり」と返すと、
  // 中身が同じままファイルを保存し直すことになる
  if (merged.length === change.chapters.length) return false;
  change.chapters = merged;
  return true;
}

/**
 * 2つの変化の記録を1つにまとめる。同一人物をまとめるときに使う。
 *
 * **作者が書いた補足は捨てない。** 片方にしかなければそれを残し、
 * 両方にあれば繋ぐ（`unifyCharacters` の作者メモと同じ方針）。
 */
export function mergeChangeLists(
  left: RecordChange[],
  right: RecordChange[]
): RecordChange[] {
  const merged: RecordChange[] = [];

  for (const change of [...left, ...right]) {
    const found = findChange(merged, change.field, change.value);
    if (!found) {
      merged.push({ ...change, chapters: [...change.chapters] });
      continue;
    }
    found.chapters = sortedUnique([...found.chapters, ...change.chapters]);
    found.timepointId = found.timepointId ?? change.timepointId;
    found.evidence = found.evidence ?? change.evidence;
    const notes = [found.note, change.note]
      .map((note) => note?.trim())
      .filter((note): note is string => Boolean(note));
    found.note = notes.length > 0 ? [...new Set(notes)].join("\n") : null;
    // 作者が書いたものは、昇格由来のものより強い
    if (change.source === "author") found.source = "author";
  }

  return merged;
}

export function parseChanges(
  value: unknown,
  path = "changes"
): RecordChange[] | undefined {
  return optionalObjectArray(value, path, (entry, entryPath) => {
    requireNonEmptyString(entry.field, `${entryPath}.field`);
    requireNonEmptyString(entry.value, `${entryPath}.value`);
    optionalNumberArray(entry.chapters, `${entryPath}.chapters`);
    optionalNullableString(entry.timepointId, `${entryPath}.timepointId`);
    optionalNullableString(entry.note, `${entryPath}.note`);
    optionalNullableString(entry.evidence, `${entryPath}.evidence`);
    optionalEnum(entry.source, `${entryPath}.source`, ["extracted", "author"]);
    return {
      field: entry.field as string,
      value: entry.value as string,
      chapters: (entry.chapters as number[] | undefined) ?? [],
      timepointId: (entry.timepointId as string | null | undefined) ?? null,
      note: (entry.note as string | null | undefined) ?? null,
      evidence: (entry.evidence as string | null | undefined) ?? null,
      source:
        (entry.source as RecordChange["source"] | undefined) ?? "extracted",
    };
  });
}

export function parseConflicts(
  value: unknown,
  path = "conflicts"
): RecordConflict[] | undefined {
  return optionalObjectArray(value, path, (entry, entryPath) => {
    requireNonEmptyString(entry.field, `${entryPath}.field`);
    optionalStringArray(entry.values, `${entryPath}.values`);
    optionalNumberArray(entry.chapters, `${entryPath}.chapters`);
    optionalNullableString(entry.note, `${entryPath}.note`);
    const observations = optionalObjectArray(
      entry.observations,
      `${entryPath}.observations`,
      (item, itemPath) => {
        requireNonEmptyString(item.value, `${itemPath}.value`);
        optionalNumberArray(item.chapters, `${itemPath}.chapters`);
        return {
          value: item.value as string,
          chapters: (item.chapters as number[] | undefined) ?? [],
        };
      }
    );
    return {
      field: entry.field as string,
      values: (entry.values as string[] | undefined) ?? [],
      chapters: (entry.chapters as number[] | undefined) ?? [],
      note: (entry.note as string | null | undefined) ?? null,
      ...(observations ? { observations } : {}),
    };
  });
}
