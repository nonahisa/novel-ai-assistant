import { describe, expect, test } from "vitest";
import {
  selectGuideBundles,
  type GuideBundle,
} from "../../src/core/guideSelect";

/*
  **実物の束（`buildGuideBundles()`）は使わない。** 実物は機能を足すたびに
  中身が変わるので、それを材料にすると「選び方が壊れたのか、メニューが
  変わっただけなのか」が見分けられなくなる。ここでは選び方だけを見る。

  並びは「メニュー順」の代わり。この配列の順が画面の順だと思って読む。
*/
const BUNDLES: GuideBundle[] = [
  {
    key: "proof",
    label: "執筆AI支援 → 校正・校閲",
    text: [
      "■ 執筆AI支援 → 校正・校閲",
      "  - 誤字脱字を検知: 本文の誤字脱字を探します。",
      "  - 表記ゆれを検知: 表記のゆれを探します。",
    ].join("\n"),
  },
  {
    key: "other",
    label: "執筆AI支援 → その他支援",
    text: [
      "■ 執筆AI支援 → その他支援",
      "  - ルビを振る: 漢字にルビを振ります。",
      "  - 迷ったとき: どうすればいいか案内します。",
    ].join("\n"),
  },
  {
    key: "extract",
    label: "資料管理 → 資料抽出",
    text: [
      "■ 資料管理 → 資料抽出",
      "  - 登場人物を抽出: 本文から登場人物を取り出します。",
    ].join("\n"),
  },
];

function totalLength(bundles: GuideBundle[]): number {
  return bundles.reduce((sum, bundle) => sum + bundle.text.length, 0);
}

describe("使い方の説明を選ぶ", () => {
  test("機能名で聞かれたら、その束を選ぶ", () => {
    const result = selectGuideBundles({
      question: "誤字脱字はどこから実行しますか",
      bundles: BUNDLES,
    });

    expect(result.reason).toBe("matched");
    expect(result.selected[0].key).toBe("proof");
  });

  test("本文の相談では、説明を送らない", () => {
    // **ここが節約の本体である。** 作品の相談に使い方の説明は要らない。
    // 目次（名前だけ）は呼び出し側が常に付けるので、機能を隠すことにはならない
    const result = selectGuideBundles({
      question: "この段落の描写は冗長ですか？",
      bundles: BUNDLES,
    });

    expect(result.selected).toEqual([]);
    expect(result.reason).toBe("none");
  });

  test("漠然と使い方を聞かれたら、メニュー順に渡す", () => {
    // 機能名が1つも出てこない聞き方。ここで何も渡さないと、
    // 名前だけを見て答えることになり、案内が薄くなる
    const result = selectGuideBundles({
      question: "使い方を教えて",
      bundles: BUNDLES,
    });

    expect(result.reason).toBe("usage");
    expect(result.selected.map((bundle) => bundle.key)).toEqual([
      "proof",
      "other",
      "extract",
    ]);
  });

  test("ひらがなだけの組みでは当たったことにしない", () => {
    /*
      「どうすれば」「ますか」のような助詞・活用は**どの束にも当たる**ので、
      絞り込みにならない。ここでは「どうすればいいか案内します」を含む束を
      わざと置いてあり、捨てていなければ `matched` になってしまう。
    */
    const result = selectGuideBundles({
      question: "これはどうすればいいですか",
      bundles: BUNDLES,
    });

    expect(result.reason).not.toBe("matched");
    expect(result.reason).toBe("usage");
  });

  test("上限を超えて渡さない", () => {
    const budget = BUNDLES[0].text.length + 5;
    const result = selectGuideBundles({
      question: "誤字脱字とルビと登場人物について",
      bundles: BUNDLES,
      budget,
    });

    expect(result.selected.length).toBeGreaterThan(0);
    expect(totalLength(result.selected)).toBeLessThanOrEqual(budget);
  });

  test("追い質問では、直前の作者の発言から話題を継ぐ", () => {
    // 「それはどこ？」だけでは何の話か分からない。話題は前の発言が持っている
    const result = selectGuideBundles({
      question: "それはどこ？",
      recentAuthorTurns: ["ルビを振りたい"],
      bundles: BUNDLES,
    });

    expect(result.reason).toBe("matched");
    expect(result.selected.map((bundle) => bundle.key)).toContain("other");
  });

  test("当たりの多い束を先に置く", () => {
    // 予算に収まらないときに削られるのは後ろなので、順序が意味を持つ。
    // 「資料抽出」はメニュー順では最後だが、当たりが多いので先に来る
    const result = selectGuideBundles({
      question: "登場人物を抽出したいのと、誤字が気になる",
      bundles: BUNDLES,
    });

    expect(result.reason).toBe("matched");
    expect(result.selected[0].key).toBe("extract");
    expect(result.selected.map((bundle) => bundle.key)).toContain("proof");
  });
});
