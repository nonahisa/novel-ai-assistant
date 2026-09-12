import { describe, expect, test } from "vitest";
import {
  countSiteNotation,
  EMPHASIS_MULTILINE_NOTE,
  RUBY_MULTILINE_NOTE,
  describeSiteNotation,
  findRuby,
  findRubyAt,
  fromSiteNotation,
  hasEmphasis,
  rubyEditReplacement,
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

/**
 * 括弧書き（設計書6.68.3）。
 *
 * **noteにはルビの記法が無い。** `｜漢字《かんじ》` をそのまま貼ると、
 * 読者の目の前に記号が並ぶ。読みは括弧に入れて本文の中へ落とす。
 */
describe("括弧書き（noteへ貼る形）", () => {
  test("ルビを「漢字（かんじ）」にする", () => {
    expect(toSiteNotation("{魔導書庫|まどうしょこ}へ向かう", "paren")).toBe(
      "魔導書庫（まどうしょこ）へ向かう"
    );
  });

  test("読みが無いものは、親文字だけを残す", () => {
    expect(toSiteNotation("{漢字|}を書く", "paren")).toBe("漢字を書く");
  });

  /**
   * **傍点の印は落として、文字だけを残す。**
   *
   * noteには傍点の記法が無く、ルビでの代用（`｜大事《・・》`）も効かない。
   * 記号を残すと読者に見えてしまう。**印は本文ではない**（`stripRuby` と
   * 同じ考え方）ので、落とすほうを採った。
   */
  test("傍点は印だけ落として、文字を残す", () => {
    expect(toSiteNotation("これは{{大事}}だ", "paren")).toBe("これは大事だ");
  });

  test("ルビと傍点が混ざっていても、両方とも落ちる", () => {
    expect(toSiteNotation("{漢字|かんじ}と{{強調}}", "paren")).toBe(
      "漢字（かんじ）と強調"
    );
  });

  /** 記法が入っていない本文は、1文字も変えない */
  test("記法が無ければ、そのまま", () => {
    expect(toSiteNotation("ただの本文。", "paren")).toBe("ただの本文。");
  });

  /**
   * **選ばせる一覧には出さない。** 括弧書きは投稿キット（6.68）が
   * noteへ貼るときに選ぶもので、手で選ぶ場面は無い。
   */
  test("「どの形で書き出しますか」の一覧には出さない", () => {
    expect(RUBY_STYLES.map((style) => style.id)).not.toContain("paren");
  });
});

/**
 * すでに振ってあるルビを直す（作者の報告、2026-09-12）。
 *
 * 「ルビがあるところを選択してルビを打とうとすると、重ねられませんと
 * 出ます。ユーザーがその操作をするときは編集したいんだと思います」。
 *
 * **どの記法を指しているかの判定は、ここ1か所だけ**にする。組んで書く面・
 * 打つ面・素のエディタの3つが同じ答えを使う。
 */
describe("その場所のルビを見つける", () => {
  const text = "彼は{魔導書庫|まどうしょこ}へ向かった。";
  // 記法は5文字目から始まり、`}` の次は18
  const from = text.indexOf("{");
  const to = text.indexOf("}") + 1;

  test("選択が記法の内側なら当たる", () => {
    const found = findRubyAt(text, from + 2, from + 4);
    expect(found).toEqual({
      start: from,
      end: to,
      base: "魔導書庫",
      reading: "まどうしょこ",
      contained: true,
    });
  });

  test("選択が記法の一部にかかっていれば当たる", () => {
    // 手前の平文から記法の途中まで。作者は「その語を選んだ」つもりでいる。
    // **当たりはするが、内側ではない**（呼ぶ側はここで断る）
    const found = findRubyAt(text, 1, from + 3);
    expect(found?.start).toBe(from);
    expect(found?.contained).toBe(false);
  });

  test("記法まるごとの選択でも当たる", () => {
    const found = findRubyAt(text, from, to);
    expect(found?.reading).toBe("まどうしょこ");
    expect(found?.contained).toBe(true);
  });

  test("空の選択（カーソル）が記法の中なら当たる", () => {
    const found = findRubyAt(text, from + 3, from + 3);
    expect(found?.base).toBe("魔導書庫");
    expect(found?.contained).toBe(true);
  });

  /** 記法の直後にカーソルを置くのが、いちばん自然な指し方である */
  test("空の選択が記法の直後でも当たる", () => {
    const found = findRubyAt(text, to, to);
    expect(found?.base).toBe("魔導書庫");
    expect(found?.contained).toBe(true);
  });

  test("2つの記法にまたがる範囲は返さない", () => {
    const two = "{朝|あさ}と{夜|よる}";
    expect(findRubyAt(two, 1, two.length - 1)).toBeUndefined();
  });

  test("ルビが無ければ返さない", () => {
    expect(findRubyAt("ただの本文。", 1, 3)).toBeUndefined();
  });

  /** 傍点の編集は足していない（作者の依頼はルビ） */
  test("傍点には当たらない", () => {
    const emphasis = "これは{{大事}}だ";
    expect(findRubyAt(emphasis, 4, 8)).toBeUndefined();
  });
});

/**
 * 編集にしてよいのは、選択が記法の内側に収まっているときだけ
 * （作者の報告、2026-09-12）。
 *
 * `あ{漢字|かんじ}い` を丸ごと選んで「ルビを振る」と、編集にすれば
 * 「あ」「い」が黙って落ち、新規に振れば記法が入れ子になる。**どちらも
 * 原稿を壊す**ので、`contained` が false のときは呼ぶ側が断る。
 */
describe("選択が記法の内側に収まっているか", () => {
  const text = "あ{漢字|かんじ}い";
  const from = text.indexOf("{");
  const to = text.indexOf("}") + 1;

  test("記法の内側の選択は収まっている", () => {
    expect(findRubyAt(text, from + 1, from + 3)?.contained).toBe(true);
  });

  test("記法まるごとの選択も収まっている", () => {
    expect(findRubyAt(text, from, to)?.contained).toBe(true);
  });

  test("前後の平文まで選ぶと、収まっていない", () => {
    expect(findRubyAt(text, 0, text.length)?.contained).toBe(false);
  });
});

describe("直したあとの記法", () => {
  test("読みを入れ替える", () => {
    expect(rubyEditReplacement("魔導書庫", "まどうしょこ")).toBe(
      "{魔導書庫|まどうしょこ}"
    );
  });

  test("前後の空白は落とす", () => {
    expect(rubyEditReplacement("朝", " あさ ")).toBe("{朝|あさ}");
  });

  /** 空にして確定したら、記法だけを外して本文の字は残す */
  test("空ならルビを外す", () => {
    expect(rubyEditReplacement("朝", "")).toBe("朝");
    expect(rubyEditReplacement("朝", "   ")).toBe("朝");
  });
});

/**
 * **行をまたいで選んだときの断り方**（0.51.4。0.47.7 の積み残し⑥）。
 *
 * 記法（`{漢字|かんじ}`・`{{強調}}`）は行をまたげない。これまでも改行は
 * 弾いていたが、**「使えない記号（{ } | ｜ 《 》 #）が入っています」**と
 * 出していた——改行を記号の一組に混ぜていたためである。
 * 選んだところにそんな記号は無いので、何を直せばよいのか分からない。
 *
 * 壊れはしないが、**理由を取り違えて伝えるのは断っていないのと同じ**である。
 */
describe("行をまたいだ選択", () => {
  test("**ルビは、改行だと分かる言い方で断る**", () => {
    const problem = validateRuby("漢字\n熟語", "かんじ");
    expect(problem).toBe(RUBY_MULTILINE_NOTE);
    expect(problem).toContain("行をまたいで");
    // 記号のせいにしない
    expect(problem).not.toContain("使えない記号");
  });

  test("**傍点も、改行だと分かる言い方で断る**", () => {
    const problem = validateEmphasis("強調\n部分");
    expect(problem).toBe(EMPHASIS_MULTILINE_NOTE);
    expect(problem).toContain("行をまたいで");
    expect(problem).not.toContain("使えない記号");
  });

  test("読み仮名に改行が混ざったときも同じ", () => {
    expect(validateRuby("漢字", "かん\nじ")).toBe(RUBY_MULTILINE_NOTE);
  });

  test("CR だけの改行も見る（古い原稿）", () => {
    expect(validateRuby("漢字\r熟語", "かんじ")).toBe(RUBY_MULTILINE_NOTE);
    expect(validateEmphasis("強調\r部分")).toBe(EMPHASIS_MULTILINE_NOTE);
  });

  test("記号のほうは、これまでどおり記号として断る", () => {
    // 改行を別扱いにしたせいで、記号の検算が緩んでいないこと
    expect(validateRuby("漢{字", "かんじ")).toContain("使えない記号");
    expect(validateRuby("漢字", "かん|じ")).toContain("使えない記号");
    expect(validateEmphasis("強《調")).toContain("使えない記号");
  });

  test("1行に収まっていれば、これまでどおり通る", () => {
    expect(validateRuby("漢字", "かんじ")).toBeNull();
    expect(validateEmphasis("強調")).toBeNull();
  });
});
