import { describe, expect, it } from "vitest";
import {
  checkEpisodeNumbers,
  describeEpisodeNumbers,
} from "../../src/core/episodeNumberCheck";

/**
 * 話番号の点検——重複と欠番（作者の指示、2026-09-19）。
 *
 * > 同じ話が入っている場合も、製品版でも指摘できるようにしてください
 * > 話が飛んでる時も同様
 *
 * **止めない。** 番号が飛ぶのは普通にある（下書き・非公開・削除）。
 * ここがするのは**知らせること**だけで、取り込みは続く。
 *
 * **アルファポリス専用にしない。** なろう・カクヨムの取り込みでも同じ
 * 点検が効く（`workZip.ts` が全サイト共通で呼ぶ）。
 */

describe("話番号の点検", () => {
  it("番号も欠番も重複も無ければ、何も言わない", () => {
    const report = checkEpisodeNumbers([
      { number: 1, label: "1話　転生", body: "あ" },
      { number: 2, label: "2話　再会", body: "い" },
      { number: 3, label: "3話　別れ", body: "う" },
    ]);

    expect(report.duplicates).toEqual([]);
    expect(report.missing).toEqual([]);
    expect(describeEpisodeNumbers(report)).toEqual([]);
  });

  it("話番号が重複していれば指摘する", () => {
    const report = checkEpisodeNumbers([
      { number: 178, label: "178話　変わった面接", body: "あ" },
      { number: 178, label: "178話　変わった面接", body: "あ" },
      { number: 179, label: "179話　合格発表", body: "い" },
    ]);

    expect(report.duplicates).toEqual([
      {
        number: 178,
        count: 2,
        sameBody: true,
        labels: ["178話　変わった面接", "178話　変わった面接"],
      },
    ]);
  });

  it("中身が違う重複は、中身が同じ重複と区別する", () => {
    const report = checkEpisodeNumbers([
      { number: 5, label: "5話", body: "あ" },
      { number: 5, label: "5話", body: "書き直したあ" },
    ]);

    expect(report.duplicates[0].sameBody).toBe(false);
  });

  it("話が飛んでいれば指摘する", () => {
    const report = checkEpisodeNumbers([
      { number: 9, label: "9話", body: "あ" },
      { number: 12, label: "12話", body: "い" },
    ]);

    expect(report.missing).toEqual([10, 11]);
  });

  it("いちばん小さい番号より前は、欠番と言わない", () => {
    // 5話から始まる作品に「1〜4話がありません」と言うのは雑音である
    const report = checkEpisodeNumbers([
      { number: 5, label: "5話", body: "あ" },
      { number: 6, label: "6話", body: "い" },
    ]);

    expect(report.missing).toEqual([]);
  });

  it("話数を読めなかった話は、欠番の計算に混ぜない", () => {
    const report = checkEpisodeNumbers([
      { number: 1, label: "プロローグ", body: "あ" },
      { number: null, label: "幕間", body: "い" },
      { number: 2, label: "2話", body: "う" },
    ]);

    expect(report.missing).toEqual([]);
    expect(report.unnumbered).toBe(1);
  });

  describe("作者へ見せる言葉", () => {
    it("重複は番号を挙げて、中身まで同じかどうかも言う", () => {
      const lines = describeEpisodeNumbers(
        checkEpisodeNumbers([
          { number: 178, label: "178話", body: "あ" },
          { number: 178, label: "178話", body: "あ" },
          { number: 179, label: "179話", body: "い" },
          { number: 179, label: "179話", body: "い" },
        ])
      );

      expect(lines.join("\n")).toContain("178話・179話");
      expect(lines.join("\n")).toContain("中身まで同じ");
    });

    it("中身が違う重複は、片方を捨てないことを言う", () => {
      const lines = describeEpisodeNumbers(
        checkEpisodeNumbers([
          { number: 5, label: "5話", body: "あ" },
          { number: 5, label: "5話", body: "書き直したあ" },
        ])
      );

      expect(lines.join("\n")).toContain("中身が違います");
      expect(lines.join("\n")).toContain("どちらも取り込みます");
    });

    it("欠番は番号を挙げる", () => {
      const lines = describeEpisodeNumbers(
        checkEpisodeNumbers([
          { number: 9, label: "9話", body: "あ" },
          { number: 12, label: "12話", body: "い" },
        ])
      );

      expect(lines.join("\n")).toContain("10話・11話が見当たりません");
    });

    it("欠番が多いときは、全部は並べない", () => {
      const entries = [
        { number: 1, label: "1話", body: "あ" },
        { number: 100, label: "100話", body: "い" },
      ];
      const lines = describeEpisodeNumbers(checkEpisodeNumbers(entries));

      expect(lines.join("\n")).toContain("98件");
      expect(lines.join("\n")).not.toContain("50話・51話・52話・53話");
    });

    it("飛んでいても止めないことを言い添える", () => {
      const lines = describeEpisodeNumbers(
        checkEpisodeNumbers([
          { number: 1, label: "1話", body: "あ" },
          { number: 3, label: "3話", body: "い" },
        ])
      );

      expect(lines.join("\n")).toContain("そのまま取り込みます");
    });
  });
});
