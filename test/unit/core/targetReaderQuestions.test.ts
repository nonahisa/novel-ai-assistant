import { describe, expect, test } from "vitest";
import { READER_QUESTIONS } from "../../../src/core/readerTarget";

/**
 * 「ターゲット読者」2段目（書き方の判断）の問いの形（設計書6.108.6）。
 *
 * 作者の指摘④（2026-09-22 未明）：診断の設問が分かりにくい——答える主体と
 * 方向がぼやけている。**主体＝作者・対象＝この作品を毎問明示し、
 * 「あなたはこの作品で〜していますか」の形に揃える。**
 *
 * **「願望ではなく判断を聞く」の意図は残す**（6.91）。願望（どんな読者に
 * 読んでもらいたいか）は1段目の「狙い」で聞くので、ここへ混ぜない。
 */
describe("書き方の判断の9問", () => {
  test("どの問いも「あなたはこの作品」で始まる（主体と対象を毎問明示）", () => {
    for (const question of READER_QUESTIONS) {
      expect(question.text, question.id).toMatch(/^あなたはこの作品/);
    }
  });

  test("どの問いも「〜していますか」で終わる（していることを聞く）", () => {
    for (const question of READER_QUESTIONS) {
      expect(question.text, question.id).toMatch(/[てで]いますか$/);
    }
  });

  test("願望の聞き方（〜してほしいですか・読んでもらいたい）を問いに使わない", () => {
    for (const question of READER_QUESTIONS) {
      expect(question.text, question.id).not.toContain("ほしいですか");
      expect(question.text, question.id).not.toContain("読んでもらいたい");
    }
  });

  test("軸と点数と選択肢の数は変えていない（前回の答えがそのまま使える）", () => {
    // 答えは選んだ番号で `設定/読者像.json` に残っている。並びや点数を
    // 動かすと、前回の答えが別の意味になる
    expect(READER_QUESTIONS.map((question) => question.id)).toEqual([
      "A1",
      "A2",
      "A3",
      "B1",
      "B2",
      "B3",
      "C1",
      "C2",
      "C3",
    ]);
    for (const question of READER_QUESTIONS) {
      expect(
        question.choices.map((choice) => choice.score),
        question.id
      ).toEqual([0, 1, 2]);
    }
  });
});
