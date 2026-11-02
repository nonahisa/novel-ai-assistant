import { describe, expect, test } from "vitest";
import {
  RANK_CELEBRATION_WINDOW_DAYS,
  RANK_FIREWORKS_RISE,
  RANK_FIREWORKS_TOP,
  RANK_STREAK_SIZE,
  detectRankEvents,
  rankCelebrationScale,
  rankCelebrationSize,
  rankEventLine,
  rankEventNotice,
  rankStreakUnit,
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

  test("自己最高を抜いた", () => {
    const events = detectRankEvents(ledgerOf([at("2026-10-31", 120), at("2026-11-01", 100)]), "w1", "2026-11-02");
    expect(events[0]).toMatchObject({ kind: "best", rank: 100, previous: 120 });
    expect(rankEventNotice("苦手の流転", events[0])).toBe("「苦手の流転」がカクヨムの日間で自己最高の120位を抜いて100位になりました！");
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

describe("自己最高を抜いたときだけ祝う（作者の裁定 2026-11-02 夜）", () => {
  test("下がったあとに戻しただけ（自己最高に届かない上昇）は祝わない", () => {
    const ledger = ledgerOf([at("2026-10-30", 5), at("2026-10-31", 40), at("2026-11-01", 20)]);
    expect(detectRankEvents(ledger, "w1", "2026-11-02")).toEqual([]);
  });

  test("自己最高と同じ順位に戻しただけでも祝わない", () => {
    const ledger = ledgerOf([at("2026-10-30", 5), at("2026-10-31", 40), at("2026-11-01", 5)]);
    expect(detectRankEvents(ledger, "w1", "2026-11-02")).toEqual([]);
  });

  test("自己最高を抜いたら、抜いた自己最高の順位を添えて祝う（直前の点ではない）", () => {
    const ledger = ledgerOf([at("2026-10-30", 30), at("2026-10-31", 80), at("2026-11-01", 12)]);
    const events = detectRankEvents(ledger, "w1", "2026-11-02");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "best", rank: 12, previous: 30 });
    expect(rankEventNotice("苦手の流転", events[0])).toBe(
      "「苦手の流転」がカクヨムの日間で自己最高の30位を抜いて12位になりました！"
    );
    expect(rankEventLine(events[0])).toBe("カクヨムの日間で自己最高の30位を抜いて12位になりました");
  });

  test("規模の上昇幅は自己最高から測る", () => {
    const ledger = ledgerOf([at("2026-10-30", 100), at("2026-10-31", 300), at("2026-11-01", 60)]);
    expect(detectRankEvents(ledger, "w1", "2026-11-02")[0]).toMatchObject({ previous: 100, size: "small" });
  });

  test("初めての1位は大きな花火", () => {
    const ledger = ledgerOf([at("2026-10-31", 3), at("2026-11-01", 1)]);
    expect(detectRankEvents(ledger, "w1", "2026-11-02")[0]).toMatchObject({ kind: "best", rank: 1, previous: 3, size: "grand" });
  });
});

describe("1位が続いた長さで毎回祝う（作者の裁定 2026-11-02 夜）", () => {
  test("日間の1位が続くと「1位がN日続きました！」", () => {
    const ledger = ledgerOf([at("2026-10-30", 4), at("2026-10-31", 1), at("2026-11-01", 1), at("2026-11-02", 1)]);
    const events = detectRankEvents(ledger, "w1", "2026-11-02");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "streak", rank: 1, streak: { count: 3, unit: "日" }, size: RANK_STREAK_SIZE });
    expect(rankEventNotice("苦手の流転", events[0])).toBe("「苦手の流転」がカクヨムの日間で1位が3日続きました！");
    expect(rankEventLine(events[0])).toBe("カクヨムの日間で1位が3日続きました");
  });

  test("連続の日ごとに鍵が違う（毎回祝う）", () => {
    const two = detectRankEvents(ledgerOf([at("2026-10-31", 1), at("2026-11-01", 1)]), "w1", "2026-11-02");
    const three = detectRankEvents(
      ledgerOf([at("2026-10-31", 1), at("2026-11-01", 1), at("2026-11-02", 1)]),
      "w1",
      "2026-11-02"
    );
    expect(two[0].streak?.count).toBe(2);
    expect(three[0].streak?.count).toBe(3);
    expect(three[0].id).not.toBe(two[0].id);
  });

  test("週間・累計などは「回」で数える", () => {
    const events = detectRankEvents(
      ledgerOf([at("2026-10-26", 1, "週間"), at("2026-11-02", 1, "週間")]),
      "w1",
      "2026-11-02"
    );
    expect(events[0]).toMatchObject({ kind: "streak", streak: { count: 2, unit: "回" } });
    expect(rankEventNotice("苦手の流転", events[0])).toBe("「苦手の流転」がカクヨムの週間で1位が2回続きました！");
  });

  test("間に2位以下があれば連続は切れる（戻った1位は自己最高に届かないので祝わず、次の1位から数え直す）", () => {
    const back = ledgerOf([at("2026-10-30", 1), at("2026-10-31", 2), at("2026-11-01", 1)]);
    expect(detectRankEvents(back, "w1", "2026-11-02")).toEqual([]);
    const again = ledgerOf([at("2026-10-29", 1), at("2026-10-30", 2), at("2026-10-31", 1), at("2026-11-01", 1)]);
    expect(detectRankEvents(again, "w1", "2026-11-02")[0]).toMatchObject({ kind: "streak", streak: { count: 2, unit: "日" } });
  });

  test("種別から日ごとかを決める（決められなければ「回」）", () => {
    expect(rankStreakUnit("日間")).toBe("日");
    expect(rankStreakUnit("総合 日間")).toBe("日");
    expect(rankStreakUnit("24時間ランキング")).toBe("日");
    expect(rankStreakUnit("週間")).toBe("回");
    expect(rankStreakUnit("月間")).toBe("回");
    expect(rankStreakUnit("累計ランキング")).toBe("回");
    expect(rankStreakUnit("作者が付けた名前")).toBe("回");
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
