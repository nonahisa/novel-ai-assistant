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
    key: "writing",
    label: "執筆AI支援 → 原稿づくり",
    text: [
      "■ 執筆AI支援 → 原稿づくり",
      "  - ルビを振る: 漢字にルビを振ります。",
      // **漢字の名前の操作を1つ置いてある。** 当たりの材料は漢字と英字
      // だけなので、カタカナの名前（ルビ）しか無い束は選びようがない
      "  - 縦書きで開く: 本文を縦書きの画面で開き直します。",
      "  - 迷ったとき: どうすればいいか案内します。",
    ].join("\n"),
  },
  {
    key: "posting",
    label: "執筆AI支援 → 投稿・書き出し",
    text: [
      "■ 執筆AI支援 → 投稿・書き出し",
      "  - 新話を投稿する: 未投稿の話を投稿ページまで案内します。",
      "  - EPUBを書き出す: 本文を電子書籍に組みます。",
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

  test("漠然と使い方を聞かれても、束は渡さない（目次だけで答えさせる）", () => {
    /*
      機能名が1つも出てこない聞き方。以前はメニュー順に束を渡していたが、
      先頭は作品管理→GitHubで、質問と関係の無い説明が付くだけだった。
      目次に全操作の名前があるので、目次だけで答えさせる（作者の指定、
      2026-08-29）。
    */
    const result = selectGuideBundles({
      question: "使い方を教えて",
      bundles: BUNDLES,
    });

    expect(result.reason).toBe("none");
    expect(result.selected).toEqual([]);
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

    expect(result.reason).toBe("none");
    expect(result.selected).toEqual([]);
  });

  test("句読点や記号を含む組みでは当たったことにしない", () => {
    /*
      **実データでいちばんひどかった当たり方**（2026-09-11の測定）。
      「す。」の1組みだけで9束（約3,000字）が選ばれていた。句読点は
      説明の本文に必ず出てくるので、話題の証拠にならない。
    */
    const result = selectGuideBundles({
      question: "主人公の動機が弱い気がします。どう思いますか",
      bundles: BUNDLES,
    });

    expect(result.selected).toEqual([]);
    expect(result.reason).toBe("none");
  });

  test("漢字とかなが混ざった組みでも当たったことにしない", () => {
    // 「の場」「面の」のような組みは、助詞を挟むどんな文にも入る。
    // 「場面」「描写」だけが残り、それぞれ1個なので採らない
    const result = selectGuideBundles({
      question: "この場面の描写、もっと良くできますか",
      bundles: BUNDLES,
    });

    expect(result.selected).toEqual([]);
    expect(result.reason).toBe("none");
  });

  test("当たりが1個の束は採らない", () => {
    /*
      束はどれも数百字あるので、2文字が1組み当たるのは偶然と区別できない。
      「本文」は「登場人物を抽出」の説明にも出てくるが、それだけで
      資料抽出の説明を送る理由にはならない。
    */
    const result = selectGuideBundles({
      question: "この本文をどう思いますか",
      bundles: BUNDLES,
    });

    expect(result.selected).toEqual([]);
    expect(result.reason).toBe("none");
  });

  test("英字の機能名（EPUB）は当たりの材料に残す", () => {
    // 漢字だけに絞ると EPUB・PDF・IME が拾えなくなる。英字の組みは残す
    const result = selectGuideBundles({
      question: "EPUBに書き出すには",
      bundles: BUNDLES,
    });

    expect(result.selected.map((bundle) => bundle.key)).toEqual(["posting"]);
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
      recentAuthorTurns: ["縦書きで本文を開きたい"],
      bundles: BUNDLES,
    });

    expect(result.reason).toBe("matched");
    expect(result.selected.map((bundle) => bundle.key)).toContain("writing");
  });

  /*
    **割った2つの束の名前が、互いの当たりにならないこと**（0.33.8）。

    選び方は文字2つ組みの一致なので、**見出しの名前そのものも材料になる。**
    「その他支援」を「原稿づくり」と「投稿・書き出し」に割ったとき、
    片方の質問で両方が返るようだと、割っても送る量が減らない
    ——分けた意味がそこで消える。
  */
  test("割った2つの束は、互いに引っぱり合わない", () => {
    const posting = selectGuideBundles({
      question: "新話を投稿するにはどうしますか",
      bundles: BUNDLES,
    });
    expect(posting.selected.map((bundle) => bundle.key)).toEqual(["posting"]);

    const writing = selectGuideBundles({
      question: "縦書きで本文を開きたい",
      bundles: BUNDLES,
    });
    expect(writing.selected.map((bundle) => bundle.key)).toEqual(["writing"]);
  });

  test("当たりの多い束を先に置く", () => {
    // 予算に収まらないときに削られるのは後ろなので、順序が意味を持つ。
    // 「資料抽出」はメニュー順では最後だが、当たりが多いので先に来る
    const result = selectGuideBundles({
      question: "本文から登場人物を抽出したいのと、誤字脱字が気になる",
      bundles: BUNDLES,
    });

    expect(result.reason).toBe("matched");
    expect(result.selected[0].key).toBe("extract");
    expect(result.selected.map((bundle) => bundle.key)).toContain("proof");
  });
});
