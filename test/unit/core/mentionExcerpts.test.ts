import { describe, expect, test } from "vitest";
import {
  collectMentionExcerpts,
  sampleEvenly,
} from "../../../src/core/mentionExcerpts";

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

/*
  短い名前が長い語の一部に当たる取り違え（2026-10-02、教科書チート219話の
  「AIで再読込」）。人物「フォー・シーゲン」の抜粋16件がすべて「フォートラン」の
  場面で、「ルド」には本人の名前が一度も出ない抜粋が19〜22件返った。
  見逃し（本人の場面が落ちる）と誤検出（別の語の場面が混ざる）の両方を見る
*/
describe("短い名前を長い語の一部として拾わない", () => {
  const FOUR = ["フォー・シーゲン", "フォー"];

  test("「フォー」の抜粋に「フォートラン」の場面を入れない", () => {
    const sources = [
      episode("第10話", ["フォートランの城門が開いた。"]),
      episode("第20話", ["フォートラン軍が進んだ。"]),
      episode("第131話", ["フォーは剣を抜いた。"]),
    ];

    const excerpts = collectMentionExcerpts(sources, FOUR, { windowChars: 4 });

    expect(excerpts.map((item) => item.label)).toEqual(["第131話"]);
  });

  test("「ルド」を「ギルド」「フィールド」「ルドルフ」の中で当てない", () => {
    const sources = [
      episode("第1話", ["ギルドの扉を押した。"]),
      episode("第2話", ["フィールドに出た。"]),
      episode("第3話", ["ルドルフが笑った。"]),
      episode("第4話", ["ルドは黙っていた。"]),
    ];

    const excerpts = collectMentionExcerpts(sources, ["ルド"], { windowChars: 4 });

    expect(excerpts.map((item) => item.label)).toEqual(["第4話"]);
  });

  test("敬称・括弧・読点・行頭・行末に続く本人の名前は落とさない", () => {
    const lines = [
      "フォーさんが来た。",
      "「フォー様、どうぞ」",
      "「フォー」と呼んだ。",
      "フォー、待って。",
      "それはフォー",
      "フォー殿は笑った。",
    ];
    const sources = lines.map((line, index) => episode(`第${index + 1}話`, [line]));

    const excerpts = collectMentionExcerpts(sources, FOUR, { windowChars: 2 });

    expect(excerpts).toHaveLength(lines.length);
  });

  test("中黒・空白で続く姓名の片方は当てる（「フォー・シーゲン」の「シーゲン」）", () => {
    const sources = [episode("第1話", ["フォー・シーゲンが名乗った。"])];

    const excerpts = collectMentionExcerpts(sources, ["シーゲン"], { windowChars: 2 });

    expect(excerpts).toHaveLength(1);
  });

  test("漢字の名前は前後に漢字が続いても当てる（「相沢様」「相沢家」を落とさない）", () => {
    const sources = [
      episode("第1話", ["相沢様がお見えです。"]),
      episode("第2話", ["相沢家の門をくぐった。"]),
    ];

    const excerpts = collectMentionExcerpts(sources, ["相沢"], { windowChars: 2 });

    expect(excerpts).toHaveLength(2);
  });

  test("ほかの記録の名前の中にある一致は除く（漢字でも効く）", () => {
    const sources = [
      episode("第1話", ["教皇庁の鐘が鳴った。"]),
      episode("第2話", ["教皇は祈りを捧げた。"]),
    ];

    const excerpts = collectMentionExcerpts(sources, ["教皇"], {
      windowChars: 2,
      otherNames: ["教皇庁"],
    });

    expect(excerpts.map((item) => item.label)).toEqual(["第2話"]);
  });

  test("ほかの記録と同じ呼び方でも、自分の呼び方は消さない", () => {
    const sources = [episode("第1話", ["スカラが頷いた。"])];

    const excerpts = collectMentionExcerpts(sources, ["スカラ侯爵", "スカラ"], {
      windowChars: 2,
      otherNames: ["スカラ", "ウニト・スカラ"],
    });

    expect(excerpts).toHaveLength(1);
  });

  test("ほかの記録の名前で隠れない所の本人の名前は残る", () => {
    const sources = [
      episode("第1話", ["ルドの国では、ルド王国の旗が揺れていた。"]),
    ];

    const excerpts = collectMentionExcerpts(sources, ["ルド"], {
      windowChars: 2,
      otherNames: ["ルド王国"],
    });

    expect(excerpts).toHaveLength(1);
    expect(excerpts[0].text).toContain("ルドの国");
  });
});
