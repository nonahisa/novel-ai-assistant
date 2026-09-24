import { AIWRITER_DIR } from "../models/types";
// `paths.ts` ではなく純粋な部分を直に指す——ここは MCP の束からも読まれ、
// `vscode` へ届いてはいけない（`mcpReach.test.ts` が見張る）
import * as path from "./pathText";
import { findLibraries } from "./libraryHome";

/**
 * 作品の登録簿の写し（MCP の道具 `works.list`。作者の承認、2026-09-24）。
 *
 * **なぜ要るか。** 登録簿は VS Code の `globalState` にあり、外から読めない。
 * 二重登録の件（2026-09-24）は、コードを読んで推理するしかなかった。
 * そこで**拡張機能が登録簿の写しを保管庫へ書き、MCP がそれを読む**
 * （窓の札 `core/windowCard.ts` と同じ形。MCP は読むだけで、
 * **登録簿を書き換える道は作らない**）。
 *
 * **写しは作品の中身を持たない。** 作品ID・作品名・場所・登録日と、
 * 場所から割り出した「書庫」だけ。本文も設定資料も開かない。
 *
 * ここは**形と判定だけ**。書く側（`features/worksSnapshot.ts`）と読む側
 * （`mcp/tools/works.ts`）が同じものを見る。
 */

/** 写しの置き場（保管庫からの相対） */
export const WORKS_SNAPSHOT_PATH = [AIWRITER_DIR, "works.json"] as const;

/** 写しの形の版。読めない版は「壊れた写し」として扱う */
export const WORKS_SNAPSHOT_SCHEMA = 1;

/** 登録簿の1件（`WorkEntry` と同じ形。`models` の型に縛られないよう、ここで受ける） */
export interface RegisteredWorkLike {
  id: unknown;
  title: unknown;
  folderPath: unknown;
  registeredAt: unknown;
}

export interface WorksSnapshotEntry {
  id: string;
  title: string;
  folderPath: string;
  registeredAt: string;
  /**
   * 作品フォルダーの1つ上（書庫なら書庫のフォルダー）。取れなければ `null`。
   */
  parentFolder: string | null;
  /**
   * 同じ親フォルダーに登録されている作品の数（自分を含む）。
   */
  siblingsRegistered: number;
  /**
   * 書庫に入っているか——**登録簿から分かる範囲で**：同じ親フォルダーに
   * 登録済みの作品が2つ以上あれば書庫とみなす。
   *
   * **1作品だけの書庫は見分けられない。** 書庫の場所は覚えない決まり
   * （`libraryHome.ts`。作者がフォルダーを動かすと食い違う）なので、
   * 登録簿の外に手がかりが無い。`parentFolder` を並べて読めば補える。
   */
  inLibrary: boolean;
}

export interface WorksSnapshot {
  schema: number;
  /** 写しを書いた時刻（ISO）。**古い写しと分かるように必ず返す** */
  writtenAt: string;
  /**
   * 書いた窓。登録簿は窓をまたいで同じだが、変わったことを知らせる合図
   * （`onDidChange`）は変えた窓にしか届かない——**最後に書いた窓**が分かれば、
   * 写しがどの窓から見た登録簿かを辿れる。
   */
  writtenBy: {
    pid: number | null;
    extensionVersion: string;
    machineName: string | null;
  };
  works: WorksSnapshotEntry[];
  /** 登録済みの作品が2つ以上入っている親フォルダー（作品の多い順） */
  libraries: { folderPath: string; workCount: number }[];
  /**
   * 同じ場所が2度以上登録されているもの（比べ方は登録の重複の断りと同じ
   * `folderKeyForComparison`）。**空なら二重登録は無い。**
   */
  duplicates: { folderPath: string; ids: string[] }[];
}

export interface WorksSnapshotWriter {
  pid: number | null;
  extensionVersion: string;
  machineName: string | null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** 親フォルダーの鍵。`findLibraries` と同じ割り出し方にする（書庫を数える道を2本にしない） */
function parentOf(folderPath: string): string | null {
  if (!folderPath.trim()) return null;
  const normalized = path.normalize(folderPath);
  const parent = path.dirname(normalized);
  if (!parent || parent === normalized) return null;
  return parent;
}

/**
 * 登録簿から写しを組み立てる。**時刻は引数で受ける**（テストで固定できるように）。
 *
 * **受け取った並びをそのまま残す**（書く側が登録日の順に並べて渡す）。
 * ここで並べ替えると、渡した側の意図した順が写しから読めなくなる。
 * 項目が欠けた記録（手で触られた登録簿）も落とさず、空の文字で埋めて並べる
 * ——落とすと「登録簿にあるのに写しに無い」が起き、食い違いの調べ物を誤らせる。
 */
export function buildWorksSnapshot(
  works: readonly RegisteredWorkLike[],
  writer: WorksSnapshotWriter,
  now: Date
): WorksSnapshot {
  const plain = works.map((work) => ({
    id: text(work.id),
    title: text(work.title),
    folderPath: text(work.folderPath),
    registeredAt: text(work.registeredAt),
  }));

  const located = plain.filter((work) => work.folderPath.trim());
  const counts = new Map<string, number>();
  for (const library of findLibraries(located)) {
    counts.set(path.normalizeForComparison(library.folderPath), library.workCount);
  }

  const entries = plain.map((work): WorksSnapshotEntry => {
    const parent = parentOf(work.folderPath);
    const siblings = parent ? counts.get(path.normalizeForComparison(parent)) ?? 1 : 1;
    return {
      ...work,
      parentFolder: parent,
      siblingsRegistered: siblings,
      inLibrary: siblings >= 2,
    };
  });

  const libraries = findLibraries(located)
    .filter((library) => library.workCount >= 2)
    .map((library) => ({
      folderPath: library.folderPath,
      workCount: library.workCount,
    }));

  const byKey = new Map<string, { folderPath: string; ids: string[] }>();
  for (const work of plain) {
    const key = path.folderKeyForComparison(work.folderPath);
    if (!key) continue;
    const found = byKey.get(key);
    if (found) found.ids.push(work.id);
    else byKey.set(key, { folderPath: work.folderPath, ids: [work.id] });
  }
  const duplicates = [...byKey.values()].filter((group) => group.ids.length > 1);

  return {
    schema: WORKS_SNAPSHOT_SCHEMA,
    writtenAt: now.toISOString(),
    writtenBy: { ...writer },
    works: entries,
    libraries,
    duplicates,
  };
}

export function serializeWorksSnapshot(snapshot: WorksSnapshot): string {
  return `${JSON.stringify(snapshot, null, 2)}\n`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function parseEntry(value: unknown): WorksSnapshotEntry | undefined {
  if (!isObject(value)) return undefined;
  if (
    typeof value.id !== "string" ||
    typeof value.title !== "string" ||
    typeof value.folderPath !== "string" ||
    typeof value.registeredAt !== "string" ||
    (value.parentFolder !== null && typeof value.parentFolder !== "string") ||
    typeof value.siblingsRegistered !== "number" ||
    typeof value.inLibrary !== "boolean"
  ) {
    return undefined;
  }
  return {
    id: value.id,
    title: value.title,
    folderPath: value.folderPath,
    registeredAt: value.registeredAt,
    parentFolder: value.parentFolder,
    siblingsRegistered: value.siblingsRegistered,
    inLibrary: value.inLibrary,
  };
}

/**
 * 写しを読む。**形が合わなければ `undefined`**（直しにいかない）。
 *
 * 登録簿の写しは1件でも欠けると調べ物を誤らせるので、窓の札や知らせの
 * 記録と違って**1件でも読めなければ写しごと「壊れている」**と返す。
 */
export function parseWorksSnapshot(text: string): WorksSnapshot | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isObject(raw)) return undefined;
  if (raw.schema !== WORKS_SNAPSHOT_SCHEMA) return undefined;
  if (typeof raw.writtenAt !== "string") return undefined;
  const writer = raw.writtenBy;
  if (
    !isObject(writer) ||
    (writer.pid !== null && typeof writer.pid !== "number") ||
    typeof writer.extensionVersion !== "string" ||
    (writer.machineName !== null && typeof writer.machineName !== "string")
  ) {
    return undefined;
  }
  if (!Array.isArray(raw.works)) return undefined;
  const works: WorksSnapshotEntry[] = [];
  for (const item of raw.works) {
    const entry = parseEntry(item);
    if (!entry) return undefined;
    works.push(entry);
  }
  if (!Array.isArray(raw.libraries) || !Array.isArray(raw.duplicates)) return undefined;
  const libraries: WorksSnapshot["libraries"] = [];
  for (const item of raw.libraries) {
    if (!isObject(item) || typeof item.folderPath !== "string" || typeof item.workCount !== "number") {
      return undefined;
    }
    libraries.push({ folderPath: item.folderPath, workCount: item.workCount });
  }
  const duplicates: WorksSnapshot["duplicates"] = [];
  for (const item of raw.duplicates) {
    if (!isObject(item) || typeof item.folderPath !== "string" || !isStringArray(item.ids)) {
      return undefined;
    }
    duplicates.push({ folderPath: item.folderPath, ids: item.ids });
  }
  return {
    schema: WORKS_SNAPSHOT_SCHEMA,
    writtenAt: raw.writtenAt,
    writtenBy: {
      pid: writer.pid as number | null,
      extensionVersion: writer.extensionVersion,
      machineName: writer.machineName as string | null,
    },
    works,
    libraries,
    duplicates,
  };
}
