import { describe, expect, test } from "vitest";
import {
  HANGABLE,
  isHangable,
  isNoLineEnd,
  isNoLineStart,
  NO_LINE_END,
  NO_LINE_START,
} from "../../../src/core/kinsoku";

/**
 * 禁則の字の定義（設計書6.33.5）。
 *
 * **定義は1か所。** 印刷の面割り（ブラウザの中のスクリプト）と、公募の
 * 納品用の行割りが同じ文字列を見る。
 */
describe("行頭に置かない字", () => {
  test.each(["、", "。", "，", "．", "」", "』", "）", "】", "》", "！", "？", "・", "々"])(
    "%s は行頭に来ない",
    (ch) => {
      expect(isNoLineStart(ch)).toBe(true);
    }
  );

  test("小さい仮名と長音は行頭に来てよい（原稿用紙の書き方）", () => {
    // ここを厳しくすると、字数の足りない行が増えて「40字×40行」から外れて見える
    for (const ch of ["っ", "ャ", "ー", "ぁ"]) {
      expect(isNoLineStart(ch)).toBe(false);
    }
  });

  test("ふつうの字・開き括弧は行頭に来てよい", () => {
    for (const ch of ["あ", "漢", "「", "（", "…"]) {
      expect(isNoLineStart(ch)).toBe(false);
    }
  });

  test("かたまり（ルビの親文字など）は先頭の字で決める", () => {
    expect(isNoLineStart("」と")).toBe(true);
    expect(isNoLineStart("と」")).toBe(false);
    expect(isNoLineStart("")).toBe(false);
  });
});

describe("行末に置かない字", () => {
  test.each(["「", "『", "（", "【", "《", "〔", "“"])("%s は行末に来ない", (ch) => {
    expect(isNoLineEnd(ch)).toBe(true);
  });

  test("閉じ括弧・句読点は行末に来てよい", () => {
    for (const ch of ["」", "。", "、", "あ"]) {
      expect(isNoLineEnd(ch)).toBe(false);
    }
  });

  test("かたまりは末尾の字で決める", () => {
    expect(isNoLineEnd("と「")).toBe(true);
    expect(isNoLineEnd("「と")).toBe(false);
  });
});

describe("ぶら下げ", () => {
  test("句読点だけがぶら下がる", () => {
    for (const ch of ["、", "。", "，", "．"]) expect(isHangable(ch)).toBe(true);
  });

  test("閉じ括弧はぶら下げない（前の字ごと次の行へ送る）", () => {
    for (const ch of ["」", "）", "！"]) expect(isHangable(ch)).toBe(false);
  });

  test("2字以上のかたまりはぶら下げない", () => {
    expect(isHangable("。。")).toBe(false);
  });

  test("ぶら下がる字は、どれも行頭禁則の字でもある", () => {
    // ぶら下げない設定のときに、行頭へ来てしまわないこと
    for (const ch of HANGABLE) expect(NO_LINE_START).toContain(ch);
  });

  test("開き括弧と閉じ括弧が混ざっていない", () => {
    for (const ch of NO_LINE_END) expect(NO_LINE_START).not.toContain(ch);
  });
});
