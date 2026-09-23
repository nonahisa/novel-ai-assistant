import { describe, expect, test } from "vitest";
import {
  collectMentionExcerpts,
  sampleEvenly,
} from "../../src/core/mentionExcerpts";

function episode(label: string, lines: string[]) {
  return { label, text: lines.join("\n") };
}

describe("本文からの言及抜き出し", () => {
  test("名前が出てくる場面だけを集める", () => {
    const sources = [
      episode("第1話", [
        "朝の空気は冷たかった。",
        "灯は門をくぐった。",
        "遠くで鐘が鳴っている。",
      ]),
      episode("第2話", ["澪はひとりで歩いた。", "空は晴れていた。"]),
    ];

    const excerpts = collectMentionExcerpts(sources, ["灯"], {
      windowChars: 20,
    });

    expect(excerpts).toHaveLength(1);
    expect(excerpts[0].label).toBe("第1話");
    expect(excerpts[0].text).toContain("灯は門をくぐった。");
  });

  test("行の途中で切らない", () => {
    const line = "「わたしは行きません」と灯ははっきり言った。";
    const sources = [episode("第1話", ["前の行。", line, "次の行。"])];

    const excerpts = collectMentionExcerpts(sources, ["灯"], {
      // 一致箇所の前後2字しか取らない設定でも、発言が途中で切れてはいけない
      windowChars: 4,
    });

    expect(excerpts[0].text).toContain(line);
  });

  test("同じ場面を二重に渡さない", () => {
    const sources = [
      episode("第1話", ["灯と澪が並んで座り、灯が先に口を開いた。"]),
    ];

    const excerpts = collectMentionExcerpts(sources, ["灯"], {
      windowChars: 40,
    });

    expect(excerpts).toHaveLength(1);
  });

  test("1文字の名前でも材料を集める", () => {
    // 「灯」「澪」のような一字名は珍しくない。
    // 除くとその人物だけ掘り下げが黙って無意味になる
    const sources = [episode("第1話", ["灯はそこにいた。"])];

    expect(collectMentionExcerpts(sources, ["灯"])).toHaveLength(1);
  });

  test("空の用語は索引に載せない", () => {
    const sources = [episode("第1話", ["誰かがいた。"])];

    expect(collectMentionExcerpts(sources, ["", "  "])).toEqual([]);
  });

  test("別名でも見つける", () => {
    const sources = [
      episode("第1話", ["ホンゴーさんは書類を睨んだ。"]),
      episode("第2話", ["イントは走り出した。"]),
    ];

    const excerpts = collectMentionExcerpts(sources, ["ホンゴー", "イント"]);

    expect(excerpts.map((item) => item.label)).toEqual(["第1話", "第2話"]);
  });

  test("該当が無ければ空にする", () => {
    const sources = [episode("第1話", ["誰もいない部屋だった。"])];

    expect(collectMentionExcerpts(sources, ["灯"])).toEqual([]);
  });

  test("上限を超えたら作品全体から均等に間引く", () => {
    // 序盤だけ渡すと「最終話でどうなったか」に答えられない
    const sources = Array.from({ length: 40 }, (_, index) =>
      episode(`第${index + 1}話`, ["灯はそこにいた。"])
    );

    const excerpts = collectMentionExcerpts(sources, ["灯"], {
      maxExcerpts: 5,
    });

    expect(excerpts).toHaveLength(5);
    expect(excerpts[0].label).toBe("第1話");
    expect(excerpts.at(-1)?.label).toBe("第40話");
  });

  test("文字数の上限に収める", () => {
    const long = "灯".repeat(500);
    const sources = Array.from({ length: 10 }, (_, index) =>
      episode(`第${index + 1}話`, [long])
    );

    const excerpts = collectMentionExcerpts(sources, ["灯灯"], {
      maxTotalChars: 1200,
    });

    const total = excerpts.reduce((sum, item) => sum + item.text.length, 0);
    expect(total).toBeLessThanOrEqual(1200);
    expect(excerpts.length).toBeGreaterThan(0);
  });
});

describe("均等な間引き", () => {
  test("最初と最後は必ず残す", () => {
    expect(sampleEvenly([1, 2, 3, 4, 5, 6, 7, 8, 9], 3)).toEqual([1, 5, 9]);
  });

  test("件数が上限以下ならそのまま返す", () => {
    expect(sampleEvenly([1, 2], 5)).toEqual([1, 2]);
  });

  test("0件を求められたら空にする", () => {
    expect(sampleEvenly([1, 2, 3], 0)).toEqual([]);
  });
});
