/**
 * 「送らずに閉じた」印（設計書6.15.1）。
 *
 * ## なぜ要るか
 *
 * 閉じる前の確認（`deactivate()`）は**確実には動かない。** VS Code は
 * `deactivate()` の非同期の完了を待ち切らないので、問いが出ないまま閉じる
 * ことがある。**通信や電池が切れる場面と同じ形の危なさである。**
 *
 * だから**これを唯一の守りにしない。** 出なかったときの受け皿が、
 * 次に開いたときの点検である。
 *
 * ## 印を付けるのは同期の処理、消すのは送信が通ったときだけ
 *
 * `deactivate()` で書こうとすると、そこが待たれない以上**印まで残らない**
 * ことがある。だから**未送信を見つけた時点で先に書いておく**。
 * 消すのは送信が通ったときだけなので、次に開いたときに印が残っていれば
 * 「前回、送らずに閉じた」と言い切れる。
 *
 * VS Code APIに依存しない（`globalState` は `device.ts` と同じ形の口で受ける）。
 */

import type { GitSyncStatus } from "./git";

/** 保存先の鍵（`globalState`。作品をまたいで共通） */
export const UNSENT_MARK_KEY = "novelai.unsentAtClose";

/** 印を覚えておく場所。VS Code の `globalState` を想定 */
export interface UnsentMarkStorage {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Promise<void> | Thenable<void>;
}

export interface UnsentMark {
  /** 印を付けた日時（ISO8601） */
  at: string;
  /** 送っていないものの数（置き場ぜんぶの合計） */
  ahead: number;
  /** 記録していないものの数（置き場ぜんぶの合計） */
  dirty: number;
  /** どの置き場か。**名前を出さないと、どれを送ればよいか分からない** */
  labels: string[];
}

/**
 * 印を読む。
 *
 * **形を確かめてから返す。** 古い版が書いた形や、手で書き換えられたものが
 * 入っていることがある。読めなければ「印は無い」と同じに扱う——
 * 知らせが1回出ないだけで、原稿には何も起きない。
 */
export function readUnsentMark(
  storage: UnsentMarkStorage
): UnsentMark | undefined {
  const raw = storage.get<unknown>(UNSENT_MARK_KEY);
  if (typeof raw !== "object" || raw === null) return undefined;
  const candidate = raw as Partial<UnsentMark>;
  if (typeof candidate.at !== "string" || candidate.at.trim() === "") {
    return undefined;
  }
  const ahead = typeof candidate.ahead === "number" ? candidate.ahead : 0;
  const dirty = typeof candidate.dirty === "number" ? candidate.dirty : 0;
  // **数が両方0の印は、印として働かない**（何も送り残していない）
  if (ahead <= 0 && dirty <= 0) return undefined;
  const labels = Array.isArray(candidate.labels)
    ? candidate.labels.filter((one): one is string => typeof one === "string")
    : [];
  return { at: candidate.at, ahead, dirty, labels };
}

/** 印を付ける。**送っていないものがあると分かった時点で呼ぶ** */
export async function writeUnsentMark(
  storage: UnsentMarkStorage,
  mark: UnsentMark
): Promise<void> {
  await storage.update(UNSENT_MARK_KEY, mark);
}

/** 印を消す。**送信が通ったときだけ呼ぶ** */
export async function clearUnsentMark(
  storage: UnsentMarkStorage
): Promise<void> {
  await storage.update(UNSENT_MARK_KEY, undefined);
}

/**
 * いま送り残しているものを数える（設計書6.15.1）。
 *
 * ## 置き場ごとに1回だけ数える
 *
 * **`ahead` と `dirty` は置き場ぜんぶの数**である（設計書5.5.1）。書庫では
 * 1つのリポジトリに11作品が入るので、作品ごとに足すと**11倍になる**。
 * 置き場（`root`）で畳んでから足す。
 *
 * 送り残しが無ければ `undefined`（＝印を付けない）。
 */
export function summarizeUnsent(
  entries: readonly { label: string; status: GitSyncStatus }[],
  now: Date
): UnsentMark | undefined {
  const byRoot = new Map<string, { label: string; ahead: number; dirty: number }>();
  for (const entry of entries) {
    const status = entry.status;
    // 置き場が分からない状態（gitが無い・リポジトリでない）は数えようがない
    if (!("root" in status)) continue;
    // **まだ一度も送っていない置き場も「送り残し」である。** 送信待ちの数は
    // 出せない（比べる相手が無い）ので、記録待ちだけを数える
    const ahead = status.kind === "tracked" ? status.ahead : 0;
    const dirty = "dirty" in status ? status.dirty : 0;
    if (ahead === 0 && dirty === 0) continue;
    if (byRoot.has(status.root)) continue;
    byRoot.set(status.root, { label: entry.label, ahead, dirty });
  }

  if (byRoot.size === 0) return undefined;
  const rows = [...byRoot.values()];
  return {
    at: now.toISOString(),
    ahead: rows.reduce((sum, one) => sum + one.ahead, 0),
    dirty: rows.reduce((sum, one) => sum + one.dirty, 0),
    labels: rows.map((one) => one.label),
  };
}

/**
 * 印を1文にする。
 *
 * **前回であることを先に言う。** 「未送信があります」だけだと、
 * いま起きたことなのか前回の続きなのかが読み取れない。
 */
export function describeUnsentMark(mark: UnsentMark): string {
  const parts: string[] = [];
  if (mark.ahead > 0) parts.push(`送信待ち ${mark.ahead}件`);
  if (mark.dirty > 0) parts.push(`記録待ち ${mark.dirty}件`);
  const where =
    mark.labels.length > 0 ? `（${mark.labels.join("、")}）` : "";
  return `前回、送らずに閉じました${where}：${parts.join("・")}。`;
}
