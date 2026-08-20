import { describe, expect, test } from "vitest";
import {
  findRuby,
  fromSiteNotation,
  rubyToHtml,
  RUBY_STYLES,
  stripRuby,
  toSiteNotation,
  validateRuby,
} from "../../src/core/ruby";

/**
 * ルビの記法変換（設計書6.12）。
 *
 * **記法は推測せず、調べてから実装した**（2026-08-19）。
 * `[[rb:漢字 > かんじ]]` だと思い込んでいたが、**アルファポリスの記法ではなかった**。
 * 実際は次の2つで、`｜漢字《かんじ》` は**なろう・カクヨム・アルファポリスの
 * いずれでも通る**。1つの記法で3サイトを賄える。
 */
describe("投稿サイトの記法へ出す", () => {
  test("｜漢字《かんじ》へ変換する", () => {
    expect(toSiteNotation("{魔導書庫|まどうしょこ}へ向かう")).toBe(
      "｜魔導書庫《まどうしょこ》へ向かう"
    );
  });

  test("1行に複数あっても全部変換する", () => {
    expect(toSiteNotation("{朝|あさ}と{夜|よる}")).toBe(
      "｜朝《あさ》と｜夜《よる》"
    );
  });

  test("読み仮名が空なら、ルビを付けずに本文だけ残す", () => {
    // 書きかけの `{漢字|}` を投稿サイトへ出すと崩れる
    expect(toSiteNotation("{漢字|}を書く")).toBe("漢字を書く");
  });

  test("アルファポリスの別記法でも出せる", () => {
    expect(toSiteNotation("{朝|あさ}", "alphapolis-hash")).toBe("#朝__あさ__#");
  });

  test("HTMLでも出せる", () => {
    expect(toSiteNotation("{朝|あさ}", "html")).toBe(
      "<ruby>朝<rt>あさ</rt></ruby>"
    );
  });

  test("HTMLでは記号を逃がす", () => {
    // 本文に < が入っていても、プレビューが壊れない
    expect(rubyToHtml("{<朝>|あさ}")).toBe(
      "<ruby>&lt;朝&gt;<rt>あさ</rt></ruby>"
    );
  });

  test("ルビが無ければ何も変えない", () => {
    const text = "ただの本文。記号（｜や《》）が混じっていても触らない。";
    expect(toSiteNotation(text)).toBe(text);
  });
});

describe("投稿サイトの記法から取り込む", () => {
  test("縦線ありを読める（全角・半角どちらも）", () => {
    expect(fromSiteNotation("｜魔導書庫《まどうしょこ》")).toBe(
      "{魔導書庫|まどうしょこ}"
    );
    expect(fromSiteNotation("|魔導書庫《まどうしょこ》")).toBe(
      "{魔導書庫|まどうしょこ}"
    );
  });

  test("縦線を省いた形も読める", () => {
    expect(fromSiteNotation("魔導書庫《まどうしょこ》へ")).toBe(
      "{魔導書庫|まどうしょこ}へ"
    );
  });

  test("アルファポリスの別記法も読める", () => {
    expect(fromSiteNotation("#朝__あさ__#")).toBe("{朝|あさ}");
  });

  test("縦線ありを先に処理する", () => {
    // **順番を逆にすると、縦線が本文に取り残される**
    expect(fromSiteNotation("｜朝《あさ》")).not.toContain("｜");
  });

  test("かなに付いた《》は拾わない", () => {
    // 縦線を省ける決まりは漢字のときだけ。
    // 会話の中の二重山括弧を巻き込むと本文が壊れる
    const text = "「これは《強調》です」";
    expect(fromSiteNotation(text)).toBe(text);
  });
});

describe("往復しても原稿が変わらない", () => {
  // **これがいちばん大事。** 変換して戻したときに元と違えば、
  // 作者の原稿を壊したことになる
  test.each([
    "{魔導書庫|まどうしょこ}へ向かう。",
    "{朝|あさ}と{夜|よる}が{巡|めぐ}る。",
    "ルビの無い普通の本文。",
    "改行を\n挟んだ{文|ぶん}。",
  ])("元へ戻る: %s", (original) => {
    expect(fromSiteNotation(toSiteNotation(original))).toBe(original);
  });

  test("アルファポリスの別記法でも往復する", () => {
    const original = "{朝|あさ}と{夜|よる}";
    expect(fromSiteNotation(toSiteNotation(original, "alphapolis-hash"))).toBe(
      original
    );
  });
});

describe("ルビを取り除く", () => {
  test("読み仮名を落として本文だけにする", () => {
    expect(stripRuby("{魔導書庫|まどうしょこ}へ向かう")).toBe("魔導書庫へ向かう");
  });

  test("読み仮名が空でも本文は残る", () => {
    expect(stripRuby("{漢字|}")).toBe("漢字");
  });
});

describe("中身を取り出す", () => {
  test("1件ずつ拾える", () => {
    expect(findRuby("{朝|あさ}と{夜|よる}")).toEqual([
      { base: "朝", reading: "あさ" },
      { base: "夜", reading: "よる" },
    ]);
  });

  test("無ければ空", () => {
    expect(findRuby("ただの本文")).toEqual([]);
  });
});

describe("ルビとして正しい形か", () => {
  test("正しければ null", () => {
    expect(validateRuby("魔導書庫", "まどうしょこ")).toBeNull();
  });

  test("空を弾く", () => {
    expect(validateRuby("", "あさ")).toContain("文字がありません");
    expect(validateRuby("朝", "")).toContain("読み仮名がありません");
  });

  test("記法を壊す記号を弾く", () => {
    // **これを許すと、変換したときに本文が崩れる**
    expect(validateRuby("朝|夜", "あさ")).toContain("使えない記号");
    expect(validateRuby("朝", "あさ《よる》")).toContain("使えない記号");
  });

  test("長すぎるものを弾く", () => {
    expect(validateRuby("あ".repeat(31), "よみ")).toContain("長すぎます");
  });
});

describe("出せる記法の一覧", () => {
  test("3つ用意してある", () => {
    expect(RUBY_STYLES.map((style) => style.id)).toEqual([
      "site",
      "alphapolis-hash",
      "html",
    ]);
  });

  test("最初のものが3サイト共通だと分かる説明になっている", () => {
    expect(RUBY_STYLES[0].detail).toContain("なろう");
    expect(RUBY_STYLES[0].detail).toContain("カクヨム");
    expect(RUBY_STYLES[0].detail).toContain("アルファポリス");
  });
});
