/**
 * 作品一覧の控え（設計書6.107。引継ぎ書「ノートPCの作品一覧が遅い件」）。
 *
 * 作品一覧は全作品を読み終えるまで1行も出ず、ノートPC（19作品・約590ファイル）
 * では起動のたびに14〜105秒かかっていた。**前回の一覧で行に出していた値**を
 * 拡張機能の保管庫（globalState）に控えておき、開いた瞬間にそれを出す。
 * 走査が終われば走査の結果で差し替える（差し替えは `views/workTree.ts`）。
 *
 * **作品フォルダーには書かない。** 控えはこの端末で一覧を早く出すためだけの
 * ものなので、同期される場所へ置くと別の端末の数字が混ざる。登録簿と同じ
 * globalState に置き、`folderPath` も一緒に控えて場所が変わった作品には使わない。
 *
 * **`vscode` に依存させない**（`core` の決まり）。保管庫は `get`／`update`
 * だけの口で受け取る（`vscode.Memento` はそのまま渡せる）。
 */
import type { CharCounts, WorkEntry, WorkKindKey } from "../models/types";
import { WORK_FORMATS, type WorkFormatKey } from "./workFormat";
import { WORK_KINDS } from "./workKind";

/** 保管庫の鍵 */
export const WORK_LIST_SNAPSHOT_KEY = "novelai.workList.snapshot";

/**
 * 控えの形の版。**形を変えたら上げる。** 違う版の控えは読まずに捨てる
 * （古い形を無理に読むより、1回だけ走査を待つほうが安全）。
 */
export const WORK_LIST_SNAPSHOT_VERSION = 1;

/** 1作品ぶんの控え。作品一覧の行に出す値だけを持つ */
export interface WorkListSnapshotEntry {
  id: string;
  /** 控えたときの場所。いまの登録簿と違えば使わない */
  folderPath: string;
  fileCount: number;
  totals: CharCounts;
  conflictedCount: number;
  /** 作品の形式。右クリックの絞り込みに要る（設計書6.70.1） */
  format?: WorkFormatKey;
  /** 作品の種類。同じく右クリックと吹き出しの目安に要る（6.109） */
  kind?: WorkKindKey;
}

export interface WorkListSnapshot {
  version: number;
  /** 控えた時刻（ISO8601）。いまは読まないが、あとで古さを確かめるために残す */
  savedAt: string;
  works: WorkListSnapshotEntry[];
}

/** 保管庫の口。`vscode.Memento` の一部 */
export interface WorkListSnapshotStore {
  get(key: string): unknown;
  update(key: string, value: unknown): PromiseLike<void>;
}

export function buildWorkListSnapshot(
  works: readonly WorkListSnapshotEntry[],
  savedAt: string
): WorkListSnapshot {
  return {
    version: WORK_LIST_SNAPSHOT_VERSION,
    savedAt,
    works: works.map((w) => ({ ...w, totals: { ...w.totals } })),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function parseTotals(raw: unknown): CharCounts | undefined {
  if (!isRecord(raw)) return undefined;
  const { gross, net, lines, paragraphs, manuscriptLines } = raw;
  if (
    !isCount(gross) ||
    !isCount(net) ||
    !isCount(lines) ||
    !isCount(paragraphs) ||
    !isCount(manuscriptLines)
  ) {
    return undefined;
  }
  return { gross, net, lines, paragraphs, manuscriptLines };
}

function parseEntry(raw: unknown): WorkListSnapshotEntry | undefined {
  if (!isRecord(raw)) return undefined;
  const { id, folderPath, fileCount, conflictedCount } = raw;
  if (typeof id !== "string" || id === "") return undefined;
  if (typeof folderPath !== "string") return undefined;
  if (!isCount(fileCount) || !isCount(conflictedCount)) return undefined;
  const totals = parseTotals(raw.totals);
  if (!totals) return undefined;
  const entry: WorkListSnapshotEntry = {
    id,
    folderPath,
    fileCount,
    totals,
    conflictedCount,
  };
  // 知らない形式・種類は捨てる（行そのものは使う。右クリックが絞られないだけ）
  const format = WORK_FORMATS.find((f) => f.key === raw.format)?.key;
  if (format) entry.format = format;
  const kind = WORK_KINDS.find((k) => k.key === raw.kind)?.key;
  if (kind) entry.kind = kind;
  return entry;
}

/**
 * 控えを読み、作品ID → 控えの対応にする。
 *
 * **壊れていても投げない。** 控えは一覧を早く出すためだけのもので、
 * 読めなければ走査を待てばよい。壊れた行だけを捨て、読める行は使う。
 */
export function parseWorkListSnapshot(
  raw: unknown
): Map<string, WorkListSnapshotEntry> {
  const result = new Map<string, WorkListSnapshotEntry>();
  if (!isRecord(raw)) return result;
  if (raw.version !== WORK_LIST_SNAPSHOT_VERSION) return result;
  if (!Array.isArray(raw.works)) return result;
  for (const item of raw.works) {
    const entry = parseEntry(item);
    if (entry && !result.has(entry.id)) result.set(entry.id, entry);
  }
  return result;
}

/** 保管庫から控えを読む。読み出しが投げても空で返す */
export function readWorkListSnapshot(
  store: WorkListSnapshotStore
): Map<string, WorkListSnapshotEntry> {
  try {
    return parseWorkListSnapshot(store.get(WORK_LIST_SNAPSHOT_KEY));
  } catch {
    return new Map();
  }
}

/**
 * いまの登録簿の作品に当たる控え。
 *
 * **場所が変わっていれば使わない。** 同じIDのまま別のフォルダーへ
 * 付け替えた作品に、前のフォルダーの数字を出さないため。
 */
export function snapshotEntryFor(
  work: WorkEntry,
  snapshot: ReadonlyMap<string, WorkListSnapshotEntry>
): WorkListSnapshotEntry | undefined {
  const entry = snapshot.get(work.id);
  if (!entry || entry.folderPath !== work.folderPath) return undefined;
  return entry;
}
