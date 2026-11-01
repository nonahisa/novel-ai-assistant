import { POSTING_SITES, type PostingLedger, type PostingSiteId } from "../models/posting";
import { buildRankSeries } from "./rankSeries";

/**
 * 順位のお祝い（作者の指示 2026-11-02「ランキングに入ったり順位が上がった場合、風船とか
 * 花火（規模により変動）を上げてください」）。**判定だけ**で、通知も保管庫も触らない。
 *
 * ## 何を祝うか
 *
 * 種別（「日間」「累計ランキング」…）の線ごとに、**いちばん新しい点**を前の点と比べる：
 *   - その線で初めての順位 → 「ランキングに入りました」
 *   - 前の順位より小さい（上がった） → 「N 位から M 位に上がりました」
 *   - 同じ・下がった・圏外 → 何もしない
 *
 * 材料は順位のグラフと同じ線（`buildRankSeries`）。手の記録・ヘルパー・なろう殿堂入りAPIの
 * どれで入った順位でも同じに見る。**前の点は圏外を飛ばした、最後に順位のあった点**。
 *
 * ## 古い順位は祝わない
 *
 * 殿堂入りAPIは、初めて押したときに**何年ぶんの履歴**を一度に返す。いちばん新しい点でも、
 * 何か月も前の順位を今さら祝われても何のことか分からない。**`RANK_CELEBRATION_WINDOW_DAYS`
 * 日より前の順位は祝わない**（執筆の目標の祝いの7日と同じ）。
 *
 * ## 規模（区切りは下の定数。設計書にも書く）
 *
 * | 順位 | 規模 |
 * |---|---|
 * | 1位 | 大きな花火（`grand`） |
 * | `RANK_FIREWORKS_TOP` 位以内、または `RANK_FIREWORKS_RISE` 位以上の上昇 | 花火（`fireworks`） |
 * | それ以外の初めてのランクイン・上昇 | 風船が数個（`small`） |
 *
 * ## 一度きり
 *
 * 鍵は「作品・サイト・種別・日付・順位」。同じ記録で二度祝わない（覚えるのは呼ぶ側）。
 */

/** これより前の順位は祝わない（日） */
export const RANK_CELEBRATION_WINDOW_DAYS = 7;
/** この順位以内なら花火 */
export const RANK_FIREWORKS_TOP = 10;
/** この幅以上に上がったら花火 */
export const RANK_FIREWORKS_RISE = 50;
/** 規模ごとの風船の数（画面の側でも40個で止める） */
export const RANK_BALLOONS: Readonly<Record<RankCelebrationSize, number>> = {
  small: 4,
  fireworks: 8,
  grand: 20,
};

export type RankCelebrationSize = "small" | "fireworks" | "grand";

export interface RankEvent {
  /** 一度きりの鍵（`rank:` で始まる。執筆の目標の祝いの鍵と混ざらない） */
  id: string;
  site: PostingSiteId;
  siteLabel: string;
  board: string;
  day: string;
  rank: number;
  /** 前の順位。初めてのランクインなら null */
  previous: number | null;
  size: RankCelebrationSize;
}

export function rankCelebrationSize(rank: number, previous: number | null): RankCelebrationSize {
  if (rank === 1) return "grand";
  if (rank <= RANK_FIREWORKS_TOP) return "fireworks";
  if (previous !== null && previous - rank >= RANK_FIREWORKS_RISE) return "fireworks";
  return "small";
}

export function rankEventId(workId: string, event: Pick<RankEvent, "site" | "board" | "day" | "rank">): string {
  // 区切りにNULを使うのは、種別の名前（作者が打つ）に現れない字だからである
  return ["rank", workId, event.site, event.board, event.day, String(event.rank)].join("\u0000");
}

function dayNumber(day: string): number {
  return Math.round(Date.parse(`${day}T00:00:00Z`) / 86_400_000);
}

/**
 * 祝う順位を探す（サイトの並びは `POSTING_SITES`）。
 *
 * @param today 手元の今日（YYYY-MM-DD）
 */
export function detectRankEvents(
  ledger: PostingLedger,
  workId: string,
  today: string
): RankEvent[] {
  const events: RankEvent[] = [];
  for (const info of POSTING_SITES) {
    for (const line of buildRankSeries(ledger, info.id)) {
      const last = line.points[line.points.length - 1];
      if (!last || last.rank === null) continue;
      const age = dayNumber(today) - dayNumber(last.day);
      if (age > RANK_CELEBRATION_WINDOW_DAYS) continue;
      const earlier = line.points
        .slice(0, -1)
        .filter((point): point is { day: string; rank: number } => point.rank !== null);
      const previous = earlier.length > 0 ? earlier[earlier.length - 1].rank : null;
      if (previous !== null && previous <= last.rank) continue;
      const base = { site: info.id, board: line.label, day: last.day, rank: last.rank };
      events.push({
        ...base,
        id: rankEventId(workId, base),
        siteLabel: info.label,
        previous,
        size: rankCelebrationSize(last.rank, previous),
      });
    }
  }
  return events;
}

/** VS Code の知らせ（作者の指示の言い方のまま） */
export function rankEventNotice(workTitle: string, event: RankEvent): string {
  const where = `${event.siteLabel}の${event.board}`;
  return event.previous === null
    ? `「${workTitle}」が${where}で${event.rank}位に入りました！`
    : `「${workTitle}」が${where}で${event.previous}位から${event.rank}位に上がりました！`;
}

/** 執筆統計のお祝いの札に出す1行 */
export function rankEventLine(event: RankEvent): string {
  const where = `${event.siteLabel}の${event.board}`;
  return event.previous === null
    ? `${where}で${event.rank}位に入りました`
    : `${where}で${event.previous}位から${event.rank}位に上がりました`;
}

/** 重なったお祝いの規模（いちばん大きいもの）と風船の数 */
export function rankCelebrationScale(
  events: readonly RankEvent[]
): { size: RankCelebrationSize; balloons: number } | undefined {
  if (events.length === 0) return undefined;
  const order: RankCelebrationSize[] = ["small", "fireworks", "grand"];
  const size = events
    .map((event) => event.size)
    .reduce((best, size) => (order.indexOf(size) > order.indexOf(best) ? size : best), "small");
  return { size, balloons: RANK_BALLOONS[size] };
}
