import { describe, expect, test } from "vitest";
import {
  RANK_CELEBRATION_WINDOW_DAYS,
  RANK_FIREWORKS_RISE,
  RANK_FIREWORKS_TOP,
  detectRankEvents,
  rankCelebrationScale,
  rankCelebrationSize,
  rankEventNotice,
} from "../../../src/core/rankCelebrations";
import { emptyPostingLedger, type PostingRankingRecord } from "../../../src/models/posting";

/** 順位のお祝い（作者の指示 2026-11-02「ランキングに入ったり順位が上がった場合、風船とか花火を」） */

const at = (day: string, rank: number, board = "日間", site: PostingRankingRecord["site"] = "kakuyomu"): PostingRankingRecord => ({
  site,
  recordedAt: `${day}T12:00:00+09:00`,
  board,
  rank,
});

const ledgerOf = (rankings: PostingRankingRecord[]) => ({ ...emptyPostingLedger(), rankings });

describe("何を祝うか", () => {
  test("初めてのランクイン", () => {
    const events = detectRankEvents(ledgerOf([at("2026-11-01", 120)]), "w1", "2026-11-02");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ board: "日間", rank: 120, previous: null, size: "small" });
    expect(rankEventNotice("苦手の流転", events[0])).toBe("「苦手の流転」がカクヨムの日間で120位に入りました！");
  });

  test("順位が上がった", () => {
    const events = detectRankEvents(ledgerOf([at("2026-10-31", 120), at("2026-11-01", 100)]), "w1", "2026-11-02");
    expect(events[0]).toMatchObject({ rank: 100, previous: 120 });
    expect(rankEventNotice("苦手の流転", events[0])).toBe("「苦手の流転」がカクヨムの日間で120位から100位に上がりました！");
  });

  test("下がった・同じときは何も出さない", () => {
    expect(detectRankEvents(ledgerOf([at("2026-10-31", 100), at("2026-11-01", 120)]), "w1", "2026-11-02")).toEqual([]);
    expect(detectRankEvents(ledgerOf([at("2026-10-31", 100), at("2026-11-01", 100)]), "w1", "2026-11-02")).toEqual([]);
  });

  test(`${RANK_CELEBRATION_WINDOW_DAYS}日より前の順位は祝わない（殿堂入りAPIの古い履歴を一度に取っても騒がない）`, () => {
    expect(detectRankEvents(ledgerOf([at("2026-10-01", 3)]), "w1", "2026-11-02")).toEqual([]);
  });

  test("種別ごとに見る。鍵は作品・サイト・種別・日付・順位で決まる（同じ記録は同じ鍵）", () => {
    const ledger = ledgerOf([at("2026-11-01", 50, "日間"), at("2026-11-01", 200, "週間")]);
    const first = detectRankEvents(ledger, "w1", "2026-11-02");
    const again = detectRankEvents(ledger, "w1", "2026-11-02");
    expect(first.map((event) => event.board)).toEqual(["日間", "週間"]);
    expect(again.map((event) => event.id)).toEqual(first.map((event) => event.id));
    expect(new Set(first.map((event) => event.id)).size).toBe(2);
    expect(detectRankEvents(ledger, "w2", "2026-11-02")[0].id).not.toBe(first[0].id);
  });
});

describe("規模の区切り", () => {
  test("1位は大きな花火", () => {
    expect(rankCelebrationSize(1, null)).toBe("grand");
    expect(rankCelebrationSize(1, 2)).toBe("grand");
  });
  test(`${RANK_FIREWORKS_TOP}位以内は花火`, () => {
    expect(rankCelebrationSize(RANK_FIREWORKS_TOP, null)).toBe("fireworks");
    expect(rankCelebrationSize(RANK_FIREWORKS_TOP + 1, null)).toBe("small");
  });
  test(`${RANK_FIREWORKS_RISE}位以上の上昇は花火、それより小さい上昇は風船`, () => {
    expect(rankCelebrationSize(150, 150 + RANK_FIREWORKS_RISE)).toBe("fireworks");
    expect(rankCelebrationSize(150, 150 + RANK_FIREWORKS_RISE - 1)).toBe("small");
  });
  test("重なったときはいちばん大きいものに揃える", () => {
    const events = detectRankEvents(
      ledgerOf([at("2026-11-01", 200, "日間"), at("2026-11-01", 1, "週間")]),
      "w1",
      "2026-11-02"
    );
    expect(rankCelebrationScale(events)?.size).toBe("grand");
    expect(rankCelebrationScale([])).toBeUndefined();
  });
});
