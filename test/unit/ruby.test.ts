import { describe, expect, test } from "vitest";
import {
  countSiteNotation,
  describeSiteNotation,
  findRuby,
  fromSiteNotation,
  hasEmphasis,
  rubyToHtml,
  RUBY_STYLES,
  stripRuby,
  toSiteNotation,
  validateEmphasis,
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

/**
 * 傍点（設計書6.12.4）。
 *
 * 作者の指示（2026-08-23）：範囲選択で傍点を入れ、各投稿サイト向けに変換したい。
 * ネオページはカクヨムと同じ記法である（作者の確認）。
 *
 * **ここを間違えると、貼り付けた先が読者の目の前で崩れる。**
 * ルビと違い、傍点はサイトによって書き方が違うので、出し分けを機械で見張る。
 */
describe("傍点", () => {
  describe("投稿サイトへ出す", () => {
    /** カクヨムとネオページには専用の記法がある */
    test("カクヨム・ネオページは 《《強調》》", () => {
      expect(toSiteNotation("これは{{大事}}だ", "site", "kakuyomu")).toBe(
        "これは《《大事》》だ"
      );
    });

    /**
     * **なろうとアルファポリスには傍点の記法が無い。**
     * ルビで代用し、読み仮名を文字数ぶんの中黒にする。
     */
    test("なろう・アルファポリスはルビで代用する", () => {
      expect(toSiteNotation("これは{{大事}}だ", "site", "narou")).toBe(
        "これは｜大事《・・》だ"
      );
    });

    test("中黒の数は、傍点を付ける文字数と合わせる", () => {
      expect(toSiteNotation("{{とても大事}}", "site", "narou")).toBe(
        "｜とても大事《・・・・・》"
      );
    });

    /** サロゲートペアを2文字と数えると、点の数がずれる */
    test("サロゲートペアも1文字と数える", () => {
      expect(toSiteNotation("{{𠮟責}}", "site", "narou")).toBe(
        "｜𠮟責《・・》"
      );
    });

    test("ルビはサイトを問わず同じ", () => {
      for (const site of ["kakuyomu", "narou"] as const) {
        expect(toSiteNotation("{漢字|かんじ}", "site", site)).toBe(
          "｜漢字《かんじ》"
        );
      }
    });

    test("ルビと傍点が混ざっていても、どちらも出る", () => {
      expect(
        toSiteNotation("{漢字|かんじ}と{{強調}}", "site", "kakuyomu")
      ).toBe("｜漢字《かんじ》と《《強調》》");
    });
  });

  describe("取り込む", () => {
    test("カクヨムの傍点を読める", () => {
      expect(fromSiteNotation("これは《《大事》》だ")).toBe("これは{{大事}}だ");
    });

    /**
     * **中黒だけの読み仮名は、ルビではなく傍点である。**
     * ここを取り違えると、傍点が「・・」というルビになって残る。
     */
    test("ルビで代用された傍点も、傍点として読める", () => {
      expect(fromSiteNotation("これは｜大事《・・》だ")).toBe(
        "これは{{大事}}だ"
      );
    });

    test("ふつうのルビは、これまでどおりルビとして読める", () => {
      expect(fromSiteNotation("｜漢字《かんじ》")).toBe("{漢字|かんじ}");
    });

    test("出して戻すと、元に戻る", () => {
      for (const site of ["kakuyomu", "narou"] as const) {
        const source = "{漢字|かんじ}と{{強調}}";
        expect(fromSiteNotation(toSiteNotation(source, "site", site))).toBe(
          source
        );
      }
    });
  });

  describe("数える・見分ける", () => {
    test("傍点が入っているかが分かる", () => {
      expect(hasEmphasis("{{強調}}")).toBe(true);
      expect(hasEmphasis("{漢字|かんじ}")).toBe(false);
      expect(hasEmphasis("ただの本文")).toBe(false);
    });

    test("ルビと傍点を、別々に数える", () => {
      const text = "｜漢字《かんじ》と《《強調》》と｜大事《・・》";
      expect(countSiteNotation(text)).toEqual({ ruby: 1, emphasis: 2 });
    });

    test("何も無ければ0件", () => {
      expect(countSiteNotation("ただの本文です")).toEqual({
        ruby: 0,
        emphasis: 0,
      });
    });

    test("件数を作者に読める言葉にする", () => {
      expect(describeSiteNotation("｜漢字《かんじ》と《《強調》》")).toBe(
        "ルビ1件と傍点1件"
      );
      expect(describeSiteNotation("《《強調》》")).toBe("傍点1件");
    });
  });

  describe("字数と表示", () => {
    /** 印は本文ではないので、字数に数えない */
    test("字数を数えるとき、傍点の印は落とす", () => {
      expect(stripRuby("これは{{大事}}だ")).toBe("これは大事だ");
    });

    test("プレビューでは点が付く", () => {
      const html = rubyToHtml("{{大事}}");
      expect(html).toContain("text-emphasis");
      expect(html).toContain("大事");
    });
  });

  describe("入れてよい形か", () => {
    test("空は受けない", () => {
      expect(validateEmphasis("  ")).toBeTruthy();
    });

    /** `}` が混ざると、そこで印が閉じてしまう */
    test("記号は受けない", () => {
      expect(validateEmphasis("大}事")).toBeTruthy();
      expect(validateEmphasis("大《事")).toBeTruthy();
    });

    test("ふつうの語は受ける", () => {
      expect(validateEmphasis("大事")).toBeNull();
    });
  });
});
