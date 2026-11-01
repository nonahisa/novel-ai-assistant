import * as vscode from "vscode";
import type { WorkEntry } from "../models/types";
import type { PostingLedger } from "../models/posting";
import {
  detectRankEvents,
  rankCelebrationScale,
  rankEventLine,
  rankEventNotice,
  type RankEvent,
} from "../core/rankCelebrations";
import { logFailure, useLogFile } from "../core/logger";

/**
 * 順位のお祝いの係（作者の指示 2026-11-02）。判定は `core/rankCelebrations.ts`。
 *
 * | 何を | どこに | なぜ |
 * |---|---|---|
 * | 知らせを出した順位 | globalState（この端末） | VS Code の知らせを二度出さない |
 * | 執筆統計で風船を見せた順位 | globalState（この端末） | 閉じていたら次に開いたとき1回だけ見せる |
 *
 * 知らせは台帳を保存し終えたとき（`PostingStore` の `onPostingSaved`）に出す——手の記録・
 * ヘルパーの取り込み・なろう殿堂入りAPIのどの道で入った順位でも、ここ1か所を通る。
 * 執筆の目標の祝いと同じ設定（`novelai.celebrations.enabled`）で止められる。
 */

export const RANK_CELEBRATION_KEY = "novelai.rankCelebrations";
/** 覚える鍵の上限（古いほうから落とす。落ちた鍵の順位は、祝う期間をとうに過ぎている） */
const LIMIT = 400;

export interface RankCelebrationMemento {
  get<T>(key: string, fallback: T): T;
  update(key: string, value: unknown): Thenable<void> | Promise<void>;
}

interface Remembered {
  notified: string[];
  shown: string[];
}

function remembered(memento: RankCelebrationMemento): Remembered {
  const raw = memento.get<unknown>(RANK_CELEBRATION_KEY, {});
  const list = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
  const record = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  return { notified: list(record.notified), shown: list(record.shown) };
}

function appendIds(list: readonly string[], ids: readonly string[]): string[] {
  const seen = new Set(list);
  const next = [...list];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    next.push(id);
  }
  return next.length > LIMIT ? next.slice(-LIMIT) : next;
}

/** 手元の今日（YYYY-MM-DD。順位の日付と同じ形） */
function todayOf(now: Date): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function celebrationsEnabled(): boolean {
  return vscode.workspace.getConfiguration("novelai").get<boolean>("celebrations.enabled", true);
}

/**
 * 保存し終えた台帳を見て、まだ知らせていない順位を知らせる。
 *
 * **知らせを待たない**（ボタンの無い知らせで、答えを待つものは無い）。
 *
 * @returns 新しく知らせた順位（試験と、画面を出し直すかの判断に使う）
 */
export async function notifyRankEvents(
  memento: RankCelebrationMemento,
  work: WorkEntry,
  ledger: PostingLedger,
  options: { now?: Date; enabled?: boolean; show?: (message: string) => void } = {}
): Promise<RankEvent[]> {
  if (!(options.enabled ?? celebrationsEnabled())) return [];
  const events = detectRankEvents(ledger, work.id, todayOf(options.now ?? new Date()));
  const known = remembered(memento);
  const fresh = events.filter((event) => !known.notified.includes(event.id));
  if (fresh.length === 0) return [];
  // **先に覚えてから知らせる。** 覚えられなかったら知らせない（次の保存で二度出さないため）
  await memento.update(RANK_CELEBRATION_KEY, {
    ...known,
    notified: appendIds(known.notified, fresh.map((event) => event.id)),
  });
  const show = options.show ?? ((message: string) => void vscode.window.showInformationMessage(message));
  for (const event of fresh) show(rankEventNotice(work.title, event));
  return fresh;
}

/** 執筆統計へ送るお祝い（執筆の目標の祝いと同じ形。画面は同じ描き方で描く） */
export interface RankCelebrationPayload {
  size: "small" | "fireworks" | "grand";
  balloons: number;
  lines: string[];
  ids: string[];
}

/** 執筆統計でまだ見せていない順位のお祝い。無ければ undefined */
export function pendingRankCelebration(
  memento: RankCelebrationMemento,
  work: WorkEntry,
  ledger: PostingLedger,
  options: { now?: Date; enabled?: boolean } = {}
): RankCelebrationPayload | undefined {
  if (!(options.enabled ?? celebrationsEnabled())) return undefined;
  const known = remembered(memento);
  const pending = detectRankEvents(ledger, work.id, todayOf(options.now ?? new Date())).filter(
    (event) => !known.shown.includes(event.id)
  );
  const scale = rankCelebrationScale(pending);
  if (!scale) return undefined;
  return {
    size: scale.size,
    balloons: scale.balloons,
    lines: pending.map((event) => rankEventLine(event)),
    ids: pending.map((event) => event.id),
  };
}

/** 順位のお祝いの鍵か（画面から返ってきた鍵を振り分ける） */
export function isRankCelebrationId(id: string): boolean {
  return id.startsWith("rank\u0000");
}

/** 見せ終えた順位に印を付ける（二度は上げない） */
export async function markRankCelebrationsShown(
  memento: RankCelebrationMemento,
  ids: readonly string[]
): Promise<void> {
  const rankIds = ids.filter(isRankCelebrationId);
  if (rankIds.length === 0) return;
  const known = remembered(memento);
  await memento.update(RANK_CELEBRATION_KEY, { ...known, shown: appendIds(known.shown, rankIds) });
}

/** 失敗はログにだけ残す（祝えないだけで、記録は無事） */
export function logRankCelebrationFailure(work: WorkEntry, error: unknown): void {
  // **記録の直前に書き先を向ける**（ほかの機能と同じ。作品のログファイルへ）
  useLogFile(work.folderPath);
  logFailure("順位のお祝い", {
    作品: work.title,
    詳細: error instanceof Error ? error.message : String(error),
  });
}
