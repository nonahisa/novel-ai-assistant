import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/**
 * ［▶ 読む］の計画に、読む範囲（題と本文）を添えて送る（2026-11-08 作者の答え。設計書6.42）。
 *
 * 画面はこの範囲で「カーソルが飛ばす欄の中か」を見る。OSの声・人物の声・
 * 人物の声が使えなかったときの3つの返し方のどれかで落とすと、その道だけ
 * 後書きの中から読み始めたとき最後の文に飛ぶ。
 */
const source = readFileSync("src/features/manuscriptEditor.ts", "utf8");

describe("読み上げの計画に読む範囲を添える", () => {
  it("範囲は画面が送ってきた字から求める", () => {
    expect(source).toContain("const readable = readingRangesOf(message.text);");
  });

  it("3つの返し方のすべてに readable がある", () => {
    const start = source.indexOf('case "readingPlan": {');
    const end = source.indexOf('case "voiceAudio": {', start);
    const block = source.slice(start, end);
    const replies = block.split('type: "readingPlan",').slice(1);
    expect(replies).toHaveLength(3);
    for (const reply of replies) {
      expect(reply.slice(0, reply.indexOf("});"))).toContain("readable,");
    }
  });
});
