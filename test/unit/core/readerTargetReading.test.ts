import { describe, expect, test } from "vitest";
import {
  isReadingUsable,
  parseReaderTargetReading,
  quoteAppearsIn,
  READER_NEUTRAL_SCORE,
} from "../../../src/core/readerTargetValidation";
import { buildReaderGuide } from "../../../src/core/readerTargetDoc";
import type { ReaderProfile } from "../../../src/models/readerProfile";

/**
 * **AIの読み取りを信用しない**（設計書6.91、CLAUDE.mdの実装ルール3）。
 *
 * この作品では「指示した言葉がそのまま返ってくる」「引き写しと言って
 * おいて要約を書く」が繰り返し起きている。ここで確かめるのは、
 * **作り物の根拠を通さないこと**と、**捨てたものを黙って埋めないこと**。
 */

const SOURCE = [
  "少年は剣を抜いた。魔力の流れが、指先から刃へ移っていく。",
  "説明する暇はなかった。誰もがそれを知っていたからだ。",
].join("\n");

function answer(
  axes: Array<{ axis: string; score: unknown; evidence?: unknown }>
): unknown {
  return { axes };
}

describe("引用が本文にあるか", () => {
  test("そのまま引き写した文は通る", () => {
    expect(quoteAppearsIn("少年は剣を抜いた", SOURCE)).toBe(true);
  });

  test("**言い換えは通さない**（要約は引き写しではない）", () => {
    expect(quoteAppearsIn("主人公が武器を構える場面", SOURCE)).toBe(false);
  });

  test("空白の全角・半角差では落とさない", () => {
    expect(quoteAppearsIn("少年は 剣を 抜いた", SOURCE)).toBe(true);
  });
});

describe("読み取りの検算", () => {
  test("3軸そろっていれば、そのまま受け取る", () => {
    const reading = parseReaderTargetReading(
      answer([
        {
          axis: "familiarity",
          score: 5,
          evidence: [{ quote: "説明する暇はなかった", from: "冒頭の本文" }],
        },
        { axis: "posture", score: 2, evidence: [] },
        { axis: "craving", score: 4, evidence: [] },
      ]),
      SOURCE
    );
    expect(reading.scores).toEqual({
      familiarity: 5,
      posture: 2,
      craving: 4,
    });
    expect(reading.unmeasured).toEqual([]);
    expect(reading.evidence).toHaveLength(1);
    expect(isReadingUsable(reading)).toBe(true);
  });

  test("**根拠が作り物なら、点数ごと捨てる**", () => {
    const reading = parseReaderTargetReading(
      answer([
        {
          axis: "familiarity",
          score: 6,
          evidence: [{ quote: "この作品は説明が少ない", from: "冒頭の本文" }],
        },
        { axis: "posture", score: 2, evidence: [] },
        { axis: "craving", score: 4, evidence: [] },
      ]),
      SOURCE
    );
    // 捨てた軸は「どちらとも言えない」に置く
    expect(reading.scores.familiarity).toBe(READER_NEUTRAL_SCORE);
    expect(reading.unmeasured).toEqual(["読み慣れ"]);
    // **黙って埋めない**（何を測れなかったかが残る）
    expect(reading.notes.join("")).toContain("読み慣れ");
  });

  test("**0〜6の外と小数を通さない**", () => {
    const reading = parseReaderTargetReading(
      answer([
        { axis: "familiarity", score: 9, evidence: [] },
        { axis: "posture", score: 2.5, evidence: [] },
        { axis: "craving", score: "4", evidence: [] },
      ]),
      SOURCE
    );
    expect(reading.unmeasured).toEqual(["読み慣れ", "読む姿勢", "求めるもの"]);
    expect(isReadingUsable(reading)).toBe(false);
  });

  test("知らない軸は捨てる（指示語がそのまま返ってくることがある）", () => {
    const reading = parseReaderTargetReading(
      answer([
        { axis: "年齢層", score: 3, evidence: [] },
        { axis: "posture", score: 1, evidence: [] },
      ]),
      SOURCE
    );
    expect(reading.scores.posture).toBe(1);
    expect(reading.notes.join("")).toContain("年齢層");
  });

  test("同じ軸が2回返ったら、後のほうを捨てる", () => {
    const reading = parseReaderTargetReading(
      answer([
        { axis: "craving", score: 6, evidence: [] },
        { axis: "craving", score: 0, evidence: [] },
      ]),
      SOURCE
    );
    expect(reading.scores.craving).toBe(6);
  });

  /**
   * **3軸とも測れなかったら使わない。**
   *
   * どれも3点では、宣言とのズレが必ず出なくなる（宣言が中ほどなら0、
   * 端なら必ず3）。当てにならない比較を見せるより、
   * 「読み取れませんでした」と言うほうがよい。
   */
  test("**何も返らなければ、使えないと言う**", () => {
    const reading = parseReaderTargetReading({}, SOURCE);
    expect(isReadingUsable(reading)).toBe(false);
    expect(reading.notes.join("")).toContain("軸が1つも返りませんでした");
  });
});

describe("診断の紙", () => {
  const profile: ReaderProfile = {
    schemaVersion: "1",
    declared: {
      scores: { familiarity: 0, posture: 1, craving: 0 },
      answers: [0, 0, 0, 0, 1, 0, 0, 0, 0],
      updatedAt: "2026-09-13T01:00:00.000Z",
    },
    actual: {
      scores: { familiarity: 6, posture: 5, craving: 2 },
      evidence: [
        { axis: "familiarity", quote: "説明する暇はなかった", from: "冒頭の本文" },
      ],
      basis: "冒頭・プロット",
      model: "gemma4:26b",
      updatedAt: "2026-09-13T02:00:00.000Z",
    },
  };

  test("**実像を先に出す**（作者が知りたいのは、自分の答えの復唱ではない）", () => {
    const paper = buildReaderGuide({ workTitle: "湖畔の誓い", profile });
    const actual = paper.indexOf("## この作品は");
    const declared = paper.indexOf("## 向けているつもりは");
    expect(actual).toBeGreaterThan(0);
    expect(declared).toBeGreaterThan(actual);
  });

  test("ズレを並べ、どちらが正しいとも言わない", () => {
    const paper = buildReaderGuide({ workTitle: "湖畔の誓い", profile });
    expect(paper).toContain("## 向けているつもりと、書けているもの");
    expect(paper).toContain("どちらが正しいとも言いません");
    expect(paper).toContain("読み慣れ：向けているつもりは0／書けているものは6");
  });

  test("根拠は、検算を通ったものだけが並ぶ", () => {
    const paper = buildReaderGuide({ workTitle: "湖畔の誓い", profile });
    expect(paper).toContain("## そう読んだ根拠");
    expect(paper).toContain("説明する暇はなかった");
  });

  test("**ほかの読者層も出す**（いまの位置に印）", () => {
    const paper = buildReaderGuide({ workTitle: "湖畔の誓い", profile });
    expect(paper).toContain("## ほかの読者層");
    expect(paper).toContain("**← この作品**");
    // 年齢層を軸にしない理由も添える
    expect(paper).toContain("年齢層は軸にしていません");
  });

  test("宣言だけでも紙になる（実像の節は出さない）", () => {
    const paper = buildReaderGuide({
      workTitle: "湖畔の誓い",
      profile: { schemaVersion: "1", declared: profile.declared },
    });
    expect(paper).toContain("## 向けているつもりは");
    expect(paper).not.toContain("## そう読んだ根拠");
    expect(paper).not.toContain("## 向けているつもりと、書けているもの");
  });

  test("実像だけなら、9問へ誘う", () => {
    const paper = buildReaderGuide({
      workTitle: "湖畔の誓い",
      profile: { schemaVersion: "1", actual: profile.actual },
    });
    expect(paper).toContain("## 向けているつもりは、まだお聞きしていません");
  });

  test("**測れなかった軸は、測れなかったと書く**", () => {
    const paper = buildReaderGuide({
      workTitle: "湖畔の誓い",
      profile,
      unmeasured: ["求めるもの"],
    });
    expect(paper).toContain("**求めるもの** は読み取れませんでした");
  });

  test("ずれていなければ「ずれていません」と言う（黙って飛ばさない）", () => {
    const same: ReaderProfile = {
      schemaVersion: "1",
      declared: { ...profile.declared!, scores: { familiarity: 3, posture: 3, craving: 3 } },
      actual: { ...profile.actual!, scores: { familiarity: 3, posture: 3, craving: 3 } },
    };
    const paper = buildReaderGuide({ workTitle: "湖畔の誓い", profile: same });
    expect(paper).toContain("**3つとも、ずれていません。**");
  });
});
