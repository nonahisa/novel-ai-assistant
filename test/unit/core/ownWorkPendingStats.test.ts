import { describe, expect, test } from "vitest";
import {
  MAX_PENDING_STATS_PER_WORK,
  MAX_PENDING_STATS_TOTAL,
  PENDING_STATS_MAX_AGE_DAYS,
  holdOwnWorkStats,
  readPendingOwnWorkStats,
  takeRegisteredPending,
} from "../../../src/core/ownWorkPendingStats";
import {
  buildReaderStatsEnvelope,
  parseReaderStatsEnvelope,
  type ReaderStatsEnvelope,
} from "../../../src/core/readerStatsEnvelope";

/**
 * 「未登録の自分の作品」の読者の反応の控え（作者の判断 2026-11-01。設計書6.99.8）。
 *
 * - 本人しか開けない画面で読んだ分だけ控える（他人の作品も開ける画面の分は控えない）
 * - 同じ画面を二度控えない。上限（作品ごと・全体・日数）を超えたら古いものから捨てる
 * - 読み戻すときは封筒の関所を通し直し、通らない1件だけを捨てる
 */

const NOW = Date.parse("2026-11-01T12:00:00.000Z");

function envelope(over: Partial<Parameters<typeof buildReaderStatsEnvelope>[0]> = {}): ReaderStatsEnvelope {
  const parsed = parseReaderStatsEnvelope(
    buildReaderStatsEnvelope({
      site: "kakuyomu",
      workId: "16816927861924296900",
      readAt: "2026-11-01T07:47:50.743Z",
      title: "星の数ほどいるクズ",
      ownedVia: "owner-page",
      entries: [{ scope: "work", metrics: { pv: 120 } }],
      ...over,
    })
  );
  if (!parsed.ok) throw new Error(parsed.reason);
  return parsed.envelope;
}

function roundTrip(value: unknown, now = NOW) {
  // 保管庫は JSON で持つので、一度くぐらせてから読む
  return readPendingOwnWorkStats(JSON.parse(JSON.stringify(value)), now);
}

describe("控える", () => {
  test("本人しか開けない画面で読んだ分を控え、読み戻すと同じ封筒になる", () => {
    const { next, changed } = holdOwnWorkStats([], [envelope()], NOW);
    expect(changed).toBe(true);
    const back = roundTrip(next);
    expect(back).toHaveLength(1);
    expect(back[0]).toMatchObject({ site: "kakuyomu", workId: "16816927861924296900" });
    expect(back[0].parsed.entries).toEqual(envelope().entries);
  });

  test("作者が認めただけの作品・他人の作品も開ける画面（Narou.fun）・作品IDの無い分は控えない", () => {
    const skipped = [
      envelope({ ownedVia: "approved" }),
      envelope({ site: "narou", workId: "n4190fx", source: "narou.fun" }),
      envelope({ workId: undefined }),
    ];
    expect(holdOwnWorkStats([], skipped, NOW)).toEqual({ next: [], changed: false });
  });

  test("同じ画面が2度届いても1度だけ控える（呼び出しと貼り付けで同じ束が来る）", () => {
    const first = holdOwnWorkStats([], [envelope()], NOW);
    const second = holdOwnWorkStats(roundTrip(first.next), [envelope()], NOW + 1000);
    expect(second.changed).toBe(false);
    expect(second.next).toHaveLength(1);
  });

  test("作品ごとの上限を超えたら、その作品の古い画面から捨てる（ほかの作品の分は残す）", () => {
    const many = Array.from({ length: MAX_PENDING_STATS_PER_WORK + 3 }, (_, index) =>
      envelope({ readAt: `2026-10-${String(index + 1).padStart(2, "0")}T00:00:00.000Z` })
    );
    const other = envelope({ workId: "999", readAt: "2026-09-01T00:00:00.000Z" });
    const { next } = holdOwnWorkStats([], [...many, other], NOW);
    const back = roundTrip(next);
    const mine = back.filter((entry) => entry.workId === "16816927861924296900");
    expect(mine).toHaveLength(MAX_PENDING_STATS_PER_WORK);
    // いちばん古い3画面（10月1〜3日）が捨てられている
    expect(mine[0].parsed.readAt).toBe("2026-10-04T00:00:00.000Z");
    expect(back.some((entry) => entry.workId === "999")).toBe(true);
  });

  test("全体の上限を超えたら古いものから捨てる", () => {
    const many = Array.from({ length: MAX_PENDING_STATS_TOTAL + 5 }, (_, index) =>
      envelope({
        workId: `w${index}`,
        readAt: new Date(Date.parse("2026-10-01T00:00:00.000Z") + index * 60000).toISOString(),
      })
    );
    const { next } = holdOwnWorkStats([], many, NOW);
    expect(next).toHaveLength(MAX_PENDING_STATS_TOTAL);
    expect(next.some((entry) => entry.workId === "w0")).toBe(false);
    expect(next.some((entry) => entry.workId === `w${MAX_PENDING_STATS_TOTAL + 4}`)).toBe(true);
  });

  test(`${PENDING_STATS_MAX_AGE_DAYS}日より前に控えたものは読み戻さない`, () => {
    const { next } = holdOwnWorkStats([], [envelope()], NOW);
    const later = NOW + (PENDING_STATS_MAX_AGE_DAYS + 1) * 24 * 60 * 60 * 1000;
    expect(roundTrip(next, later)).toEqual([]);
    expect(roundTrip(next, NOW + 24 * 60 * 60 * 1000)).toHaveLength(1);
  });
});

describe("読み戻す", () => {
  test("形の違う項目・関所を通らない封筒だけを捨てる（全体は捨てない）", () => {
    const { next } = holdOwnWorkStats([], [envelope()], NOW);
    const broken = [
      ...next,
      { site: "kakuyomu", workId: "1", heldAt: "2026-11-01T00:00:00.000Z", envelope: "{壊れた" },
      { site: "kakuyomu", workId: "1", heldAt: "2026-11-01T00:00:00.000Z", envelope: '{"novelai-stats":99}' },
      "壊れた",
      { envelope: next[0].envelope },
    ];
    expect(roundTrip(broken)).toHaveLength(1);
    expect(readPendingOwnWorkStats(undefined, NOW)).toEqual([]);
  });
});

describe("登録されたら取り出す", () => {
  test("登録済みの作品の分だけを取り出し、残りは控えたまま", () => {
    const { next } = holdOwnWorkStats(
      [],
      [envelope(), envelope({ workId: "999", readAt: "2026-11-01T08:00:00.000Z" })],
      NOW
    );
    const { taken, rest } = takeRegisteredPending(
      roundTrip(next),
      (site, workId) => site === "kakuyomu" && workId === "999"
    );
    expect(taken.map((entry) => entry.workId)).toEqual(["999"]);
    expect(rest.map((entry) => entry.workId)).toEqual(["16816927861924296900"]);
  });
});
