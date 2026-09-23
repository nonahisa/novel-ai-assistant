import { describe, expect, test } from "vitest";
import { parseReaderStatsEnvelope } from "../../src/core/readerStatsEnvelope";
import {
  emptyPostingLedger,
  isReaderStatsUpdatedAt,
  parsePostingLedger,
  withReaderStats,
  type ReaderStatsRecord,
} from "../../src/models/posting";

/**
 * 話ごとの記録の「最終更新」（約束 v1b、2026-09-23）。
 *
 * 封筒の版数は 1 のまま、**省いてよい欄**として足した。確かめるのは3つ。
 *
 *   1. 付いていても、付いていなくても受ける
 *   2. 知らない欄は読み飛ばす（古い母艦に新しい封筒を渡しても落ちない作り
 *      ——この欄を足す前の版でも同じだったことは、HEAD の版で実際に確かめた）
 *   3. 台帳へ入れて読み直しても消えない。空の欄は持たせない
 */

const readAt = "2026-09-23T03:00:00.000Z";

function envelope(entries: unknown[], extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    "novelai-stats": 1,
    site: "kakuyomu",
    readAt,
    entries,
    ...extra,
  });
}

describe("封筒の最終更新", () => {
  test("付いていれば、そのまま受ける", () => {
    const result = parseReaderStatsEnvelope(
      envelope([
        {
          scope: "episode",
          episode: 219,
          metrics: { likes: 56, pv: 1398 },
          updatedAt: "2024-07-31T08:13:00+09:00",
        },
      ])
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.envelope.entries[0].updatedAt).toBe(
      "2024-07-31T08:13:00+09:00"
    );
  });

  test("付いていなくても受け、欄を作らない", () => {
    const result = parseReaderStatsEnvelope(
      envelope([{ scope: "episode", episode: 1, metrics: { pv: 23299 } }])
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect("updatedAt" in result.envelope.entries[0]).toBe(false);
  });

  test("null と空文字は「欄なし」として受ける", () => {
    for (const updatedAt of [null, "", "  "]) {
      const result = parseReaderStatsEnvelope(
        envelope([
          { scope: "episode", episode: 1, metrics: { pv: 1 }, updatedAt },
        ])
      );
      expect(result.ok, JSON.stringify(updatedAt)).toBe(true);
      if (!result.ok) continue;
      expect("updatedAt" in result.envelope.entries[0]).toBe(false);
    }
  });

  test("知らない欄は、行にあっても封筒にあっても読み飛ばす", () => {
    const result = parseReaderStatsEnvelope(
      envelope(
        [
          {
            scope: "episode",
            episode: 3,
            metrics: { pv: 10 },
            somethingNew: { nested: true },
          },
        ],
        { anotherNewField: "x" }
      )
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.envelope.entries[0]).toEqual({
      scope: "episode",
      episode: 3,
      metrics: { pv: 10 },
    });
    expect("anotherNewField" in result.envelope).toBe(false);
  });

  test("日時として読めなければ、封筒ごと断る（直さない）", () => {
    for (const updatedAt of [
      "2024年7月31日 08:13",
      // 時差が無いと、手元の時計しだいで3日の境目がずれる
      "2024-07-31T08:13:00",
      "2024-13-45T99:99:00+09:00",
      12345,
    ]) {
      const result = parseReaderStatsEnvelope(
        envelope([
          { scope: "episode", episode: 1, metrics: { pv: 1 }, updatedAt },
        ])
      );
      expect(result.ok, String(updatedAt)).toBe(false);
    }
  });

  test("作品全体の行に付いていたら断る（どの話の日時か決められない）", () => {
    const result = parseReaderStatsEnvelope(
      envelope([
        {
          scope: "work",
          metrics: { pv: 1 },
          updatedAt: "2024-07-31T08:13:00+09:00",
        },
      ])
    );
    expect(result.ok).toBe(false);
  });
});

describe("台帳の最終更新", () => {
  function record(patch: Partial<ReaderStatsRecord> = {}): ReaderStatsRecord {
    return {
      site: "kakuyomu",
      readAt,
      scope: "episode",
      episode: 219,
      metrics: { pv: 1398 },
      source: "helper",
      ...patch,
    };
  }

  test("書き足して読み直しても、最終更新が残る", () => {
    const written = withReaderStats(
      emptyPostingLedger(),
      record({ updatedAt: "2024-07-31T08:13:00+09:00" })
    );
    const round = parsePostingLedger(JSON.parse(JSON.stringify(written)));
    expect(round.readerStats[0].updatedAt).toBe("2024-07-31T08:13:00+09:00");
  });

  test("空の最終更新は持たせない", () => {
    const written = withReaderStats(
      emptyPostingLedger(),
      record({ updatedAt: "  " })
    );
    expect("updatedAt" in written.readerStats[0]).toBe(false);
    const round = parsePostingLedger({
      schemaVersion: "1",
      sites: [],
      posts: [],
      readerStats: [{ ...record(), updatedAt: "" }],
    });
    expect("updatedAt" in round.readerStats[0]).toBe(false);
  });

  test("作品全体の記録や、読めない日時は受けない", () => {
    expect(() =>
      withReaderStats(
        emptyPostingLedger(),
        record({
          scope: "work",
          episode: undefined,
          updatedAt: "2024-07-31T08:13:00+09:00",
        })
      )
    ).toThrow();
    expect(() =>
      withReaderStats(emptyPostingLedger(), record({ updatedAt: "昨日" }))
    ).toThrow();
  });

  test("最終更新の形", () => {
    expect(isReaderStatsUpdatedAt("2024-07-31T08:13:00+09:00")).toBe(true);
    expect(isReaderStatsUpdatedAt("2024-07-31T08:13+09:00")).toBe(true);
    expect(isReaderStatsUpdatedAt("2024-07-30T23:13:00.000Z")).toBe(true);
    expect(isReaderStatsUpdatedAt("2024-07-31")).toBe(false);
    expect(isReaderStatsUpdatedAt("2024-07-31T08:13:00")).toBe(false);
  });
});
