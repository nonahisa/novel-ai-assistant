import { describe, expect, it } from "vitest";
import {
  checkWorkEpisodeNumbers,
  describeWorkEpisodeNumbers,
  workEpisodeNumberMarks,
} from "../../../src/core/episodeNumberCheck";
import type { EpisodeFile } from "../../../src/models/types";

/**
 * 作品一覧に出す話数の重複・欠番（設計書5.4.5、作者の裁定 2026-10-25 夜）。
 *
 * 取り込みの点検（`checkEpisodeNumbers`）と違い、**本文を読まない**。
 * 走査が持っている話の並び（話数・種別・日付）だけで決める。
 *
 * **見逃しと誤検出の両方を見る**——何も言わない実装が満点にならないように、
 * 出る例と出ない例を同じ数だけ並べる。
 */

type Ep = Pick<EpisodeFile, "kind" | "chapterStart" | "chapterEnd" | "date">;

function ep(start: number | null, end: number | null = start, kind: Ep["kind"] = "本編"): Ep {
  return { kind, chapterStart: start, chapterEnd: end, date: null };
}

describe("話数の重複・欠番を、話の並びから見つける", () => {
  it("連番なら何も出ない", () => {
    const report = checkWorkEpisodeNumbers([ep(1), ep(2), ep(3)]);
    expect(report.duplicated).toEqual([]);
    expect(report.missing).toEqual([]);
    expect(workEpisodeNumberMarks(report)).toEqual([]);
    expect(describeWorkEpisodeNumbers(report)).toEqual([]);
  });

  it("同じ話数のファイルが2つあれば、重複に挙げる", () => {
    const report = checkWorkEpisodeNumbers([ep(1), ep(2), ep(2), ep(3)]);
    expect(report.duplicated).toEqual([2]);
    expect(report.missing).toEqual([]);
  });

  it("番号が飛んでいれば、欠番に挙げる", () => {
    const report = checkWorkEpisodeNumbers([ep(1), ep(2), ep(5)]);
    expect(report.duplicated).toEqual([]);
    expect(report.missing).toEqual([3, 4]);
  });

  it("いちばん小さい番号より前は、欠番に数えない", () => {
    const report = checkWorkEpisodeNumbers([ep(5), ep(6), ep(7)]);
    expect(report.missing).toEqual([]);
  });

  it("合本（1〜219話が1ファイル）は範囲として数え、欠番にしない", () => {
    const report = checkWorkEpisodeNumbers([ep(1, 219)]);
    expect(report.missing).toEqual([]);
    expect(report.duplicated).toEqual([]);
  });

  it("合本と1話ずつのファイルが重なれば、重なった話数を重複に挙げる", () => {
    const report = checkWorkEpisodeNumbers([ep(1, 3), ep(3), ep(4)]);
    expect(report.duplicated).toEqual([3]);
    expect(report.missing).toEqual([]);
  });

  it("プロローグ・幕間は別の番号なので、本編の番号と混ぜない", () => {
    const report = checkWorkEpisodeNumbers([
      ep(1, 1, "プロローグ"),
      ep(1),
      ep(1, 1, "幕間"),
      ep(2),
    ]);
    expect(report.duplicated).toEqual([]);
    expect(report.missing).toEqual([]);
  });

  it("話数の読めない話は数えない（欠番の計算に混ぜない）", () => {
    const report = checkWorkEpisodeNumbers([ep(1), ep(null), ep(2)]);
    expect(report.duplicated).toEqual([]);
    expect(report.missing).toEqual([]);
  });

  it("日付で名付けた話（SNS記事）は番号の並びではないので数えない", () => {
    const dated: Ep = { kind: "本編", chapterStart: 1, chapterEnd: 1, date: "2026-10-25" };
    const report = checkWorkEpisodeNumbers([ep(1), dated, ep(2)]);
    expect(report.duplicated).toEqual([]);
  });

  it("創作メモ集では点検しない（番号が無い・飛ぶのが普通）", () => {
    const report = checkWorkEpisodeNumbers([ep(1), ep(1), ep(5)], "memo");
    expect(report.duplicated).toEqual([]);
    expect(report.missing).toEqual([]);
  });
});

describe("一覧の印とホバーの言葉", () => {
  it("重複と欠番を、件数つきの短い印にする", () => {
    const report = checkWorkEpisodeNumbers([ep(1), ep(2), ep(2), ep(5)]);
    expect(workEpisodeNumberMarks(report)).toEqual([
      "話数の重複1件",
      "話数の欠番2件",
    ]);
  });

  it("ホバーには、どの話数かを並べる", () => {
    const report = checkWorkEpisodeNumbers([ep(1), ep(2), ep(2), ep(5)]);
    const lines = describeWorkEpisodeNumbers(report).join("\n");
    expect(lines).toContain("第2話");
    expect(lines).toContain("第3話・第4話");
  });

  it("多いときは頭だけ並べて件数を添える", () => {
    const report = checkWorkEpisodeNumbers([ep(1), ep(30)]);
    const lines = describeWorkEpisodeNumbers(report).join("\n");
    expect(lines).toContain("ぜんぶで28件");
    expect(lines).not.toContain("第29話");
  });
});
