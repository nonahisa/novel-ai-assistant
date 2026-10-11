import { describe, expect, test } from "vitest";
import {
  cutAtInlineRepetition,
  endsWithInlineRepetition,
  findInlineRepetition,
} from "../../../src/core/inlineRepetition";

/**
 * 1行の中の同じ並びの繰り返し（残課題 A17、2026-10-11）。
 *
 * 逆さの写真で、手元のAI（gemma4:26b）が1行の中に同じ9字を903回書き続けた。
 * 見逃し（903回の例）と止めすぎ（作者の表現）の両方を確かめる。
 */

/** 測定で起きた形：書き出しのあと、同じ9字が903回続いて上限で切れた */
const UNIT = "の上に立つ彼女は、";
const RUNAWAY =
  '{"lines":["私は窓の外を見ていた。","机' + UNIT.repeat(903).slice(0, -3);

describe("繰り返しを見つける", () => {
  test("903回の例を見つけ、1つ目の並びの終わりで切る", () => {
    const found = findInlineRepetition(RUNAWAY);
    expect(found).toBeDefined();
    expect(found?.unitLength).toBe(9);
    const head = cutAtInlineRepetition(RUNAWAY);
    expect(head).toBe('{"lines":["私は窓の外を見ていた。","机' + UNIT);
  });

  test("流しの途中でも、末尾が繰り返しになった時点で気づく（48字で）", () => {
    const opening = '{"lines":["机';
    // 5回（45字）では、まだ止めない
    expect(endsWithInlineRepetition(opening + UNIT.repeat(5))).toBeUndefined();
    // 8回（72字）で止める
    expect(endsWithInlineRepetition(opening + UNIT.repeat(8))?.unitLength).toBe(9);
  });

  test("正常な原稿では止めない", () => {
    const manuscript = [
      "　その日、私は駅のホームで彼女を待っていた。",
      "　電車は遅れていた。アナウンスが三度、同じ言葉を繰り返した。",
      "「ごめん、ごめん、ごめん」と彼女は言った。",
      "　雨が降っていた。雨が降っていた。雨が降っていた。",
    ].join("\n");
    const json = JSON.stringify({ lines: manuscript.split("\n") });
    expect(findInlineRepetition(json)).toBeUndefined();
    expect(endsWithInlineRepetition(json)).toBeUndefined();
  });

  test("1字の連続（「ああああ」「ーーー」「〓〓〓」）は、どれだけ長くても止めない", () => {
    for (const text of [
      "あ".repeat(300),
      "ー".repeat(300),
      "〓".repeat(300),
      "…".repeat(300),
    ]) {
      const line = `「${text}」`;
      expect(findInlineRepetition(line), text.slice(0, 3)).toBeUndefined();
      expect(endsWithInlineRepetition(line + text), text.slice(0, 3)).toBeUndefined();
    }
  });

  test("短い繰り返しの表現（「わんわん」×8、「はあはあ」×8）は止めない", () => {
    for (const text of ["わん".repeat(16), "はあ".repeat(8 * 2), "ドン、".repeat(8)]) {
      expect(findInlineRepetition(`「${text}」`), text).toBeUndefined();
      expect(endsWithInlineRepetition(`「${text}`), text).toBeUndefined();
    }
  });

  test("回数が足りなければ、長い並びでも止めない（20字×7回）", () => {
    const unit = "あいうえおかきくけこさしすせそたちつてと";
    expect(findInlineRepetition(unit.repeat(7))).toBeUndefined();
    expect(findInlineRepetition(unit.repeat(8))?.unitLength).toBe(20);
  });

  test("21字以上の並びは見ない（行の繰り返しは別の見張りの受け持ち）", () => {
    const unit = "あいうえおかきくけこさしすせそたちつてとな";
    expect(findInlineRepetition(unit.repeat(10))).toBeUndefined();
  });
});
