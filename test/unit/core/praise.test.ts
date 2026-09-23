import { describe, expect, test } from "vitest";
import {
  isNoAdviceFiller,
  PRAISE_MAX_ITEMS,
  praiseQuoteIsVerbatim,
  readGroundedPraise,
  verbatimIn,
} from "../../../src/core/praise";

/**
 * ほめる欄と助言0件の扱い（プロンプト設計書1.9）。
 *
 * 見るのは3つ。
 *
 * 1. **本文に無い引用のほめ言葉を通さない**（規則3）——前半だけ本物の引用も
 * 2. **件数で良い所を切らない**
 * 3. **「特になし」のような埋め草を助言1件として並べない**（失敗3）
 */

const source =
  "　九月の終わりの空は、まだ夏の色を残していた。\n" +
  "「相沢くん、水筒」\n" +
  "　窓口の内側から黒瀬千夏が身を乗り出して、青い水筒を差し出してきた。";

describe("引用の照合", () => {
  test("逐語の引用は通す（空白・括弧の揺れは許す）", () => {
    expect(praiseQuoteIsVerbatim("九月の終わりの空は、まだ夏の色を残していた", source)).toBe(true);
    expect(praiseQuoteIsVerbatim("「相沢くん、水筒」", source)).toBe(true);
    expect(praiseQuoteIsVerbatim("窓口の内側から 黒瀬千夏が", source)).toBe(true);
  });

  test("本文に無い文は通さない", () => {
    expect(praiseQuoteIsVerbatim("十月の空は冬の色だった", source)).toBe(false);
  });

  test("前半だけ本物で後半が作文の引用は通さない（断片のすべてを見る）", () => {
    expect(
      praiseQuoteIsVerbatim("まだ夏の色を残していた。そして雪が降り始めた", source)
    ).toBe(false);
  });

  test("1字だけの引用はほめる根拠として認めない", () => {
    expect(praiseQuoteIsVerbatim("空", source)).toBe(false);
  });
});

describe("ほめる欄の読み取り", () => {
  test("照合を通ったものだけ残し、落とした件数を数える", () => {
    const result = readGroundedPraise(
      [
        { quote: "青い水筒を差し出してきた", why: "仕草で人柄が見える" },
        { quote: "赤い傘を差し出してきた", why: "作文" },
        { quote: "特になし", why: "なし" },
        { quote: "九月の終わりの空", why: "" },
        "形が違う",
      ],
      verbatimIn(source)
    );
    expect(result.items).toEqual([
      { quote: "青い水筒を差し出してきた", why: "仕草で人柄が見える" },
    ]);
    expect(result.notFound).toBe(1);
    expect(result.empty).toBe(3);
  });

  test("件数で切らない（上限は十分に大きい）", () => {
    expect(PRAISE_MAX_ITEMS).toBeGreaterThanOrEqual(20);
    const lines = Array.from({ length: 15 }, (_, index) => `良い文その${index}がある。`);
    const result = readGroundedPraise(
      lines.map((line) => ({ quote: line, why: "理由" })),
      verbatimIn(lines.join("\n"))
    );
    expect(result.items).toHaveLength(15);
  });

  test("同じ箇所の二重のほめ言葉は1つにまとめる", () => {
    const result = readGroundedPraise(
      [
        { quote: "「相沢くん、水筒」", why: "一言で関係が分かる" },
        { quote: "相沢くん、水筒", why: "言い直し" },
      ],
      verbatimIn(source)
    );
    expect(result.items).toHaveLength(1);
    expect(result.items[0].why).toBe("一言で関係が分かる");
  });

  test("欄の名前を差し替えられる（単話プロットの item など）", () => {
    const result = readGroundedPraise(
      [{ item: "青い水筒を差し出してきた", why: "理由" }],
      verbatimIn(source),
      { quote: "item", why: "why" }
    );
    expect(result.items).toHaveLength(1);
  });

  test("配列でなければ空", () => {
    expect(readGroundedPraise(undefined, verbatimIn(source)).items).toEqual([]);
    expect(readGroundedPraise("良い", verbatimIn(source)).items).toEqual([]);
  });
});

describe("助言0件の埋め草", () => {
  test("指示語・言い切りの「無い」は埋め草", () => {
    for (const text of [
      "",
      "なし",
      "特になし",
      "空文字",
      "（空）",
      "ありません",
      "問題ありません。",
      "指摘はありません",
      "直すべき所は見当たりません",
      "直すべき点は特にありません。",
      "改善点はありません",
      "「特になし」",
    ]) {
      expect(isNoAdviceFiller(text), text).toBe(true);
    }
  });

  test("続きのある本物の助言は埋め草ではない", () => {
    for (const text of [
      "第3話の引きが弱めです。",
      "直すべき所はほぼ見当たりませんが、第3話の引きが弱めに読めます。",
      "「なぜ」が伝わっていない。",
    ]) {
      expect(isNoAdviceFiller(text), text).toBe(false);
    }
  });
});
