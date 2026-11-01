import type { PostingSiteId } from "../models/posting";
import {
  parseRanking,
  parseReaderStatsEnvelope,
  type ReaderStatsEnvelope,
  type ReaderStatsRanking,
} from "./readerStatsEnvelope";
import { ownWorkCandidates, ownWorkKey } from "./unregisteredOwnWorks";

/**
 * 「未登録の自分の作品」の読者の反応の控え（作者の判断 2026-11-01。設計書6.99.8）。
 *
 * 作者「全部自動で取り込めないものでしょうか？」→ 選んだ案「読者の反応も、自分の管理画面で
 * 読んだ作品は訊かずに取り込む」。どの作品の台帳の作品IDにも当たらない画面は、これまで
 * 「作品が見つかりません」で捨てていた。**本人しか開けない画面（`ownedVia: "owner-page"`）で
 * 読んだ分だけ**ここへ控え、その作品が登録されたら、登録した作品へ取り込む。
 *
 * ## 置き場は作品フォルダーの外
 *
 * 枠の覚えと同じく拡張機能の保管庫（`globalState`）に置く（作品がまだ無いので台帳が無い）。
 * 書くのは `features/unregisteredOwnWorks.ts` の1か所。
 *
 * ## 封筒は文字列で持ち、読むときに関所を通し直す
 *
 * 保管庫の値は版の違う拡張機能が書いたものが残りうる。**封筒の確かめ方を写さず**、
 * クリップボードから届いたときと同じ関所（`parseReaderStatsEnvelope`）を通し、
 * 通らなかった1件だけを捨てる（全体は捨てない）。
 *
 * ## 上限
 *
 * 封筒は話ごとの行を抱えるので大きい（500話の作品なら500行）。保管庫を太らせないよう、
 * **作品ごとに10画面・全体で40画面・届いてから90日**まで。超えたら古いものから捨てる
 * ——捨てた画面は、登録したあとでヘルパーの「もう一度渡す」で渡し直せば入る
 * （取り込み済みの数は二重に積まない）。
 *
 * VS Code API には依存しない。
 */

/** 控えの1件 */
export interface PendingOwnWorkStats {
  readonly site: PostingSiteId;
  readonly workId: string;
  /** 控えた日時（ISO8601。日数の上限はこれで数える） */
  readonly heldAt: string;
  /** 封筒そのもの（JSON の文字列） */
  readonly envelope: string;
}

/** 作品ごとに控える画面の数 */
export const MAX_PENDING_STATS_PER_WORK = 10;
/** 全体で控える画面の数 */
export const MAX_PENDING_STATS_TOTAL = 40;
/** 控えておく日数 */
export const PENDING_STATS_MAX_AGE_DAYS = 90;

const DAY_MS = 24 * 60 * 60 * 1000;

/** 読み戻した1件（関所を通った封筒つき） */
export interface PendingOwnWorkStatsEntry extends PendingOwnWorkStats {
  readonly parsed: ReaderStatsEnvelope;
}

/**
 * 保管庫の値を読む。**形の違う項目・関所を通らない封筒は捨てる**（全体は捨てない）。
 * 古すぎるものもここで落とす（書き直すのは次に控えるとき）
 */
export function readPendingOwnWorkStats(
  value: unknown,
  now: number
): PendingOwnWorkStatsEntry[] {
  if (!Array.isArray(value)) return [];
  const out: PendingOwnWorkStatsEntry[] = [];
  for (const raw of value) {
    if (typeof raw !== "object" || raw === null) continue;
    const entry = raw as Record<string, unknown>;
    if (typeof entry.envelope !== "string" || typeof entry.heldAt !== "string") continue;
    const heldAt = Date.parse(entry.heldAt);
    if (Number.isNaN(heldAt) || now - heldAt > PENDING_STATS_MAX_AGE_DAYS * DAY_MS) continue;
    const parsed = parseReaderStatsEnvelope(entry.envelope);
    if (!parsed.ok) continue;
    const workId = parsed.envelope.workId?.trim();
    // 控える条件（本人しか開けない画面・作品IDあり）を読み戻すときにも確かめる
    if (!workId || ownWorkCandidates([parsed.envelope]).length === 0) continue;
    out.push({
      site: parsed.envelope.site,
      workId,
      heldAt: entry.heldAt,
      envelope: entry.envelope,
      parsed: parsed.envelope,
    });
  }
  return out;
}

/** 同じ画面を二度控えない見分け（同じ束が呼び出しと貼り付けで2度届く） */
function sameScreen(a: ReaderStatsEnvelope, b: ReaderStatsEnvelope): boolean {
  return (
    ownWorkKey(a.site, a.workId ?? "") === ownWorkKey(b.site, b.workId ?? "") &&
    a.readAt === b.readAt &&
    a.source === b.source &&
    a.entries.length === b.entries.length
  );
}

/**
 * 作品の決まらなかった封筒を控えに足す。本人しか開けない画面で読んだものだけ。
 * @returns 書く値（保管庫へ置く形。`parsed` は持たない）と、変わったか
 */
export function holdOwnWorkStats(
  current: readonly PendingOwnWorkStatsEntry[],
  envelopes: readonly ReaderStatsEnvelope[],
  now: number
): { readonly next: PendingOwnWorkStats[]; readonly changed: boolean } {
  const list: PendingOwnWorkStatsEntry[] = [...current];
  let changed = false;
  const heldAt = new Date(now).toISOString();
  for (const envelope of ownWorkCandidates(envelopes)) {
    if (list.some((entry) => sameScreen(entry.parsed, envelope))) continue;
    list.push({
      site: envelope.site,
      workId: (envelope.workId ?? "").trim(),
      heldAt,
      envelope: JSON.stringify(envelope),
      parsed: envelope,
    });
    changed = true;
  }
  const trimmed = trimPending(list);
  return { next: trimmed.map(stored), changed: changed || trimmed.length !== list.length };
}

/** 上限を当てる。古いもの（封筒の読み取り日時が古い順）から捨てる */
function trimPending(list: readonly PendingOwnWorkStatsEntry[]): PendingOwnWorkStatsEntry[] {
  const newestFirst = [...list].sort((a, b) =>
    a.parsed.readAt < b.parsed.readAt ? 1 : a.parsed.readAt > b.parsed.readAt ? -1 : 0
  );
  const perWork = new Map<string, number>();
  const kept: PendingOwnWorkStatsEntry[] = [];
  for (const entry of newestFirst) {
    const key = ownWorkKey(entry.site, entry.workId);
    const count = perWork.get(key) ?? 0;
    if (count >= MAX_PENDING_STATS_PER_WORK) continue;
    if (kept.length >= MAX_PENDING_STATS_TOTAL) break;
    perWork.set(key, count + 1);
    kept.push(entry);
  }
  // 束の取り込みは溜めた順（古いものが先）に積むので、並びは古い順に戻す
  return kept.reverse();
}

function stored(entry: PendingOwnWorkStatsEntry): PendingOwnWorkStats {
  return { site: entry.site, workId: entry.workId, heldAt: entry.heldAt, envelope: entry.envelope };
}

/**
 * 登録済みになった作品の分を取り出す。
 * @param isRegistered その作品が登録済みか（サイトと作品IDで見る）
 */
export function takeRegisteredPending(
  list: readonly PendingOwnWorkStatsEntry[],
  isRegistered: (site: PostingSiteId, workId: string) => boolean
): { readonly taken: PendingOwnWorkStatsEntry[]; readonly rest: PendingOwnWorkStatsEntry[] } {
  const taken: PendingOwnWorkStatsEntry[] = [];
  const rest: PendingOwnWorkStatsEntry[] = [];
  for (const entry of list) {
    (isRegistered(entry.site, entry.workId) ? taken : rest).push(entry);
  }
  return { taken, rest };
}

/** 保管庫へ置く形に直す */
export function storedPending(list: readonly PendingOwnWorkStatsEntry[]): PendingOwnWorkStats[] {
  return list.map(stored);
}

// ---------------------------------------------------------------------------
// 順位の控え（2026-11-02。ヘルパー 0.19.0 の束の rankings）
// ---------------------------------------------------------------------------

/**
 * 控えた順位の1件。**順位には覚えた理由（`ownedVia`）が無い**ので、控えるかは呼ぶ側が
 * 決める（同じ束の本人しか開けない画面・枠の覚え）。読み戻すときは束と同じ関所
 * （`parseRanking`）を通し直す（版の違う拡張機能が書いた値が残りうる）。
 */
export interface PendingOwnWorkRanking {
  readonly site: PostingSiteId;
  readonly workId: string;
  readonly heldAt: string;
  /** 順位そのもの（JSON の文字列） */
  readonly ranking: string;
}

export interface PendingOwnWorkRankingEntry extends PendingOwnWorkRanking {
  readonly parsed: ReaderStatsRanking;
}

/**
 * 作品ごとに控える順位の数。1件は「1つの区分の1日の順位」で、カクヨムはジャンル×期間で
 * 1日に何件も届く。登録までの数日ぶんが入る数にした（1件は200字ほど）
 */
export const MAX_PENDING_RANKINGS_PER_WORK = 100;
/** 全体で控える順位の数 */
export const MAX_PENDING_RANKINGS_TOTAL = 300;

/** 同じ順位の見分け（ヘルパーとの取り決め：サイト＋作品ID＋区分＋日付） */
function rankingKey(ranking: ReaderStatsRanking): string {
  return [ownWorkKey(ranking.site, ranking.workId), ranking.board, ranking.date].join("\u0000");
}

/** 保管庫の値を読む。形の違う項目・関所を通らない順位・古すぎるものは捨てる */
export function readPendingOwnWorkRankings(
  value: unknown,
  now: number
): PendingOwnWorkRankingEntry[] {
  if (!Array.isArray(value)) return [];
  const out: PendingOwnWorkRankingEntry[] = [];
  for (const raw of value) {
    if (typeof raw !== "object" || raw === null) continue;
    const entry = raw as Record<string, unknown>;
    if (typeof entry.ranking !== "string" || typeof entry.heldAt !== "string") continue;
    const heldAt = Date.parse(entry.heldAt);
    if (Number.isNaN(heldAt) || now - heldAt > PENDING_STATS_MAX_AGE_DAYS * DAY_MS) continue;
    let json: unknown;
    try {
      json = JSON.parse(entry.ranking);
    } catch {
      continue;
    }
    const parsed = parseRanking(json);
    if (typeof parsed === "string") continue;
    out.push({
      site: parsed.site,
      workId: parsed.workId,
      heldAt: entry.heldAt,
      ranking: entry.ranking,
      parsed,
    });
  }
  return out;
}

/**
 * 順位を控えに足す。`isOwn` が「未登録の自分の作品」と言ったものだけ。同じ鍵は足さない。
 * @returns 書く値・変わったか・控えに入った順位（すでに控えてあったものも含む）
 */
export function holdOwnWorkRankings(
  current: readonly PendingOwnWorkRankingEntry[],
  rankings: readonly ReaderStatsRanking[],
  isOwn: (site: PostingSiteId, workId: string) => boolean,
  now: number
): {
  readonly next: PendingOwnWorkRanking[];
  readonly changed: boolean;
  readonly held: ReaderStatsRanking[];
} {
  const list: PendingOwnWorkRankingEntry[] = [...current];
  const keys = new Set(list.map((entry) => rankingKey(entry.parsed)));
  const held: ReaderStatsRanking[] = [];
  let changed = false;
  const heldAt = new Date(now).toISOString();
  for (const ranking of rankings) {
    // 出どころのある順位（Narou.fun）は他人の作品の頁も開けるので控えない（画面と同じ線）
    if (ranking.source !== undefined || !isOwn(ranking.site, ranking.workId)) continue;
    held.push(ranking);
    const key = rankingKey(ranking);
    if (keys.has(key)) continue;
    keys.add(key);
    list.push({
      site: ranking.site,
      workId: ranking.workId,
      heldAt,
      ranking: JSON.stringify(ranking),
      parsed: ranking,
    });
    changed = true;
  }
  const trimmed = trimPendingRankings(list);
  return {
    next: trimmed.map(storedRanking),
    changed: changed || trimmed.length !== list.length,
    held,
  };
}

/** 上限を当てる。読んだ日時の古いものから捨てる（並びは古い順に戻す） */
function trimPendingRankings(
  list: readonly PendingOwnWorkRankingEntry[]
): PendingOwnWorkRankingEntry[] {
  const newestFirst = [...list].sort((a, b) =>
    a.parsed.readAt < b.parsed.readAt ? 1 : a.parsed.readAt > b.parsed.readAt ? -1 : 0
  );
  const perWork = new Map<string, number>();
  const kept: PendingOwnWorkRankingEntry[] = [];
  for (const entry of newestFirst) {
    const key = ownWorkKey(entry.site, entry.workId);
    const count = perWork.get(key) ?? 0;
    if (count >= MAX_PENDING_RANKINGS_PER_WORK) continue;
    if (kept.length >= MAX_PENDING_RANKINGS_TOTAL) break;
    perWork.set(key, count + 1);
    kept.push(entry);
  }
  return kept.reverse();
}

function storedRanking(entry: PendingOwnWorkRankingEntry): PendingOwnWorkRanking {
  return { site: entry.site, workId: entry.workId, heldAt: entry.heldAt, ranking: entry.ranking };
}

/** 保管庫へ置く形に直す */
export function storedPendingRankings(
  list: readonly PendingOwnWorkRankingEntry[]
): PendingOwnWorkRanking[] {
  return list.map(storedRanking);
}
