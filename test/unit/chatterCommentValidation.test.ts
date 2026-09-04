import { describe, expect, test } from "vitest";
import {
  CHATTER_COMMENT_MAX_CHARS,
  validateChatterComment,
} from "../../src/core/chatterCommentValidation";

/**
 * 本文を読んで言う一言の検査（設計書6.21.4、P-34）。
 *
 * **通す条件より、捨てる条件のほうが大事である。** ここで捨てそこねた
 * ものは、作者が頼んでもいないのに相談パネルへ出る。読めない答えを
 * 出すくらいなら黙るのが正しい。
 */
describe("通すもの", () => {
  test("短い感想はそのまま通る", () => {
    expect(validateChatterComment("戦闘の緊張感が伝わってきます。")).toBe(
      "戦闘の緊張感が伝わってきます。"
    );
  });

  test("前後の空白は落とす", () => {
    expect(validateChatterComment("  盛り上がってきましたね！  ")).toBe(
      "盛り上がってきましたね！"
    );
  });

  test("改行は空白へ畳む", () => {
    // 独り言は1行で出る。改行が残ると表示が崩れる
    expect(
      validateChatterComment("静かな場面ですね。\n続きが気になります。")
    ).toBe("静かな場面ですね。 続きが気になります。");
  });

  test("「一言」を含む感想は、指示語のなぞりと区別する", () => {
    // 「最後の一言が…」は本文についての感想であって、指示のなぞりではない
    expect(validateChatterComment("最後の一言が効いています。")).toBe(
      "最後の一言が効いています。"
    );
  });

  test("続きが気になる、は応援として通す", () => {
    // 「気になります」は指摘の形に見えるが、この言い回しは応援である
    expect(validateChatterComment("続きが気になります！")).toBe(
      "続きが気になります！"
    );
  });
});

describe("捨てるもの", () => {
  test("空なら捨てる", () => {
    expect(validateChatterComment("")).toBeUndefined();
    expect(validateChatterComment("   \n  ")).toBeUndefined();
  });

  test("長すぎる答えは捨てる（縮めない）", () => {
    // **切り詰めない。** 60字で切ると文が途中で終わり、
    // 独り言としていちばん間の抜けた出方になる
    const long = "あ".repeat(CHATTER_COMMENT_MAX_CHARS + 1);

    expect(validateChatterComment(long)).toBeUndefined();
    expect(validateChatterComment("あ".repeat(CHATTER_COMMENT_MAX_CHARS))).toBe(
      "あ".repeat(CHATTER_COMMENT_MAX_CHARS)
    );
  });

  test("指示語のなぞりは捨てる", () => {
    // プロンプトに書いた語は、そのまま答えとして返ってくる
    expect(validateChatterComment("感想")).toBeUndefined();
    expect(validateChatterComment("一言")).toBeUndefined();
    expect(validateChatterComment("コメント")).toBeUndefined();
    expect(validateChatterComment("（感想）")).toBeUndefined();
    expect(validateChatterComment("感想：面白いです。")).toBeUndefined();
  });

  test("中身の無い言葉は捨てる", () => {
    expect(validateChatterComment("なし")).toBeUndefined();
    expect(validateChatterComment("特になし")).toBeUndefined();
    expect(validateChatterComment("空文字")).toBeUndefined();
  });

  test("誤字・矛盾の指摘は捨てる", () => {
    // 粗探しは既存の検知機能の仕事である。書いた直後に言われると興が削がれる
    expect(
      validateChatterComment("2行目に誤字があります。")
    ).toBeUndefined();
    expect(
      validateChatterComment("前の話と矛盾しているように見えます。")
    ).toBeUndefined();
    expect(
      validateChatterComment("表記ゆれが目立ちます。")
    ).toBeUndefined();
  });

  test("助言の形は捨てる", () => {
    expect(
      validateChatterComment("地の文を直したほうが読みやすくなります。")
    ).toBeUndefined();
    expect(
      validateChatterComment("もう少し情景を描写すべきです。")
    ).toBeUndefined();
    expect(
      validateChatterComment("会話を増やすといいと思います。")
    ).toBeUndefined();
    expect(
      validateChatterComment("ここは書き直してみてはどうでしょう。")
    ).toBeUndefined();
  });
});
