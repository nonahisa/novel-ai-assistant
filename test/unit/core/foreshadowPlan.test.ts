import { describe, expect, test } from "vitest";
import {
  describeForeshadowNotice,
  foreshadowCountsByChapter,
  foreshadowNoticeForChapter,
  lastWrittenChapter,
  overdueForeshadows,
  sumForeshadowCounts,
} from "../../../src/core/foreshadowPlan";
import { emptyForeshadow, type Foreshadow } from "../../../src/models/foreshadow";

/**
 * プロットモードと単話プロットに出す伏線の数え方（設計書6.35・6.4.8。
 * 作者の依頼、2026-09-23「伏線とも連携させてください」）。
 */

function record(
  id: string,
  patch: Partial<Foreshadow>
): Foreshadow {
  return { ...emptyForeshadow(id, patch.label ?? id), ...patch };
}

const records: Foreshadow[] = [
  record("foreshadow_001", { label: "懐中時計", plantedChapter: 3, plannedResolveChapter: 12 }),
  record("foreshadow_002", {
    label: "割れた鏡",
    plantedChapter: 3,
    status: "resolved",
    resolvedChapter: 8,
    plannedResolveChapter: 8,
  }),
  record("foreshadow_003", { label: "古い地図", plantedChapter: 5, plannedResolveChapter: 4 }),
  record("foreshadow_004", { label: "意図した謎", plantedChapter: 5, status: "intentional", plannedResolveChapter: 4 }),
  record("foreshadow_005", { label: "話数不明", plantedChapter: null }),
];

describe("話ごとの数", () => {
  const counts = foreshadowCountsByChapter(records);

  test("張った伏線は、状態によらず張った話で数える", () => {
    expect(counts.get(3)?.planted).toBe(2);
    expect(counts.get(5)?.planted).toBe(2);
  });

  test("回収した伏線は、回収済みのものだけ回収した話で数える", () => {
    expect(counts.get(8)?.resolved).toBe(1);
  });

  test("回収予定は、未回収のものだけ数える（回収済み・意図して開けたままは入れない）", () => {
    expect(counts.get(12)?.planned).toBe(1);
    // foreshadow_002 は回収済み、004 は意図して開けたまま
    expect(counts.get(8)?.planned ?? 0).toBe(0);
    expect(counts.get(4)?.planned).toBe(1);
  });

  test("話数不明のものは、どの話にも数えない", () => {
    const total = [...counts.values()].reduce((sum, entry) => sum + entry.planted, 0);
    expect(total).toBe(4);
  });

  test("合本の範囲は足し合わせる", () => {
    expect(sumForeshadowCounts(counts, 3, 5)).toEqual({ planted: 4, resolved: 0, planned: 1 });
  });
});

describe("回収予定を過ぎた伏線", () => {
  test("予定の話数が、書いた最後の話数より前で、まだ未回収のもの", () => {
    const overdue = overdueForeshadows(records, 10);
    expect(overdue.map((entry) => entry.id)).toEqual(["foreshadow_003"]);
  });

  test("予定の話そのものを書いている最中は、まだ過ぎていない", () => {
    expect(overdueForeshadows(records, 4)).toEqual([]);
  });

  test("本文が1つも無ければ数えない", () => {
    expect(overdueForeshadows(records, null)).toEqual([]);
  });

  test("書いた最後の話数は、合本の終わりまで見る", () => {
    expect(
      lastWrittenChapter([
        { chapterStart: 1, chapterEnd: 10 },
        { chapterStart: 11 },
        { chapterStart: null },
      ])
    ).toBe(11);
    expect(lastWrittenChapter([{ chapterStart: null }])).toBeNull();
  });
});

describe("その話の知らせ", () => {
  test("張った・回収予定の、未回収のものだけ", () => {
    const notice = foreshadowNoticeForChapter(records, 3);
    expect(notice.planted.map((entry) => entry.label)).toEqual(["懐中時計"]);
    expect(notice.plannedResolve).toEqual([]);

    const at12 = foreshadowNoticeForChapter(records, 12);
    expect(at12.plannedResolve.map((entry) => entry.label)).toEqual(["懐中時計"]);
  });

  test("何も無ければ知らせない", () => {
    expect(describeForeshadowNotice("第7話", foreshadowNoticeForChapter(records, 7))).toBeNull();
  });

  test("知らせの文に、話と伏線の名前が入る", () => {
    const text = describeForeshadowNotice("第12話", foreshadowNoticeForChapter(records, 12));
    expect(text).toContain("第12話");
    expect(text).toContain("回収予定");
    expect(text).toContain("懐中時計");
  });
});

describe("話を差し込んだ・消したとき、回収予定も付け替える", () => {
  test("動いた話数を指していれば、新しい話数へ", async () => {
    const { renumberForeshadow } = await import("../../../src/core/episodeRenumber");
    const result = renumberForeshadow(
      record("foreshadow_001", { plantedChapter: 3, plannedResolveChapter: 10 }),
      { moved: new Map([[10, 11]]) }
    );
    expect(result.record.plannedResolveChapter).toBe(11);
    expect(result.record.plantedChapter).toBe(3);
  });

  test("消した話を指していれば、未定に戻す（伏線そのものは消さない）", async () => {
    const { renumberForeshadow } = await import("../../../src/core/episodeRenumber");
    const result = renumberForeshadow(
      record("foreshadow_001", { plantedChapter: 3, plannedResolveChapter: 10 }),
      { moved: new Map(), removed: 10 }
    );
    expect(result.record.plannedResolveChapter).toBeNull();
    expect(result.record.label).toBe("foreshadow_001");
  });
});
