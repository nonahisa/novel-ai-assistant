import { describe, expect, it } from "vitest";
import { buildFeatureGuideForQuestion } from "../../../src/features/featureGuide";

/**
 * 相談で「ルビを振りたい」と聞いたとき、束「原稿づくり」の説明が渡るか
 * （設計書6.17。実機確認リスト F-90「分割の効き」を機械で見ようとしたもの）。
 *
 * ## 分かったこと（2026-09-25、再現テスト。製品は直していない）
 *
 * **渡らない。しかも目次（全操作の名前）ごと落ちる。**
 *
 * - 束選び（`core/guideSelect.ts`）が当たりの材料にするのは**漢字だけ・英字
 *   だけの2文字組み**で、「ルビを振りたい」は漢字が「振」1字しかないので
 *   どの束にも当たらない（`guideSelect.test.ts` の材料の注記にも
 *   「カタカナの名前（ルビ）しか無い束は選びようがない」とある）
 * - 束に当たらず、操作を尋ねる言い回し（どうやって・ボタン…）も無いので、
 *   話題の見分け（`core/chatTopic.ts`）が**創作の相談（`craft`）**と
 *   言い切る。`craft` の回は目次を送らない
 * - 束選びの注記は「カタカナの名前は目次に載っているので、名前そのものは
 *   失わない」と書いているが、**その目次がこの回は落ちている**。AIの手元に
 *   ルビの操作の名前が1つも無いまま答えることになる
 *
 * 「傍点を付けたい」も同じ（`craft`・束なし）。「カクヨムのバックアップ」は
 * 同じ形で踏んで、言い回しの一覧へ語を足して逃がしてある（`chatTopic.ts`）。
 *
 * 直すか、直すならどこで（言い回しの一覧に機能名のカタカナを足す／束選びで
 * カタカナの機能名を拾う／`craft` でも目次を残す）はリーダーの判断に回す。
 * 直ったら `it.fails` を `it` に戻す。
 */
describe("カタカナの機能名だけで聞かれた相談", () => {
  it.fails("「ルビを振りたい」で、束「原稿づくり」の説明が渡る", () => {
    const guide = buildFeatureGuideForQuestion({ question: "ルビを振りたい" });

    expect(guide.selected.some((label) => label.includes("原稿づくり"))).toBe(
      true
    );
  });

  it.fails("「ルビを振りたい」を、創作の相談と言い切らない（目次を落とさない）", () => {
    const guide = buildFeatureGuideForQuestion({ question: "ルビを振りたい" });

    expect(guide.topic).not.toBe("craft");
  });

  it("操作を尋ねる言い回しが付けば、目次は渡る（いまの逃げ道）", () => {
    // 「どうすれば」が付くと `unknown` に倒れ、目次は送られる。
    // 上の2つとの違いは言い回しだけ——作者の聞き方しだいで答えられなくなる
    const guide = buildFeatureGuideForQuestion({
      question: "ルビを振りたいです。どうすればいいですか",
    });

    expect(guide.topic).toBe("unknown");
  });
});
