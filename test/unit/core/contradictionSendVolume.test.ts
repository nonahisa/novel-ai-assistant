import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { describeSendVolume } from "../../../src/core/sendVolume";
import { CARRY_OVER_DEFAULT_CHAPTERS } from "../../../src/core/contradictionMaterial";

/**
 * 矛盾検知の引き継ぎ（`carryOver`）を既定にした（作者の裁定、2026-09-23。A3①）。
 *
 * 既定値そのものは 0.73.3 で2話になっており、送る材料が `carryOver=2` の
 * 写しと1文字も変わらないことは `contradictionPromptGolden.test.ts` が見る。
 * ここで見るのは、**増えた材料が確認画面の目安に出ること**——本文の字数
 * だけで見積もると、引き継ぎで＋16%になった送る量が時間にも量にも出ない。
 */

describe("送る量の言い方（`describeSendVolume`）", () => {
  test("本文と、それ以外（指示と設定資料）を分けて言う", () => {
    expect(describeSendVolume({ totalChars: 12345, bodyChars: 10000 })).toBe(
      "送る量: 約12,345字（本文 10,000字＋指示と設定資料 2,345字）"
    );
  });

  test("本文以外が無ければ内訳を出さない", () => {
    expect(describeSendVolume({ totalChars: 800, bodyChars: 800 })).toBe(
      "送る量: 約800字"
    );
  });

  test("数え方が食い違って合計が本文より小さくても、負の字数を見せない", () => {
    expect(describeSendVolume({ totalChars: 700, bodyChars: 800 })).toBe(
      "送る量: 約700字"
    );
  });

  test("壊れた値は0字として扱う", () => {
    expect(describeSendVolume({ totalChars: Number.NaN, bodyChars: -1 })).toBe(
      "送る量: 約0字"
    );
  });
});

describe("矛盾検知の確認画面は、実際に送る量で見積もる", () => {
  const source = readFileSync(
    join(__dirname, "..", "..", "..", "src", "features", "checkContradictions.ts"),
    "utf8"
  );

  test("既定は2話ぶん引き継ぐ（測った値）", () => {
    expect(CARRY_OVER_DEFAULT_CHAPTERS).toBe(2);
  });

  test("時間の見積もりへ本文の字数だけを渡さない", () => {
    const call = source.indexOf("estimateRunTimeText({");
    expect(call).toBeGreaterThan(0);
    const args = source.slice(call, source.indexOf("})", call));
    // 本文の字数だけ（`chunk.text.length`）だと、引き継ぎで増えた材料が
    // 見積もりから抜ける
    expect(args).not.toMatch(/chunk\.text\.length/);
    expect(args).toMatch(/inputChars:\s*sendChars/);
  });

  test("確認画面に送る量を出す", () => {
    expect(source).toMatch(/describeSendVolume\(/);
  });

  test("送る量は、送るときと同じ組み立て（`promptFor`）で数える", () => {
    // 見積もり用に別の組み立てを書くと、送るものと数えたものが食い違う
    const uses = source.match(/promptFor\(/g) ?? [];
    // 定義1つ＋送るとき＋数えるとき
    expect(uses.length).toBeGreaterThanOrEqual(3);
  });
});
