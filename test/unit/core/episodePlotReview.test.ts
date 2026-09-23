import { describe, expect, test } from "vitest";
import {
  EPISODE_PLOT_REVIEW_KIND,
  renderEpisodePlotReview,
} from "../../../src/core/episodePlotReview";
import { episodePlotReviewTail } from "../../../src/core/episodePlotDoc";

/**
 * 単話プロットの検査（P-27）の講評の紙（プロンプト設計書1.9）。
 *
 * 作者の方針（2026-09-24）：「無理に助言を言わなくてもいい。ほめることが
 * できる場所は、省略せずきちんとほめて」。
 */
describe("単話プロットの講評の紙", () => {
  test("指摘0件なら「見当たりません」と書き、良いところを先に全部並べる", () => {
    const markdown = renderEpisodePlotReview({
      chapterLabel: "第3話",
      strengths: [
        { quote: "形見の懐中時計を見つける", why: "目標の手がかりが早めに置かれている" },
        { quote: "老人が訪ねてくる", why: "外から話を動かしている" },
      ],
      strengthsDropped: 0,
      findingCount: 0,
    });
    expect(markdown.startsWith(`# ${EPISODE_PLOT_REVIEW_KIND}：第3話`)).toBe(true);
    expect(markdown).toContain("直すべき所は見当たりません");
    expect(markdown).toContain("形見の懐中時計を見つける");
    expect(markdown).toContain("外から話を動かしている");
    expect(markdown.indexOf("## 効いている展開")).toBeLessThan(
      markdown.indexOf("## 直すべき所")
    );
    // 画面の文字列に強調の記号を入れない
    expect(markdown).not.toContain("**");
  });

  test("指摘があれば件数と、どこに並べたかを書く", () => {
    const markdown = renderEpisodePlotReview({
      chapterLabel: "第3話",
      strengths: [{ quote: "老人が訪ねてくる", why: "理由" }],
      strengthsDropped: 2,
      findingCount: 2,
    });
    expect(markdown).toContain("2件");
    expect(markdown).toContain("提案パネル");
    expect(markdown).not.toContain("見当たりません");
    // 落としたほめ言葉の数を黙らない
    expect(markdown).toContain("箇条書きに無い行をほめていた 2件");
  });

  test("完了の知らせ：指摘0件なら見当たらないと書く（失敗したときは書かない）", () => {
    expect(episodePlotReviewTail({ findingCount: 0, failed: false })).toContain(
      "直すべき所は見当たりません"
    );
    expect(episodePlotReviewTail({ findingCount: 0, failed: true })).toBe("");
    expect(episodePlotReviewTail({ findingCount: 2, failed: false })).toContain(
      "プロットは書き換えていません"
    );
  });
});
