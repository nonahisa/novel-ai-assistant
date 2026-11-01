import { describe, expect, test } from "vitest";
import {
  collapseNarouFunSameDay,
  emptyPostingLedger,
  readerStatsForSite,
  repeatsReaderStats,
  withReaderStats,
  type PostingLedger,
  type ReaderStatsRecord,
} from "../../../src/models/posting";

/**
 * なろうファンDB（Narou.fun）の同じ日の読み取りは、あとの方だけを見る（作者の判断 2026-11-01）。
 *
 * - 台帳は**書き換えない**（作者のファイルから消さない）。**読むときに畳む**
 * - 日の区切りは**手元の暦日（0:00）**。Narou.fun の記録の日時は「データ取得の日の 0:00」
 *   なので、執筆量の区切り（既定4時）で切ると前の日へ落ちる
 * - なろうのヘルパーの記録（＝Narou.fun の封筒）だけ。カクヨムの同じ日の2回は今までどおり2回
 */

/** 手元の時計での日時（試験を走らせる機械の時差に頼らない） */
function at(day: number, hour: number, minute = 0): string {
  return new Date(2026, 10, day, hour, minute).toISOString();
}

function record(overrides: Partial<ReaderStatsRecord>): ReaderStatsRecord {
  return {
    site: "narou",
    readAt: at(1, 0),
    scope: "work",
    metrics: { bookmarks: 10 },
    source: "helper",
    ...overrides,
  };
}

function ledgerOf(records: ReaderStatsRecord[]): PostingLedger {
  return { ...emptyPostingLedger(), readerStats: records };
}

describe("同じ日の Narou.fun の読み取りを畳む", () => {
  test("同じ日に2回読んだら、あとの方だけが残る", () => {
    const morning = record({ readAt: at(1, 0), metrics: { bookmarks: 10 } });
    const evening = record({ readAt: at(1, 21, 30), metrics: { bookmarks: 12 } });
    expect(collapseNarouFunSameDay([morning, evening])).toEqual([evening]);
    // 並びが逆（あとから古い画面を溜め直した）でも、日時の新しい方
    expect(collapseNarouFunSameDay([evening, morning])).toEqual([evening]);
  });

  test("データ取得の日の 0:00 と、その日の昼は同じ日（4時の区切りで前の日へ落とさない）", () => {
    const fetched = record({ readAt: at(2, 0), metrics: { bookmarks: 10 } });
    const pressed = record({ readAt: at(2, 3, 59), metrics: { bookmarks: 11 } });
    expect(collapseNarouFunSameDay([fetched, pressed])).toEqual([pressed]);
  });

  test("違う日は両方残る", () => {
    const first = record({ readAt: at(1, 0) });
    const second = record({ readAt: at(2, 0) });
    expect(collapseNarouFunSameDay([first, second])).toEqual([first, second]);
  });

  test("同じ日時なら、台帳であとにある方", () => {
    const first = record({ metrics: { bookmarks: 10 } });
    const second = record({ metrics: { bookmarks: 11 } });
    expect(collapseNarouFunSameDay([first, second])).toEqual([second]);
  });

  test("範囲・話・粒度・期間が違えば別のもの（1回の読み取りの中身を消さない）", () => {
    const work = record({ readAt: at(1, 0) });
    const day30 = record({ readAt: at(1, 0), period: "day", periodKey: "2026-10-30" });
    const day31 = record({ readAt: at(1, 0), period: "day", periodKey: "2026-10-31" });
    const laterWork = record({ readAt: at(1, 12) });
    expect(collapseNarouFunSameDay([work, day30, day31, laterWork])).toEqual([
      day30,
      day31,
      laterWork,
    ]);
  });

  test("カクヨム・手入力の記録は畳まない", () => {
    const kakuyomu = [
      record({ site: "kakuyomu", readAt: at(1, 9), metrics: { pv: 1 } }),
      record({ site: "kakuyomu", readAt: at(1, 21), metrics: { pv: 2 } }),
    ];
    expect(collapseNarouFunSameDay(kakuyomu)).toEqual(kakuyomu);
    const manual = [
      record({ source: "manual", readAt: at(1, 9) }),
      record({ source: "manual", readAt: at(1, 21) }),
    ];
    expect(collapseNarouFunSameDay(manual)).toEqual(manual);
  });

  test("日時の読めない記録は畳まない（捨てない）", () => {
    const odd = record({ readAt: "作者が手で書いた日時" });
    const normal = record({ readAt: at(1, 0) });
    expect(collapseNarouFunSameDay([odd, normal])).toEqual([odd, normal]);
  });

  test("台帳に重なって入っている古い記録も、読むときに畳む（台帳そのものは変えない）", () => {
    const ledger = ledgerOf([
      record({ readAt: at(1, 0), metrics: { bookmarks: 10 } }),
      record({ readAt: at(1, 20), metrics: { bookmarks: 12 } }),
    ]);
    expect(readerStatsForSite(ledger, "narou")).toHaveLength(1);
    expect(readerStatsForSite(ledger, "narou")[0].metrics).toEqual({ bookmarks: 12 });
    expect(ledger.readerStats).toHaveLength(2);
  });
});

describe("足すとき", () => {
  test("同じ日のいま見えている数と同じなら積まない", () => {
    const ledger = withReaderStats(
      emptyPostingLedger(),
      record({ readAt: at(1, 0), metrics: { bookmarks: 10 } })
    );
    expect(repeatsReaderStats(ledger, record({ readAt: at(1, 22), metrics: { bookmarks: 10 } }))).toBe(true);
  });

  test("同じ日でも数が違えば積む（読むときにあとの方が勝つ）", () => {
    const ledger = withReaderStats(
      emptyPostingLedger(),
      record({ readAt: at(1, 0), metrics: { bookmarks: 10 } })
    );
    expect(repeatsReaderStats(ledger, record({ readAt: at(1, 22), metrics: { bookmarks: 11 } }))).toBe(false);
  });

  test("違う日なら同じ数でも積む（その日に同じだった、という記録）", () => {
    const ledger = withReaderStats(
      emptyPostingLedger(),
      record({ readAt: at(1, 0), metrics: { bookmarks: 10 } })
    );
    expect(repeatsReaderStats(ledger, record({ readAt: at(2, 0), metrics: { bookmarks: 10 } }))).toBe(false);
  });

  test("カクヨムの同じ日・同じ数の「その時点」は、今までどおり積む", () => {
    const ledger = withReaderStats(
      emptyPostingLedger(),
      record({ site: "kakuyomu", readAt: at(1, 9), metrics: { pv: 5 } })
    );
    expect(
      repeatsReaderStats(ledger, record({ site: "kakuyomu", readAt: at(1, 21), metrics: { pv: 5 } }))
    ).toBe(false);
  });
});
