import { parseActorKind, type ActorKind } from "../models/actor";

/**
 * 編集履歴（設計書5.6）の**読み方と置き場所の名前**。VS Code API に依存しない。
 *
 * 書く側（`editHistory.ts`）は `vscode` の fs を使うが、MCP の読む口
 * （`novel.read kind: editHistory`。設計書6.87.24）も同じ読み方で読む必要がある。
 * 写すと、片方だけ直した日に外部AIの読む履歴が作者の画面と食い違うので、
 * 読み方だけをここへ切り出した。
 */

/** 同期される場所（`cache/` と `logs/` だけが除外されている） */
export const HISTORY_DIRECTORY = "history";
export const HISTORY_FILE = "edits.jsonl";

export interface EditHistoryEntry {
  /** ISO 8601。**並べ替えは読むときに行う**ので、書く側は素直に今の時刻 */
  time: string;
  actor: ActorKind;
  /** 誰か（gitの user.name）。同じ編集者が複数いることもある */
  actorName: string;
  /** 何をしたか。作者が読む言葉で入れる（「誤字を直した」など） */
  action: string;
  /** どのファイルか。作品フォルダーからの相対パス。無ければ空 */
  file: string;
  /** 補足。直した中身など。無ければ空 */
  detail: string;
}

/**
 * 1行1件のJSONを読む。
 *
 * **読めない行は捨てて、読める行は残す。** 競合で行が壊れることがあり、
 * そこで全部を諦めると、無事な履歴まで見えなくなる。
 *
 * **競合マーカーの行も落とす。** 解決前でも中身は読めたほうがよい。
 */
export function parseHistory(text: string): EditHistoryEntry[] {
  const entries: EditHistoryEntry[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/^(<<<<<<<|=======|>>>>>>>)/.test(line)) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      const entry = toEntry(parsed);
      if (entry) entries.push(entry);
    } catch {
      // 壊れた行は捨てる
    }
  }
  return entries;
}

/**
 * 同じ操作が二重に入っていないか。
 *
 * **競合を「両方残す」で解決すると、同じ行が2つになることがある。**
 * 時刻・誰・何が全部同じなら、同じ操作とみなして1つにする。
 */
export function dedupeHistory(
  entries: EditHistoryEntry[]
): EditHistoryEntry[] {
  const seen = new Set<string>();
  const kept: EditHistoryEntry[] = [];
  for (const entry of entries) {
    const key = [
      entry.time,
      entry.actor,
      entry.actorName,
      entry.action,
      entry.file,
      entry.detail,
    ].join("\u0000");
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(entry);
  }
  return kept;
}

/** 新しいものが先。**時刻が読めない行は末尾へ**（捨てはしない） */
export function sortNewestFirst(
  entries: EditHistoryEntry[]
): EditHistoryEntry[] {
  return dedupeHistory(entries).sort((a, b) => {
    const left = Date.parse(a.time);
    const right = Date.parse(b.time);
    if (Number.isNaN(left) && Number.isNaN(right)) return 0;
    if (Number.isNaN(left)) return 1;
    if (Number.isNaN(right)) return -1;
    return right - left;
  });
}

function toEntry(value: unknown): EditHistoryEntry | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const actor = parseActorKind(record.actor);
  const action = asString(record.action);
  // **誰と何が分からない行は、履歴として意味が無い**
  if (!actor || !action) return undefined;
  return {
    time: asString(record.time),
    actor,
    actorName: asString(record.actorName),
    action,
    file: asString(record.file),
    detail: asString(record.detail),
  };
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}
