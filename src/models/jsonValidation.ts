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

/** 設定と本文の食い違いを表す共通の構造 */
export interface RecordConflict {
  field: string;
  values: string[];
  chapters: number[];
  note: string | null;
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
    return {
      field: entry.field as string,
      values: (entry.values as string[] | undefined) ?? [],
      chapters: (entry.chapters as number[] | undefined) ?? [],
      note: (entry.note as string | null | undefined) ?? null,
    };
  });
}
