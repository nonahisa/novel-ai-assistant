import { describe, expect, it } from "vitest";
import { computeMinimalEdit } from "../../src/core/textEdit";

/**
 * 書き換わった範囲だけを取り出す（設計書6.25）。
 *
 * **当てて元に戻るかを、毎回確かめる。** ここがずれると、画面の本文と
 * 保存される本文が食い違う。
 */

/** 求めた範囲を実際に当てて、後ろの文字列になるか */
function apply(before: string, after: string): string {
  const edit = computeMinimalEdit(before, after);
  if (!edit) return before;
  return before.slice(0, edit.start) + edit.insert + before.slice(edit.end);
}

describe("変わった1か所を求める", () => {
  it("変わっていなければ何も返さない", () => {
    expect(computeMinimalEdit("同じ本文", "同じ本文")).toBeUndefined();
  });

  it("真ん中へ差し込んだ場合", () => {
    const edit = computeMinimalEdit("彼は笑った", "彼は静かに笑った");
    expect(edit).toEqual({ start: 2, end: 2, insert: "静かに" });
  });

  it("真ん中を消した場合", () => {
    const edit = computeMinimalEdit("彼は静かに笑った", "彼は笑った");
    expect(edit).toEqual({ start: 2, end: 5, insert: "" });
  });

  it("末尾へ足した場合", () => {
    const edit = computeMinimalEdit("彼は", "彼は笑った");
    expect(edit).toEqual({ start: 2, end: 2, insert: "笑った" });
  });

  it("先頭へ足した場合", () => {
    const edit = computeMinimalEdit("笑った", "彼は笑った");
    expect(edit).toEqual({ start: 0, end: 0, insert: "彼は" });
  });

  it("置き換えた場合", () => {
    expect(apply("彼は笑った", "彼は泣いた")).toBe("彼は泣いた");
  });

  it("全部消した場合", () => {
    expect(apply("彼は笑った", "")).toBe("");
  });

  it("空から書き始めた場合", () => {
    expect(apply("", "彼は笑った")).toBe("彼は笑った");
  });

  /** 同じ文字が並ぶと、前後の一致が重なりやすい */
  it("同じ文字が続いても、当てれば元に戻る", () => {
    expect(apply("ああああ", "ああ")).toBe("ああ");
    expect(apply("ああ", "ああああ")).toBe("ああああ");
  });

  it("改行を含んでいても当たる", () => {
    expect(apply("一行目\n二行目", "一行目\n新しい行\n二行目")).toBe(
      "一行目\n新しい行\n二行目"
    );
  });

  /** 絵文字は2つの単位で1文字。途中で切ると壊れた片割れが残る */
  it("サロゲートペアの途中で切らない", () => {
    const before = "灯🌙灯";
    const after = "灯灯";
    expect(apply(before, after)).toBe(after);
    const edit = computeMinimalEdit(before, after);
    expect(edit).toBeDefined();
    // 切った跡に壊れた片割れが残らない
    expect(apply(before, after)).not.toContain("\ud83c");
  });

  it("絵文字を足しても壊れない", () => {
    expect(apply("灯灯", "灯🌙灯")).toBe("灯🌙灯");
  });

  /** 4万字の本文で1文字打つ場面 */
  it("長い本文でも、変わった範囲だけを返す", () => {
    const body = "あ".repeat(40000);
    const edit = computeMinimalEdit(body, body + "い");
    expect(edit).toEqual({ start: 40000, end: 40000, insert: "い" });
  });
});
