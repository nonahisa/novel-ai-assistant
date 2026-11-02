import { POSTING_SITES, type PostingLedger, type PostingSiteId } from "../models/posting";
import { buildRankSeries, type RankPoint } from "./rankSeries";

/**
 * 順位のお祝い（作者の指示 2026-11-02「ランキングに入ったり順位が上がった場合、風船とか
 * 花火（規模により変動）を上げてください」）。**判定だけ**で、通知も保管庫も触らない。
 *
 * ## 何を祝うか（作者の裁定 2026-11-02 夜）
 *
 * 種別（「日間」「累計ランキング」…）の線ごとに、**いちばん新しい点**だけを見る：
 *   - その線で初めての順位 → 「ランキングに入りました」（`entered`）
 *   - それまでの**自己最高（いちばん小さい順位）を抜いた** → 「自己最高の N 位を抜いて M 位に
 *     なりました」（`best`）。下がったあとに戻しただけ（自己最高に届かない・並んだだけ）は祝わない
 *   - 1位が続いている（直前の順位のあった点も1位） → 「1位が N 日（回）続きました」（`streak`）
 *   - それ以外 → 何もしない
 *
 * 材料は順位のグラフと同じ線（`buildRankSeries`）。手の記録・ヘルパー・なろう殿堂入りAPIの
 * どれで入った順位でも同じに見る。
 *
 * ## 古い順位は祝わない
 *
 * 殿堂入りAPIは、初めて押したときに**何年ぶんの履歴**を一度に返す。いちばん新しい点でも、
 * 何か月も前の順位を今さら祝われても何のことか分からない。**`RANK_CELEBRATION_WINDOW_DAYS`
 * 日より前の順位は祝わない**（執筆の目標の祝いの7日と同じ）。
 *
 * ## 規模（区切りは下の定数。設計書にも書く）
 *
 * | 場合 | 規模 |
 * |---|---|
 * | 初めて1位になった（初めてのランクインが1位のときも） | 大きな花火（`grand`） |
 * | 1位が続いた | `RANK_STREAK_SIZE`（風船が数個） |
 * | `RANK_FIREWORKS_TOP` 位以内、または自己最高から `RANK_FIREWORKS_RISE` 位以上の上昇 | 花火（`fireworks`） |
 * | それ以外の初めてのランクイン・自己最高 | 風船が数個（`small`） |
 *
 * ## 一度きり
 *
 * 鍵は「作品・サイト・種別・日付・順位」。同じ記録で二度祝わない（覚えるのは呼ぶ側）。
 * 1位の連続は日付が進むので、続いた日ごとに別の鍵になる（毎回祝う）。
 */

/** これより前の順位は祝わない（日） */
export const RANK_CELEBRATION_WINDOW_DAYS = 7;
/** この順位以内なら花火 */
export const RANK_FIREWORKS_TOP = 10;
/** 自己最高からこの幅以上に上がったら花火 */
export const RANK_FIREWORKS_RISE = 50;
/**
 * 1位が続いたときの規模。**風船だけ**にする：1位が続く間は日間なら毎日祝うので、毎回大きな
 * 花火では、初めて1位になった日の大きな花火の重みが薄れ、毎日の画面がうるさくなる
 */
export const RANK_STREAK_SIZE: RankCelebrationSize = "small";
/** 規模ごとの風船の数（画面の側でも40個で止める） */
export const RANK_BALLOONS: Readonly<Record<RankCelebrationSize, number>> = {
  small: 4,
  fireworks: 8,
  grand: 20,
};

export type RankCelebrationSize = "small" | "fireworks" | "grand";

/** 1位の連続の数え方。日ごとの種別は「日」、それ以外と決められないものは「回」 */
export type RankStreakUnit = "日" | "回";

export interface RankEvent {
  /** 一度きりの鍵（`rank:` で始まる。執筆の目標の祝いの鍵と混ざらない） */
  id: string;
  /** 初めてのランクイン・自己最高の更新・1位の連続 */
  kind: "entered" | "best" | "streak";
  site: PostingSiteId;
  siteLabel: string;
  board: string;
  day: string;
  rank: number;
  /** 抜いた自己最高の順位。初めてのランクインと1位の連続では null */
  previous: number | null;
  /** 1位の連続（`kind: "streak"` のときだけ） */
  streak?: { count: number; unit: RankStreakUnit };
  size: RankCelebrationSize;
}

export function rankCelebrationSize(rank: number, previous: number | null): RankCelebrationSize {
  if (rank === 1) return "grand";
  if (rank <= RANK_FIREWORKS_TOP) return "fireworks";
  if (previous !== null && previous - rank >= RANK_FIREWORKS_RISE) return "fireworks";
  return "small";
}

/**
 * 種別の名前から、1位の連続を「日」で数えるか「回」で数えるかを決める。
 * 日ごとに作られる板（日間・24時間・デイリー）だけが「日」。週間・月間・累計や、作者が手で
 * 付けた分からない名前は「回」——日ごとでない板を「日」と数えると、続いた長さを偽ることになる
 */
export function rankStreakUnit(board: string): RankStreakUnit {
  return /日間|24時間|デイリー/.test(board) ? "日" : "回";
}

export function rankEventId(workId: string, event: Pick<RankEvent, "site" | "board" | "day" | "rank">): string {
  // 区切りにNULを使うのは、種別の名前（作者が打つ）に現れない字だからである
  return ["rank", workId, event.site, event.board, event.day, String(event.rank)].join("\u0000");
}

function dayNumber(day: string): number {
  return Math.round(Date.parse(`${day}T00:00:00Z`) / 86_400_000);
}

/** 終わりから数えて、1位の点がいくつ続いているか（圏外・2位以下で切れる） */
function trailingFirstPlaces(points: readonly RankPoint[]): number {
  let count = 0;
  for (let index = points.length - 1; index >= 0 && points[index].rank === 1; index--) count++;
  return count;
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
        .flatMap((point) => (point.rank === null ? [] : [point.rank]));
      const best = earlier.length > 0 ? Math.min(...earlier) : null;
      const base = { site: info.id, board: line.label, day: last.day, rank: last.rank };
      const common = {
        ...base,
        // 鍵は線の見分け（`key`）で作る。見出しが変わっても同じ順位を二度祝わない
        // （手の記録・API の線は名前と同じなので、これまでの鍵は変わらない）
        id: rankEventId(workId, { ...base, board: line.key }),
        siteLabel: info.label,
      };
      if (best === null || last.rank < best) {
        events.push({
          ...common,
          kind: best === null ? "entered" : "best",
          previous: best,
          // 上昇の幅も自己最高から測る（知らせに出す数と揃える）
          size: rankCelebrationSize(last.rank, best),
        });
        continue;
      }
      // 1位の連続：直前の点（圏外も含めて）も1位のときだけ。間に圏外や2位以下があれば切れ、
      // 戻ってきた1位は自己最高に届かない戻りなので祝わず、次の1位から数え直す
      const count = last.rank === 1 ? trailingFirstPlaces(line.points) : 0;
      if (count >= 2) {
        events.push({
          ...common,
          kind: "streak",
          previous: null,
          streak: { count, unit: rankStreakUnit(line.label) },
          size: RANK_STREAK_SIZE,
        });
      }
    }
  }
  return events;
}

/**
 * お祝いの文の本体（「〈サイト〉の〈種別〉で」のあと）。
 *
 * 自己最高の更新は「直前の点から」ではなく「**抜いた自己最高**から」を書く：祝う理由が
 * 自己最高を抜いたことなので、その数を見せれば「なぜ今回は祝われて、下がって戻しただけの
 * ときは祝われないのか」が文だけで分かる。直前の点を書くと、戻しただけの上昇と見分けがつかない
 */
function rankEventBody(event: RankEvent): string {
  if (event.kind === "streak" && event.streak) {
    return `1位が${event.streak.count}${event.streak.unit}続きました`;
  }
  if (event.previous === null) return `${event.rank}位に入りました`;
  return `自己最高の${event.previous}位を抜いて${event.rank}位になりました`;
}

/** VS Code の知らせ */
export function rankEventNotice(workTitle: string, event: RankEvent): string {
  return `「${workTitle}」が${event.siteLabel}の${event.board}で${rankEventBody(event)}！`;
}

/** 執筆統計のお祝いの札に出す1行 */
export function rankEventLine(event: RankEvent): string {
  return `${event.siteLabel}の${event.board}で${rankEventBody(event)}`;
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
