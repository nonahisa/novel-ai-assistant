import { describe, expect, test } from "vitest";
import {
  buildRankChart,
  buildRankSeries,
  pickRankChartSeries,
  RANK_CHART_MAX_SERIES,
} from "../../../src/core/rankSeries";
import { detectRankEvents, rankEventNotice } from "../../../src/core/rankCelebrations";
import {
  emptyPostingLedger,
  type PostingLedger,
  type PostingRankingRecord,
} from "../../../src/models/posting";

/**
 * ヘルパーがランキングの画面で読んだ順位（`source: "helper"`。2026-11-02）を、
 * 順位の推移のグラフの線と、順位のお祝いに出す。
 *
 * - 線は区分（`board`）ごとに1本。名前は画面の見出し（`boardLabel`）
 * - 線が多すぎるときは、グラフには直近に順位のある線だけを描く（お祝いは全部の線を見る）
 */

function helper(day: string, board: string, boardLabel: string, rank: number): PostingRankingRecord {
  return {
    site: "kakuyomu",
    recordedAt: `${day}T00:00:00+09:00`,
    board,
    rank,
    source: "helper",
    boardLabel,
    span: "weekly",
  };
}

const ledgerOf = (rankings: PostingRankingRecord[]): PostingLedger => ({
  ...emptyPostingLedger(),
  rankings,
});

describe("順位の推移の線", () => {
  test("区分ごとに1本、名前は見出し。手の記録の線とは分ける", () => {
    const series = buildRankSeries(
      ledgerOf([
        { site: "kakuyomu", recordedAt: "2026-10-30T12:00:00+09:00", board: "週間", rank: 50 },
        helper("2026-11-01", "k:weekly:fantasy", "異世界ファンタジー 週間", 20),
        helper("2026-11-02", "k:weekly:fantasy", "異世界ファンタジー 週間", 15),
        helper("2026-11-02", "k:daily:all", "総合 日間", 80),
      ]),
      "kakuyomu"
    );
    expect(series.map((line) => line.label)).toEqual(["週間", "異世界ファンタジー 週間", "総合 日間"]);
    expect(series[1].points).toEqual([
      { day: "2026-11-01", rank: 20 },
      { day: "2026-11-02", rank: 15 },
    ]);
  });

  test("見出しが同じでも区分が違えば別の線にし、凡例で見分けられるようにする", () => {
    const series = buildRankSeries(
      ledgerOf([
        helper("2026-11-02", "k:weekly:a", "週間ランキング", 3),
        helper("2026-11-02", "k:weekly:b", "週間ランキング", 9),
      ]),
      "kakuyomu"
    );
    expect(series).toHaveLength(2);
    expect(series.map((line) => line.label)).toEqual([
      "週間ランキング（k:weekly:a）",
      "週間ランキング（k:weekly:b）",
    ]);
  });

  test("線が上限を越えたら、直近に順位のある線だけを描き、残りの名前を返す", () => {
    const rankings: PostingRankingRecord[] = [];
    // 1本だけ古い線、上限ぶんは新しい線
    rankings.push(helper("2026-10-01", "k:old", "古い区分", 5));
    for (let index = 0; index < RANK_CHART_MAX_SERIES; index++) {
      rankings.push(helper("2026-11-02", `k:new${index}`, `新しい区分${index}`, 10 + index));
    }
    const chart = buildRankChart(ledgerOf(rankings), "kakuyomu");
    expect(chart?.series).toHaveLength(RANK_CHART_MAX_SERIES);
    expect(chart?.series.map((line) => line.label)).not.toContain("古い区分");
    expect(chart?.hiddenLabels).toEqual(["古い区分"]);
    // 描かない線の点は縦軸の端にも入れない
    expect(chart?.best).toBe(10);
  });

  test("同じ日に順位のある線どうしは、順位の良い方を残す。並びは元の順", () => {
    const lines = [
      { label: "A", key: "A", points: [{ day: "2026-11-02", rank: 50 }] },
      { label: "B", key: "B", points: [{ day: "2026-11-02", rank: 2 }] },
      { label: "C", key: "C", points: [{ day: "2026-11-02", rank: 7 }] },
    ];
    const picked = pickRankChartSeries(lines, 2);
    expect(picked.shown.map((line) => line.label)).toEqual(["B", "C"]);
    expect(picked.hidden.map((line) => line.label)).toEqual(["A"]);
  });

  test("上限以内なら全部を描き、隠す線は無い", () => {
    const chart = buildRankChart(ledgerOf([helper("2026-11-02", "k:a", "総合 日間", 4)]), "kakuyomu");
    expect(chart?.series).toHaveLength(1);
    expect(chart?.hiddenLabels).toEqual([]);
  });
});

describe("ヘルパーの順位のお祝い（区分ごとに前回と比べる）", () => {
  test("初めてのランクイン", () => {
    const events = detectRankEvents(
      ledgerOf([helper("2026-11-02", "k:weekly:fantasy", "異世界ファンタジー 週間", 40)]),
      "w1",
      "2026-11-02"
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ board: "異世界ファンタジー 週間", rank: 40, previous: null });
    expect(rankEventNotice("星の庭", events[0])).toBe(
      "「星の庭」がカクヨムの異世界ファンタジー 週間で40位に入りました！"
    );
  });

  test("区分ごとに比べる：上がった区分だけを祝い、別の区分の順位とは比べない", () => {
    const events = detectRankEvents(
      ledgerOf([
        helper("2026-11-01", "k:weekly:fantasy", "異世界ファンタジー 週間", 40),
        helper("2026-11-01", "k:daily:all", "総合 日間", 5),
        helper("2026-11-02", "k:weekly:fantasy", "異世界ファンタジー 週間", 30),
        helper("2026-11-02", "k:daily:all", "総合 日間", 8),
      ]),
      "w1",
      "2026-11-02"
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ board: "異世界ファンタジー 週間", rank: 30, previous: 40 });
  });

  test("グラフに描かない線の順位も祝う（お祝いは全部の線を見る）", () => {
    const rankings: PostingRankingRecord[] = [];
    for (let index = 0; index < RANK_CHART_MAX_SERIES; index++) {
      rankings.push(helper("2026-11-02", `k:new${index}`, `新しい区分${index}`, 1 + index));
    }
    rankings.push(helper("2026-11-01", "k:extra", "七つめの区分", 90));
    const events = detectRankEvents(ledgerOf(rankings), "w1", "2026-11-02");
    expect(events.map((event) => event.board)).toContain("七つめの区分");
  });

  test("見出しが変わっても、同じ区分・同じ日・同じ順位は同じ鍵（二度祝わない）", () => {
    const before = detectRankEvents(
      ledgerOf([helper("2026-11-02", "k:weekly:fantasy", "異世界ファンタジー 週間", 40)]),
      "w1",
      "2026-11-02"
    );
    const after = detectRankEvents(
      ledgerOf([helper("2026-11-02", "k:weekly:fantasy", "異世界ファンタジー週間ランキング", 40)]),
      "w1",
      "2026-11-02"
    );
    expect(after[0].id).toBe(before[0].id);
  });
});
