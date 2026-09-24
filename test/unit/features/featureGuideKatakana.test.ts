import { describe, expect, it } from "vitest";
import {
  buildFeatureGuideForQuestion,
  buildGuideBundles,
} from "../../../src/features/featureGuide";
import { FEATURE_NAME_TERMS } from "../../../src/core/guideSelect";

/**
 * 相談で「ルビを振りたい」と聞いたとき、束「原稿整備」の説明が渡るか
 * （設計書6.17・6.27.9。実機確認リスト F-90「分割の効き」を機械で見ようとしたもの）。
 *
 * ## 分かったこと（2026-09-25、再現テスト）
 *
 * **渡らなかった。しかも目次（全操作の名前）ごと落ちていた。**
 *
 * - 束選び（`core/guideSelect.ts`）が当たりの材料にするのは**漢字だけ・英字
 *   だけの2文字組み**で、「ルビを振りたい」は漢字が「振」1字しかないので
 *   どの束にも当たらない
 * - 束に当たらず、操作を尋ねる言い回し（どうやって・ボタン…）も無いので、
 *   話題の見分け（`core/chatTopic.ts`）が**創作の相談（`craft`）**と
 *   言い切る。`craft` の回は目次を送らない
 *
 * 同じ日の実接続の測定（引継ぎ書8章「2026-09-25 深夜（2巡目）」）では、
 * 「音声読み上げはある？」が `craft` になり、目次に「原稿読み上げ（音読推敲）」が
 * あるのに、AIが「この拡張機能には備わっておりません」と答えた。
 *
 * ## 直し方（2026-09-25）
 *
 * ①束選びで**機能の名前**（ルビ・傍点・読み上げ…）を、それだけで当たりと
 * 見なす（`FEATURE_NAME_TERMS`）。②「〜する機能はある？」のような**機能を
 * 尋ねる言い回し**を、操作を尋ねる言い回しに足す（`chatTopic.ts`）。
 *
 * 束の名前は、このテストを書いたときの「原稿づくり」から 0.79.0 以降
 * 「作品執筆 → 原稿整備」になっている（中身は同じ束）。
 */
describe("カタカナの機能名だけで聞かれた相談", () => {
  it("「ルビを振りたい」で、束「原稿整備」の説明が渡る", () => {
    const guide = buildFeatureGuideForQuestion({ question: "ルビを振りたい" });

    expect(guide.selected).toContain("作品執筆 → 原稿整備");
  });

  it("「ルビを振りたい」を、創作の相談と言い切らない（目次を落とさない）", () => {
    const guide = buildFeatureGuideForQuestion({ question: "ルビを振りたい" });

    expect(guide.topic).not.toBe("craft");
    expect(guide.text).toContain("ルビ付与");
  });

  it("操作を尋ねる言い回しが付いても、目次は渡る", () => {
    // 以前はここだけが逃げ道だった（「どうすれば」で `unknown` に倒れる）。
    // いまは名前で束に当たるので、説明まで付いて `howto` になる
    const guide = buildFeatureGuideForQuestion({
      question: "ルビを振りたいです。どうすればいいですか",
    });

    expect(guide.topic).not.toBe("craft");
    expect(guide.text).toContain("ルビ付与");
  });
});

/**
 * 実接続の測定で `craft` に倒れた問い（2026-09-25 深夜）と、同じ形の問い。
 * **どれも目次が渡らないと答えられない**——名前は目次にしか無い。
 */
describe("機能の名前・機能を尋ねる言い回しで、目次が渡る", () => {
  const cases: Array<{ question: string; expectName: string }> = [
    { question: "傍点を付けたい", expectName: "傍点付与" },
    { question: "音声読み上げはある？", expectName: "原稿読み上げ" },
    { question: "縦書きで読みたい", expectName: "縦書き表示" },
    // 名前は目次に無い（翻訳は無い機能）。**無いと答えるにも目次が要る**
    { question: "英語に翻訳する機能はある？", expectName: "詳細メニューの操作" },
    { question: "挿絵を描いてくれる機能ってありますか", expectName: "詳細メニューの操作" },
  ];

  for (const { question, expectName } of cases) {
    it(`「${question}」`, () => {
      const guide = buildFeatureGuideForQuestion({ question });

      expect(guide.topic, question).not.toBe("craft");
      expect(guide.text, question).toContain(expectName);
    });
  }
});

/**
 * **反対側も測る。** 機能の名前や言い回しを緩めた結果、創作の相談まで
 * 目次を持つようになったら、節約（設計書6.27.9）が消える。
 */
describe("創作の相談は、これまでどおり目次を送らない", () => {
  const craftQuestions = [
    // 「〜したい」「どうしたい」を言い回しに入れていないこと
    "主人公の性格をどうしたい？",
    "もっと緊張感を出したい",
    "ラストを書き直したい",
    // 「〜はありますか」を言い回しに入れていないこと（講評の問いそのもの）
    "この話に改善点はありますか",
    "この場面に違和感はある？",
    // 「できる？」を入れていないこと
    "この場面、もっと良くできる？",
    // 「〜ってある？」を入れていないこと（「張ってある」と見分けられない）
    "伏線は張ってある？",
    // 「機能」の語だけでは操作の相談にしない（作品の中の働きの話）。
    // 「伏線が機能して…」は「伏線」「機能」の2組みが束「伏線・矛盾」に当たる
    // （以前から `howto`。言い回しの側の話ではない）ので、ここでは比喩で見る
    "この比喩はちゃんと機能していますか",
    // 名前の一部が機能名と同じ人物（「ルビ」）。前後がカタカナなら名前の一部
    "ルビーの性格はぶれていませんか",
    // 「プロット」は作品の相談で最もよく出る語なので、機能名として拾わない
    "プロットの流れはどう思う？",
  ];

  for (const question of craftQuestions) {
    it(`「${question}」は craft`, () => {
      const guide = buildFeatureGuideForQuestion({ question });

      expect(guide.topic, question).toBe("craft");
      expect(guide.selected, question).toEqual([]);
    });
  }
});

describe("機能の名前の一覧（FEATURE_NAME_TERMS）", () => {
  it("どの語も、どれかの束の本文に出てくる", () => {
    // 束に無い語は当てる先が無く、一覧に置いても何も起きない。
    // 操作の名前を変えた日に、ここで気づけるようにする
    const text = buildGuideBundles()
      .map((bundle) => bundle.text)
      .join("\n");
    const missing = FEATURE_NAME_TERMS.filter((term) => !text.includes(term));

    expect(missing).toEqual([]);
  });

  it("作品の相談で普通に使うカタカナは入れない", () => {
    // 2026-09-11 にカタカナを捨てた理由そのもの（`guideSelect.ts`）
    for (const word of ["プロット", "タイトル", "テーマ", "シーン", "キャラ", "スキル"]) {
      expect(FEATURE_NAME_TERMS, word).not.toContain(word);
    }
  });
});
