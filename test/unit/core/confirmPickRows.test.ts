import { describe, expect, test } from "vitest";
import {
  CONFIRM_ROW_WIDTH,
  layoutConfirm,
  wrapConfirmLine,
} from "../../../src/core/confirmPickRows";

/**
 * 確認の文と補足を、選択窓の行に並べ替える（作者の裁定 A4、2026-09-23）。
 *
 * 選択窓の1行は折り返さず、はみ出た分は「…」で切れる。モーダルは長い
 * 補足を折り返して全部見せていたので、**同じ中身が読めるよう、こちらで
 * 折り返す。** 字を落とさないことが一番大事である。
 */
describe("wrapConfirmLine", () => {
  test("短い行はそのまま", () => {
    expect(wrapConfirmLine("材料: 人物3人", 40)).toEqual(["材料: 人物3人"]);
  });

  test("長い行は折り返す。字を1つも落とさない", () => {
    const line = "あ".repeat(95);
    const rows = wrapConfirmLine(line, 40);
    expect(rows.every((row) => [...row].length <= 40)).toBe(true);
    expect(rows.join("")).toBe(line);
  });

  test("句読点の直後で切れるなら、そこで切る", () => {
    const line = "あ".repeat(35) + "。" + "い".repeat(20);
    expect(wrapConfirmLine(line, 40)).toEqual(["あ".repeat(35) + "。", "い".repeat(20)]);
  });

  test("サロゲートペア（絵文字や一部の漢字）を途中で割らない", () => {
    const line = "𠮷".repeat(45);
    const rows = wrapConfirmLine(line, 40);
    expect(rows.join("")).toBe(line);
    expect(rows.every((row) => !/^[\uDC00-\uDFFF]/.test(row))).toBe(true);
  });
});

describe("layoutConfirm", () => {
  test("文の1行目が題、残りと補足が行になる。空行は段落の区切り", () => {
    const layout = layoutConfirm(
      "作品：台\n矛盾を検知します。",
      "12チャンク中 12件を処理します。\n\n材料: 人物3人"
    );
    expect(layout.title).toBe("作品：台");
    expect(layout.rows).toEqual([
      "矛盾を検知します。",
      null,
      "12チャンク中 12件を処理します。",
      null,
      "材料: 人物3人",
    ]);
  });

  test("区切りは重ねず、頭と末尾にも置かない", () => {
    const layout = layoutConfirm("確認します。", "\n\nあ\n\n\n\nい\n\n");
    expect(layout.rows).toEqual(["あ", null, "い"]);
  });

  test("補足が無ければ行は空", () => {
    expect(layoutConfirm("19話をAIで確認します。").rows).toEqual([]);
  });

  test("題が長すぎれば、はみ出た分を行の頭へ送る（字を落とさない）", () => {
    const first = "あ".repeat(CONFIRM_ROW_WIDTH + 10);
    const layout = layoutConfirm(first);
    expect(layout.title + layout.rows.join("")).toBe(first);
    expect([...layout.title].length).toBeLessThanOrEqual(CONFIRM_ROW_WIDTH);
  });
});
