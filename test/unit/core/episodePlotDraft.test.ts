import { describe, expect, test } from "vitest";
import {
  episodePlotDraft,
  outlineNeedsEpisodeLength,
} from "../../../src/core/episodePlotDraft";

/**
 * あらすじのうち、その話に当たる所の決め方（設計書6.36.2。作者の裁定
 * 2026-09-27）。作る口を動かす確かめは `features/episodePlotCreate.test.ts`。
 * ここは字数の読み方・境目・決められない形を細かく見る。
 */

const goal = (chars: number) => ({ chars, source: "goal" as const });

const acts = [
  "- 第一幕：着任（1.5万字）",
  "- 第二幕：調査（3万字）",
  "- 第三幕：対決（1.5万字）",
].join("\n");

describe("幕ごとのあらすじ", () => {
  test("話の字数の範囲に入る幕を引く", () => {
    expect(episodePlotDraft(acts, 1, goal(5000))?.lines).toEqual([
      "- 第一幕：着任（1.5万字）",
    ]);
    // 第3話は 10,001〜15,000字目。第一幕の終わりちょうど
    expect(episodePlotDraft(acts, 3, goal(5000))?.lines).toEqual([
      "- 第一幕：着任（1.5万字）",
    ]);
    expect(episodePlotDraft(acts, 9, goal(5000))?.lines).toEqual([
      "- 第二幕：調査（3万字）",
    ]);
    expect(episodePlotDraft(acts, 12, goal(5000))?.lines).toEqual([
      "- 第三幕：対決（1.5万字）",
    ]);
  });

  test("境目をまたぐ話は、またいだ幕を両方引く（片方に寄せない）", () => {
    // 1話 4,000字の第4話は 12,001〜16,000字目
    expect(episodePlotDraft(acts, 4, goal(4000))?.lines).toEqual([
      "- 第一幕：着任（1.5万字）",
      "- 第二幕：調査（3万字）",
    ]);
  });

  test("あらすじの字数を書き切った先の話には、何も引かない", () => {
    expect(episodePlotDraft(acts, 13, goal(5000))).toBeNull();
  });

  test("添え書きに、どこから・何字目として引いたかを書く", () => {
    const note = episodePlotDraft(acts, 4, goal(5000))?.note ?? "";
    expect(note).toBe(
      "（plot.md の「あらすじ」から、第4話に当たる幕を引きました。1話5,000字（作品の目標）として15,001〜20,000字目です。書き換えて使う下書きです）"
    );
    const average = episodePlotDraft(acts, 4, { chars: 5000, source: "average" });
    expect(average?.note).toContain("書いた話の平均");
  });

  test.each([
    ["1.5万字", 15000],
    ["15,000字", 15000],
    ["1万5千字", 15000],
    ["１５０００文字", 15000],
    ["5千字", 5000],
  ])("字数の書き方「%s」を読む", (written, chars) => {
    const outline = [`- 第一幕：着任（${written}）`, "- 第二幕：調査（1万字）"].join("\n");
    // 第一幕の最後の1字を含む話と、その次の話
    const per = 1000;
    expect(episodePlotDraft(outline, chars / per, goal(per))?.lines).toEqual([
      `- 第一幕：着任（${written}）`,
    ]);
    expect(episodePlotDraft(outline, chars / per + 1, goal(per))?.lines).toEqual([
      "- 第二幕：調査（1万字）",
    ]);
  });

  test("字数の無い幕が1つでも混じれば、決められない", () => {
    const outline = ["- 第一幕：着任（1.5万字）", "- 第二幕：調査"].join("\n");
    expect(outlineNeedsEpisodeLength(outline)).toBe(false);
    expect(episodePlotDraft(outline, 1, goal(5000))).toBeNull();
  });

  test("字数が範囲や2つ書かれた幕は、決められない", () => {
    expect(
      episodePlotDraft(["- 第一幕：着任（1〜1.5万字）"].join("\n"), 1, goal(5000))
    ).toBeNull();
    expect(
      episodePlotDraft(["- 第一幕：着任（1万字、うち回想3千字）"].join("\n"), 1, goal(5000))
    ).toBeNull();
  });

  test("1話の長さが分からなければ、決められない", () => {
    expect(outlineNeedsEpisodeLength(acts)).toBe(true);
    expect(episodePlotDraft(acts, 1, null)).toBeNull();
  });

  test("字下げした続きの行は、その幕と一緒に引く", () => {
    const outline = [
      "- 第一幕：着任（1万字）",
      "  - 配管の異音",
      "  - 班長の沈黙",
      "- 第二幕：調査（1万字）",
    ].join("\n");
    expect(episodePlotDraft(outline, 1, goal(5000))?.lines).toEqual([
      "- 第一幕：着任（1万字）",
      "  - 配管の異音",
      "  - 班長の沈黙",
    ]);
  });
});

describe("話ごとのあらすじ", () => {
  const perEpisode = [
    "- 第1話：着任",
    "- 第2〜4話：異音の調査",
    "- 第五話：通信途絶",
    "- 第6話〜第7話：対決",
  ].join("\n");

  test("その話を含む行を引く（範囲・漢数字も）", () => {
    expect(episodePlotDraft(perEpisode, 1, null)?.lines).toEqual(["- 第1話：着任"]);
    expect(episodePlotDraft(perEpisode, 3, null)?.lines).toEqual([
      "- 第2〜4話：異音の調査",
    ]);
    expect(episodePlotDraft(perEpisode, 5, null)?.lines).toEqual([
      "- 第五話：通信途絶",
    ]);
    expect(episodePlotDraft(perEpisode, 7, null)?.lines).toEqual([
      "- 第6話〜第7話：対決",
    ]);
  });

  test("1話の長さは要らない（本文を走査しない）", () => {
    expect(outlineNeedsEpisodeLength(perEpisode)).toBe(false);
  });

  test("書いていない話には、何も引かない", () => {
    expect(episodePlotDraft(perEpisode, 8, null)).toBeNull();
  });

  test("文中の「第3話」は、その話のあらすじとみなさない", () => {
    const outline = "- 第一幕：第3話で張った伏線を回収する";
    expect(episodePlotDraft(outline, 3, goal(5000))).toBeNull();
  });
});

describe("決められないあらすじ", () => {
  test("空・文章だけのあらすじには、何も引かない", () => {
    expect(episodePlotDraft("", 1, goal(5000))).toBeNull();
    expect(
      episodePlotDraft("灯は氷の街で配管の異音を追う。", 1, goal(5000))
    ).toBeNull();
  });

  test("話数が0や負なら、何も引かない", () => {
    expect(episodePlotDraft(acts, 0, goal(5000))).toBeNull();
  });
});
