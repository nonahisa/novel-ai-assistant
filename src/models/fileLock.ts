/**
 * 校閲中のファイルのロック（設計書5.6）。
 *
 * **ファイル単位でかける**（2026-08-19、作者の判断）。
 * 作品全体を止めると、編集部が第3話を見ている間、作者は第20話も書けない。
 * **止めるのは、いま見ているファイルだけでよい。**
 *
 * **ロックは「取る／外す」の記録の積み重ねで表す。** 1つのJSONを
 * 書き換える作りにすると、編集部と作者が同時に触ったときに競合する。
 * 追記だけなら競合しにくく、競合しても両方の行を残せば正しくなる。
 *
 * **これは紳士協定である。** 別のエディタで開いて書くことは止められない。
 * 止められるのは拡張機能の操作だけで、それで足りる（相手は見えている）。
 *
 * **作者はいつでも外せる。** 編集部が外し忘れたまま連絡が付かないと、
 * 作者が自分の原稿を触れなくなる。**それだけは起きてはならない。**
 */

export type LockHolderKind = "editor" | "author";

export interface LockEvent {
  kind: "acquire" | "release";
  /** 作品フォルダーからの相対パス */
  file: string;
  /** 誰が（gitの user.name） */
  holder: string;
  holderKind: LockHolderKind;
  time: string;
  /** 何をしているか。作者が見て分かるように */
  note: string;
}

export interface FileLock {
  file: string;
  holder: string;
  holderKind: LockHolderKind;
  since: string;
  note: string;
}

/**
 * 記録から、いまロックされているファイルを割り出す。
 *
 * **ファイルごとに、いちばん新しい記録が勝つ。** 取ってから外した
 * のなら外れているし、外してから取り直したのならかかっている。
 */
export function resolveLocks(events: LockEvent[]): Map<string, FileLock> {
  const latest = new Map<string, LockEvent>();
  for (const event of events) {
    const key = normalizeFile(event.file);
    const current = latest.get(key);
    if (!current || isNewer(event.time, current.time)) latest.set(key, event);
  }

  const locks = new Map<string, FileLock>();
  for (const [key, event] of latest) {
    if (event.kind !== "acquire") continue;
    locks.set(key, {
      file: event.file,
      holder: event.holder,
      holderKind: event.holderKind,
      since: event.time,
      note: event.note,
    });
  }
  return locks;
}

/** そのファイルは、いま誰かに押さえられているか */
export function lockOf(
  locks: Map<string, FileLock>,
  file: string
): FileLock | undefined {
  return locks.get(normalizeFile(file));
}

/**
 * 作者へ出す説明。
 *
 * **誰が・いつから・何をしているかを全部言う。** 「ロックされています」
 * だけでは、待てばよいのか連絡すべきなのか判断できない。
 */
export function describeLock(lock: FileLock): string {
  const who = lock.holder || "編集部";
  const since = formatSince(lock.since);
  const what = lock.note ? `（${lock.note}）` : "";
  return `${who} が校閲中です${what}。${since}`;
}

function formatSince(time: string): string {
  const parsed = Date.parse(time);
  if (Number.isNaN(parsed)) return "開始した時刻は分かりません。";
  const elapsed = Date.now() - parsed;
  const hours = Math.floor(elapsed / 3_600_000);
  if (hours < 1) return "始まったばかりです。";
  if (hours < 24) return `${hours}時間ほど前からです。`;
  const days = Math.floor(hours / 24);
  return `${days}日ほど前からです。**外し忘れかもしれません。**`;
}

/** パスの表記ゆれを吸収する（Windowsの区切りと大文字小文字） */
export function normalizeFile(file: string): string {
  return file.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
}

function isNewer(candidate: string, current: string): boolean {
  const left = Date.parse(candidate);
  const right = Date.parse(current);
  if (Number.isNaN(left)) return false;
  if (Number.isNaN(right)) return true;
  return left >= right;
}
