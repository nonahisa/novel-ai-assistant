import { describe, expect, test } from "vitest";
import {
  holdOwnWorkRankings,
  MAX_PENDING_RANKINGS_PER_WORK,
  PENDING_STATS_MAX_AGE_DAYS,
  readPendingOwnWorkRankings,
} from "../../../src/core/ownWorkPendingStats";
import type { ReaderStatsRanking } from "../../../src/core/readerStatsEnvelope";

/** 未登録の自分の作品の順位の控え（2026-11-02）。保管庫の値は読むときに関所を通し直す */

const NOW = Date.parse("2026-11-02T10:00:00.000Z");

function ranking(over: Partial<ReaderStatsRanking> = {}): ReaderStatsRanking {
  return {
    site: "kakuyomu",
    workId: "1111",
    board: "rankings/all/daily/long",
    boardLabel: "日間総合の長編ランキング",
    span: "daily",
    rank: 5,
    date: "2026-11-02",
    readAt: "2026-11-02T03:00:00.000Z",
    ...over,
  };
}

const own = (): boolean => true;

describe("順位の控え", () => {
  test("控えて、読み戻せる（同じ鍵は1つ）", () => {
    const held = holdOwnWorkRankings([], [ranking(), ranking({ rank: 3 })], own, NOW);
    expect(held.changed).toBe(true);
    expect(held.next).toHaveLength(1);
    const back = readPendingOwnWorkRankings(held.next, NOW);
    expect(back.map((entry) => entry.parsed.rank)).toEqual([5]);
  });

  test("自分の作品と言われなかったもの・出どころのあるものは控えない", () => {
    const held = holdOwnWorkRankings(
      [],
      [ranking({ workId: "2" }), ranking({ site: "narou", source: "narou.fun", workId: "n1" })],
      (_site, workId) => workId !== "2",
      NOW
    );
    expect(held.held).toEqual([]);
    expect(held.changed).toBe(false);
  });

  test("形の崩れた項目・関所を通らない順位・古すぎるものは読み戻さない（全体は捨てない）", () => {
    const good = holdOwnWorkRankings([], [ranking()], own, NOW).next[0];
    const old = { ...good, heldAt: new Date(NOW - (PENDING_STATS_MAX_AGE_DAYS + 1) * 86_400_000).toISOString() };
    const back = readPendingOwnWorkRankings(
      [good, old, { ranking: "{壊れた", heldAt: good.heldAt }, { ranking: JSON.stringify({ ...ranking(), rank: 0 }), heldAt: good.heldAt }, 3],
      NOW
    );
    expect(back).toHaveLength(1);
  });

  test("作品ごとの上限を越えたら、読んだ日時の古いものから捨てる", () => {
    const many = Array.from({ length: MAX_PENDING_RANKINGS_PER_WORK + 2 }, (_, index) =>
      ranking({ board: `b${index}`, readAt: new Date(NOW - (200 - index) * 60_000).toISOString() })
    );
    const held = holdOwnWorkRankings([], many, own, NOW);
    expect(held.next).toHaveLength(MAX_PENDING_RANKINGS_PER_WORK);
    const boards = readPendingOwnWorkRankings(held.next, NOW).map((entry) => entry.parsed.board);
    expect(boards).not.toContain("b0");
    expect(boards).not.toContain("b1");
  });
});
