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

/**
 * 「話数」のように、数字か「不明（null）」しか取らない項目。
 *
 * 負の数と小数を弾く。話数に -1 や 3.5 が入ると、並べ替えも
 * 「第◯話」の表示も静かに崩れる（例外にならないぶん見つけにくい）。
 */
export function optionalNullableNumber(value: unknown, path: string): void {
  if (value === undefined || value === null) return;
  if (!Number.isSafeInteger(value) || (value as number) < 0) invalid(path);
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
  /**
   * その値を読み取った本文の引用（P-01 の `evidence`）。古いデータには無い。
   *
   * **食い違いを変化へ畳むとき、根拠を運ぶため**（作者の裁定、2026-09-23）。
   * 根拠の無い変化は本体の値を動かさない（`recordChanges.ts` の
   * `changeMovesBody`）。ここで落とすと、抽出が根拠を示していた値まで
   * 畳んだ時点で「根拠なし」になり、本体へ入れられなくなる
   */
  evidence?: string | null;
  /**
   * この値が似ていた**別の人物の名前**（精査 F4、作者の判断 2026-09-25）。
   *
   * 同じ話の別の人物の同じ項目の記述に似ていたので、作中の変化に積まずに
   * 食い違いとして止めた値に付く（`core/characterResemblance.ts`）。
   * 資料には「〇〇の記述と似ています」と添える。**付いている食い違いは
   * 自動で変化へ畳まない**（`recordChanges.ts` の `isFoldableConflict`）——
   * 畳むと、別人の記述がまた年表へ流れる。古いデータには無い
   */
  resembles?: string;
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
  chapters: number[],
  /** その値を読み取った本文の引用。**既にあれば置き換えない**（最初の根拠を残す） */
  evidence: string | null = null
): boolean {
  const valid = chapters.filter((chapter) => Number.isSafeInteger(chapter));
  if (!conflict.observations) conflict.observations = [];
  const found = conflict.observations.find((item) => item.value === value);
  const quote = evidence?.trim() || null;
  if (!found) {
    conflict.observations.push({
      value,
      chapters: sortedUnique(valid),
      // 根拠が無いときは項目ごと置かない（古いデータと同じ形のまま）
      ...(quote ? { evidence: quote } : {}),
    });
    return true;
  }
  let changed = false;
  if (quote && !found.evidence?.trim()) {
    found.evidence = quote;
    changed = true;
  }
  const merged = sortedUnique([...found.chapters, ...valid]);
  // 増えていなければ書き換えない。呼ぶたびに「変更あり」と返すと、
  // 中身が同じままファイルを保存し直すことになる
  if (merged.length === found.chapters.length) return changed;
  found.chapters = merged;
  return true;
}

/**
 * 食い違いの値に「別の人物の記述に似ていた」印を付ける（精査 F4）。
 * **既に付いていれば置き換えない**（最初に似ていた相手を残す）。
 * 値が記録に無ければ何もしない。何か変わったら true。
 */
export function noteResemblance(
  conflict: RecordConflict,
  value: string,
  name: string
): boolean {
  const label = name.trim();
  if (!label) return false;
  const found = conflict.observations?.find((item) => item.value === value);
  if (!found || found.resembles) return false;
  found.resembles = label;
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
          ...item,
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
      // 値ごとの根拠も運ぶ。落とすと、畳んだときに本体を動かせなくなる
      recordObservation(found, item.value, item.chapters, item.evidence ?? null);
      // 別の人物に似ていた印も運ぶ。落とすと、次の抽出で変化へ畳まれる
      if (item.resembles) noteResemblance(found, item.value, item.resembles);
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
  /**
   * 作者が「この変化は正しい」と認めた（作者の裁定、2026-09-23）。
   *
   * **根拠（`evidence`）の無い変化は、本体の値を動かさない**——
   * 「要確認」として残る（`recordChanges.ts` の `changeMovesBody`）。
   * 作者が設定資料パネルで認めたら、根拠の代わりにこの印を立てる。
   * 出どころ（`source`）とは分ける：抽出が見つけた値であることは変わらない
   */
  confirmed?: boolean;
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
    // 作者が認めた印も落とさない（片方で認めていれば、認めたことになる）
    if (change.confirmed === true) found.confirmed = true;
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
    optionalBoolean(entry.confirmed, `${entryPath}.confirmed`);
    return {
      field: entry.field as string,
      value: entry.value as string,
      chapters: (entry.chapters as number[] | undefined) ?? [],
      timepointId: (entry.timepointId as string | null | undefined) ?? null,
      note: (entry.note as string | null | undefined) ?? null,
      evidence: (entry.evidence as string | null | undefined) ?? null,
      source:
        (entry.source as RecordChange["source"] | undefined) ?? "extracted",
      // 立っているときだけ置く。立っていない記録を読み直して書くたびに
      // `confirmed: false` が増えると、作者の目には無関係の差分に見える
      ...(entry.confirmed === true ? { confirmed: true } : {}),
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
        optionalNullableString(item.evidence, `${itemPath}.evidence`);
        optionalNullableString(item.resembles, `${itemPath}.resembles`);
        const evidence = (item.evidence as string | null | undefined)?.trim();
        const resembles = (item.resembles as string | null | undefined)?.trim();
        return {
          value: item.value as string,
          chapters: (item.chapters as number[] | undefined) ?? [],
          // 根拠が無いときは項目ごと置かない（古いデータと同じ形のまま）
          ...(evidence ? { evidence } : {}),
          // 別の人物に似ていた印も、無いときは置かない
          ...(resembles ? { resembles } : {}),
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
