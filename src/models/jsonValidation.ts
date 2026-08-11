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
): void {
  const valid = chapters.filter((chapter) => Number.isSafeInteger(chapter));
  if (!conflict.observations) conflict.observations = [];
  const found = conflict.observations.find((item) => item.value === value);
  if (!found) {
    conflict.observations.push({ value, chapters: [...new Set(valid)].sort((a, b) => a - b) });
    return;
  }
  found.chapters = [...new Set([...found.chapters, ...valid])].sort((a, b) => a - b);
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
