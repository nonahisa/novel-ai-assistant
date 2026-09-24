import { describe, expect, test } from "vitest";
import {
  maskQuoted,
  quotedSpans,
  removeQuoted,
} from "../../../src/core/quotedSpans";

/**
 * 台詞の範囲の見分け（2026-09-25、人称のよじれの2回目）。
 *
 * それまで3か所が `[「『][^」』]*[」』]` で台詞を見ていて、「…『死の谷』…」の
 * 』で台詞が閉じたと見ていた（作者の作品で、台詞の残りの名前を地の文として拾った）。
 */

describe("入れ子のかぎ", () => {
  test("「」の中の『』では、外の台詞は閉じない", () => {
    const text = "「父は『死の谷』の奥地にいる。相沢は休め」と言った。";
    expect(removeQuoted(text)).toBe("と言った。");
  });

  test("『』だけの台詞も台詞として見る", () => {
    expect(removeQuoted("『相沢は来ない』と書いてあった。")).toBe("と書いてあった。");
  });

  test("台詞の中の『』が閉じたあとも、外の」までは台詞", () => {
    const text = "地の文「『谷』だ。まだ台詞」地の文";
    expect(quotedSpans(text)).toEqual([{ start: 3, end: 14 }]);
    expect(text.slice(3, 14)).toBe("「『谷』だ。まだ台詞」");
  });

  test("2つの台詞は別々の範囲になる", () => {
    const text = "「あ」と「い」";
    expect(quotedSpans(text)).toEqual([
      { start: 0, end: 3 },
      { start: 4, end: 7 },
    ]);
  });
});

describe("閉じ忘れと書き違い", () => {
  test("閉じ忘れの台詞は、次の「の手前で終わったと見る（その先を飲み込まない）", () => {
    const text = "「来ないのか\n「来ない」\n　相沢は黙った。";
    expect(removeQuoted(text)).toBe("\n　相沢は黙った。");
  });

  test("最後まで閉じない台詞は、既定では本文の終わりまでを台詞と見る", () => {
    expect(removeQuoted("地の文「台詞が切れた")).toBe("地の文");
  });

  test("unclosedToEnd: false なら、最後の閉じない台詞は台詞と見ない", () => {
    expect(removeQuoted("地の文「台詞が切れた", { unclosedToEnd: false })).toBe(
      "地の文「台詞が切れた"
    );
  });

  test("対応しない閉じ括弧（「…』）は、いちばん内側を閉じる", () => {
    expect(removeQuoted("「あ』と言った。")).toBe("と言った。");
  });

  test("開いていないのに現れた閉じ括弧は見ない（台詞の途中から切り出した本文の頭）", () => {
    expect(removeQuoted("だ」と言った。「うん」")).toBe("だ」と言った。");
  });
});

describe("伏せ方", () => {
  test("長さと改行を保ったまま伏せる", () => {
    const text = "a「い\nろ『は』」b";
    const masked = maskQuoted(text, "　");
    expect(masked).toHaveLength(text.length);
    expect(masked).toBe("a　　\n　　　　　b");
  });

  test("代用対（サロゲートペア）も長さを変えない", () => {
    const text = "「𠮷野」だ";
    expect(maskQuoted(text, " ")).toHaveLength(text.length);
    expect(maskQuoted(text, " ").endsWith("だ")).toBe(true);
  });

  test("台詞が無ければそのまま返す", () => {
    expect(maskQuoted("地の文だけ。", " ")).toBe("地の文だけ。");
  });
});
