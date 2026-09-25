import { describe, expect, test } from "vitest";
import {
  TUNING_WORK_LONG,
  TUNING_WORK_PARAGRAPHS,
  TUNING_WORK_PLANTED_TYPOS,
  TUNING_WORK_PROPER_NOUNS,
  TUNING_WORK_SHORT,
  TUNING_WORK_TRAPS,
  TUNING_WORK_WARMUP,
} from "../../../src/core/tuningWorkSample";

/**
 * 仕事に近い形の測定に使う、同梱の文（設計書6.49.9）。
 *
 * **誤りが無い文では答えの一覧が空になり、合言葉と同じ「答えの短い測定」に
 * 戻ってしまう。** 誤りが本当に入っていること、短い回と長い回の字数に
 * 差があることを見張る。
 */
describe("同梱の文", () => {
  test("わざと置いた誤りが、その段落に本当にある", () => {
    for (const typo of TUNING_WORK_PLANTED_TYPOS) {
      expect(TUNING_WORK_PARAGRAPHS[typo.paragraph]).toContain(typo.target);
      // 直した形は、その段落には無い（誤りでないものを誤りと数えない）
      expect(TUNING_WORK_PARAGRAPHS[typo.paragraph]).not.toContain(typo.suggestion);
    }
    // どの段落にも誤りがある（短い回だけ答えが空、にならない）
    for (let index = 0; index < TUNING_WORK_PARAGRAPHS.length; index += 1) {
      expect(
        TUNING_WORK_PLANTED_TYPOS.some((typo) => typo.paragraph === index)
      ).toBe(true);
    }
  });

  test("数百字の段落で、長い回は短い回の数倍ある（時間の差が測れる）", () => {
    for (const paragraph of TUNING_WORK_PARAGRAPHS) {
      expect(paragraph.length).toBeGreaterThanOrEqual(200);
      expect(paragraph.length).toBeLessThanOrEqual(400);
    }
    expect(TUNING_WORK_SHORT).toBe(TUNING_WORK_PARAGRAPHS[0]);
    expect(TUNING_WORK_LONG.length).toBeGreaterThan(TUNING_WORK_SHORT.length * 2.5);
  });

  test("読み込ませる回・短い回・長い回は、書き出しがそろわない（読み込みの使い回しを測らない）", () => {
    // 実接続（2026-09-26）：読み込ませる回と短い回が同じ文だと、短い回が0.2秒で返った
    const heads = [TUNING_WORK_WARMUP, TUNING_WORK_SHORT, TUNING_WORK_LONG].map((text) =>
      text.slice(0, 20)
    );
    expect(new Set(heads).size).toBe(3);
  });

  test("罠（誤りではないのに直したくなる語）は、段落に1回だけあり、置いた誤りと重ならない", () => {
    // 3〜5個。少なすぎると誤検出の癖が見えず、多すぎると罠探しの試験になる
    expect(TUNING_WORK_TRAPS.length).toBeGreaterThanOrEqual(3);
    expect(TUNING_WORK_TRAPS.length).toBeLessThanOrEqual(5);
    // 種類を散らす（同じ種類ばかりだと、その1つの癖しか測れない）
    expect(new Set(TUNING_WORK_TRAPS.map((trap) => trap.kind)).size).toBe(
      TUNING_WORK_TRAPS.length
    );
    for (const trap of TUNING_WORK_TRAPS) {
      const paragraph = TUNING_WORK_PARAGRAPHS[trap.paragraph];
      const at = paragraph.indexOf(trap.text);
      expect(at).toBeGreaterThanOrEqual(0);
      expect(paragraph.indexOf(trap.text, at + 1)).toBe(-1);
      for (const typo of TUNING_WORK_PLANTED_TYPOS.filter(
        (planted) => planted.paragraph === trap.paragraph
      )) {
        const typoAt = paragraph.indexOf(typo.target);
        const overlaps = at < typoAt + typo.target.length && typoAt < at + trap.text.length;
        expect(overlaps).toBe(false);
      }
      // 造語を辞書に載せると、検算が弾いてモデルの癖が見えなくなる
      expect(TUNING_WORK_PROPER_NOUNS.some((noun) => trap.text.includes(noun))).toBe(false);
    }
  });

  test("誤りは7つのまま（罠を足しても、当たりの数の意味を変えない）", () => {
    expect(TUNING_WORK_PLANTED_TYPOS).toHaveLength(7);
  });

  test("固有名詞の辞書に載せた語は、文の中にある", () => {
    for (const noun of TUNING_WORK_PROPER_NOUNS) {
      expect(TUNING_WORK_LONG).toContain(noun);
    }
  });
});
