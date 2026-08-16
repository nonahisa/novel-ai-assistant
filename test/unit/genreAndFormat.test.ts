import { describe, expect, test } from "vitest";
import {
  formatGenre,
  formatGenres,
  GENRE_SITES,
  genreSite,
  listGenres,
} from "../../src/core/genre";
import {
  suggestWorkFormat,
  WORK_FORMATS,
  workFormatLabels,
} from "../../src/core/workFormat";
import { PLOT_SECTIONS, updatePlotMarkdown } from "../../src/core/plotDoc";

/**
 * 形式とジャンル（設計書6.4.4、作者の要望 2026-08-16）。
 *
 * ジャンルは**投稿先ごとに体系が違う**。同じ「恋愛」「ホラー」でも
 * 指すものが違うので、取り違えないことがいちばん大事である。
 */
describe("作品の形式", () => {
  test("作者が挙げた5つが揃っている", () => {
    expect(workFormatLabels()).toEqual([
      "短編",
      "短編集",
      "長編",
      "大長編",
      "SNS記事",
    ]);
  });

  test("SNS記事は、同じアカウントの投稿をまとめたものと書く", () => {
    const sns = WORK_FORMATS.find((format) => format.key === "sns");

    expect(sns?.description).toContain("アカウント");
    expect(sns?.description).toContain("フォルダー");
  });

  test("1話しかなければ、字数が多くても短編と見る", () => {
    expect(suggestWorkFormat(500_000, 1).label).toBe("短編");
  });

  test("分量が増えるほど長いほうを勧める", () => {
    expect(suggestWorkFormat(5_000, 3).label).toBe("短編");
    expect(suggestWorkFormat(100_000, 30).label).toBe("長編");
    expect(suggestWorkFormat(800_000, 200).label).toBe("大長編");
  });

  test("字数から判らないものは勧めない", () => {
    // 短編集は短編と、SNS記事はどの形式とも字数で区別が付かない。
    // 当てずっぽうで勧めると、作者は選び直す手間だけを負う
    const suggested = [0, 5_000, 100_000, 800_000].map(
      (chars) => suggestWorkFormat(chars, 20).key
    );

    expect(suggested).not.toContain("shortCollection");
    expect(suggested).not.toContain("sns");
  });
});

describe("ジャンル", () => {
  test("なろうは大ジャンル5つ・ジャンル20", () => {
    // 恋愛2・ファンタジー2・文芸7・SF4・その他5。
    // 「ノンジャンル」はヘルプページに載っていない
    const narou = genreSite("narou");

    expect(narou.groups).toHaveLength(5);
    expect(listGenres(narou)).toHaveLength(20);
  });

  test("カクヨムは12", () => {
    expect(listGenres(genreSite("kakuyomu"))).toHaveLength(12);
  });

  test("アルファポリスは16", () => {
    expect(listGenres(genreSite("alphapolis"))).toHaveLength(16);
  });

  test("ネオページはジャンル12・サブジャンル59", () => {
    // 59はサイトの発表（「サブジャンル59種類」）とも一致する
    const neopage = genreSite("neopage");

    expect(neopage.groups).toHaveLength(12);
    expect(listGenres(neopage)).toHaveLength(59);
  });

  test("ネオページの「和風・中華」と「人外ラブ」は別のサブジャンル", () => {
    // 一続きに読めてしまう並びなので、取り違えを固定しておく
    const names = listGenres(genreSite("neopage")).map((c) => c.genre);

    expect(names).toContain("和風・中華");
    expect(names).toContain("人外ラブ");
    expect(names).not.toContain("和風・中華人外ラブ");
  });

  test("体系をひとつに揃えない", () => {
    // 勝手に対応付けると、実際には無いジャンルを名乗ることになる
    expect(GENRE_SITES.map((site) => site.key)).toEqual([
      "narou",
      "kakuyomu",
      "alphapolis",
      "neopage",
    ]);
  });

  test("同じ体系の中で、同じ名前を二度出さない", () => {
    // ネオページは大ジャンルとサブジャンルに同じ語が現れる
    // （SF > 宇宙／SF）。選択肢に同じ行が並ぶと選び分けられない
    for (const site of GENRE_SITES) {
      const shown = listGenres(site).map((choice) =>
        choice.group ? `${choice.group} > ${choice.genre}` : choice.genre
      );
      expect(new Set(shown).size, site.label).toBe(shown.length);
    }
  });

  test("どこの体系のジャンルかを必ず添える", () => {
    // 「恋愛」も「ホラー」も両サイトにあり、指すものが違う
    expect(
      formatGenre({ site: "narou", group: "ファンタジー", genre: "ハイファンタジー" })
    ).toBe("ファンタジー > ハイファンタジー（小説家になろう）");

    expect(formatGenre({ site: "kakuyomu", genre: "現代ドラマ" })).toBe(
      "現代ドラマ（カクヨム）"
    );
  });

  test("大ジャンルまで出さないと選べないものがある", () => {
    // 「異世界」は恋愛の下にあり、ファンタジーの下には無い
    const narou = listGenres(genreSite("narou"));
    const isekai = narou.filter((choice) => choice.genre === "異世界");

    expect(isekai).toHaveLength(1);
    expect(isekai[0].group).toBe("恋愛");
  });

  test("両サイトに同じ名前のジャンルがある", () => {
    // この前提が崩れたら、出どころを添える理由が変わる
    const narou = listGenres(genreSite("narou")).map((c) => c.genre);
    const kakuyomu = listGenres(genreSite("kakuyomu")).map((c) => c.genre);

    expect(narou.filter((genre) => kakuyomu.includes(genre))).toContain("ホラー");
  });

  test("複数の投稿先ぶんを並べられる", () => {
    const text = formatGenres([
      { site: "narou", group: "ファンタジー", genre: "ローファンタジー" },
      { site: "kakuyomu", genre: "現代ファンタジー" },
    ]);

    // なろう側は大ジャンルまで出す。「異世界」のように、
    // 大ジャンルが無いとどれか決まらないものがあるため
    expect(text).toBe(
      "- ファンタジー > ローファンタジー（小説家になろう）\n" +
        "- 現代ファンタジー（カクヨム）"
    );
  });
});

describe("プロットへの載り方", () => {
  test("形式とジャンルの見出しがある", () => {
    const headings = PLOT_SECTIONS.map((section) => section.heading);

    expect(headings).toContain("形式");
    expect(headings).toContain("ジャンル");
  });

  test("題の次に置く", () => {
    // 何を書こうとしているのかは中身より先に決まっていることが多く、
    // 探して埋めるものではない
    const keys = PLOT_SECTIONS.map((section) => section.key);

    expect(keys.indexOf("format")).toBe(keys.indexOf("title") + 1);
    expect(keys.indexOf("genre")).toBe(keys.indexOf("format") + 1);
  });

  test("書き足しても、作者の文書の形を変えない", () => {
    const before = "# 作品\n\n## 書きたい場面\n夕方の防波堤。\n";

    const after = updatePlotMarkdown(
      before,
      {
        format: "短編",
        genre: "- 現代ドラマ（カクヨム）",
      },
      { workTitle: "作品" }
    );

    expect(after.indexOf("## 書きたい場面")).toBeLessThan(
      after.indexOf("## 形式")
    );
    expect(after).toContain("夕方の防波堤。");
    expect(after).toContain("## 形式\n短編");
  });

  test("選び直すと、その場で入れ替わる", () => {
    const before = "# 作品\n\n## 形式\n短編\n\n## テーマ\n喪失\n";

    const after = updatePlotMarkdown(
      before,
      { format: "長編" },
      { workTitle: "作品" }
    );

    expect(after).toContain("長編");
    expect(after).not.toContain("短編");
    expect(after.indexOf("## 形式")).toBeLessThan(after.indexOf("## テーマ"));
  });
});
