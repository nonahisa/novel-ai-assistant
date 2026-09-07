import { describe, expect, it } from "vitest";
import {
  applyRubyInsertions,
  canRevertRuby,
  countByTerm,
  describeRubyResults,
  describeRubyTermTotals,
  planRubyInsertions,
  splitSingleCharTerms,
  type RubyTerm,
} from "../../src/core/settingsRuby";

/**
 * 設定資料の読み仮名を、本文のルビとして振る（設計書6.12.5）。
 *
 * 作者の指示（2026-08-23）：設定資料のパネルに「ルビを追加」を置く。
 *
 * **本文を書き換える操作なので、振ってはいけないところを機械で見張る。**
 * 二重にルビが付くと、投稿サイトでそのまま崩れて読者の目に触れる。
 */

const terms: RubyTerm[] = [
  { text: "薬師寺", reading: "やくしじ" },
  { text: "焔火", reading: "ほむら" },
];

function apply(text: string, scope: "first" | "all" = "all"): string {
  return applyRubyInsertions(text, planRubyInsertions(text, terms, scope));
}

describe("どこへ振るか", () => {
  it("名前を見つけてルビにする", () => {
    expect(apply("薬師寺が笑った。")).toBe("{薬師寺|やくしじ}が笑った。");
  });

  it("同じ話に何度も出てきたら、すべてに振れる", () => {
    expect(apply("焔火と焔火。", "all")).toBe("{焔火|ほむら}と{焔火|ほむら}。");
  });

  /** 出てくるたびに振ると読みにくい。投稿作品でよくある形 */
  it("最初の1回だけ、も選べる", () => {
    expect(apply("焔火と焔火。", "first")).toBe("{焔火|ほむら}と焔火。");
  });

  it("読み仮名の無い語は振らない", () => {
    const text = "無名が通る。";
    expect(
      applyRubyInsertions(
        text,
        planRubyInsertions(text, [{ text: "無名", reading: "  " }], "all")
      )
    ).toBe(text);
  });

  /** ひらがなの名前にルビを振っても意味がない */
  it("名前と読みが同じでも壊さない", () => {
    const text = "さくらが咲く。";
    expect(
      applyRubyInsertions(
        text,
        planRubyInsertions(text, [{ text: "さくら", reading: "さくら" }], "all")
      )
    ).toBe("{さくら|さくら}が咲く。");
  });
});

describe("振ってはいけないところ", () => {
  /** **二重になると本文が壊れる。** ここがいちばん危ない */
  it("すでにルビのある語へ、重ねて振らない", () => {
    const text = "{薬師寺|やくしじ}が笑った。";
    expect(apply(text)).toBe(text);
  });

  it("投稿サイトの記法の中にも振らない", () => {
    const text = "｜薬師寺《やくしじ》が笑った。";
    expect(apply(text)).toBe(text);
  });

  it("縦線を省いた投稿サイトの記法の中にも振らない", () => {
    const text = "薬師寺《やくしじ》が笑った。";
    expect(apply(text)).toBe(text);
  });

  it("アルファポリスの別記法の中にも振らない", () => {
    const text = "#薬師寺__やくしじ__#が笑った。";
    expect(apply(text)).toBe(text);
  });

  it("傍点の中にも振らない", () => {
    const text = "{{薬師寺}}が笑った。";
    expect(apply(text)).toBe(text);
  });

  it("すでに振ってある箇所は飛ばし、まだの箇所には振る（すべて）", () => {
    expect(apply("{焔火|ほむら}と焔火。", "all")).toBe(
      "{焔火|ほむら}と{焔火|ほむら}。"
    );
  });

  it("「最初の1回だけ」では、その話にすでにルビがある語には振らない（作者の裁定、2026-09-08）", () => {
    // 0.40.5 までは既存のルビを飛ばして次の出現に振っていたので、
    // 手で振ったルビと並んで1話に2つになっていた
    const text = "{焔火|ほむら}と焔火。";
    expect(apply(text, "first")).toBe(text);
    // 投稿サイトの記法・アルファポリスの記法も「振ってある」に数える
    expect(apply("｜焔火《ほむら》と焔火。", "first")).toBe("｜焔火《ほむら》と焔火。");
    expect(apply("#焔火__ほむら__#と焔火。", "first")).toBe("#焔火__ほむら__#と焔火。");
    // 傍点はルビではないので、別の出現には振る
    expect(apply("{{焔火}}と焔火。", "first")).toBe("{{焔火}}と{焔火|ほむら}。");
  });
});

describe("名前が重なるとき", () => {
  /**
   * **長い名前を先に当てる。** 短いほうを先に取ると、
   * 「ミナモト」が「ミナ」＋「モト」に割れる。
   */
  it("長い名前を優先する", () => {
    const text = "ミナモトが来た。";
    const both: RubyTerm[] = [
      { text: "ミナ", reading: "みな" },
      { text: "ミナモト", reading: "みなもと" },
    ];
    expect(
      applyRubyInsertions(text, planRubyInsertions(text, both, "all"))
    ).toBe("{ミナモト|みなもと}が来た。");
  });

  it("短い名前も、重ならないところには振る", () => {
    const text = "ミナモトとミナ。";
    const both: RubyTerm[] = [
      { text: "ミナ", reading: "みな" },
      { text: "ミナモト", reading: "みなもと" },
    ];
    expect(
      applyRubyInsertions(text, planRubyInsertions(text, both, "all"))
    ).toBe("{ミナモト|みなもと}と{ミナ|みな}。");
  });
});

describe("入れ方", () => {
  /** 前から入れると、入れたぶんだけ後ろの位置がずれる */
  it("複数入れても位置がずれない", () => {
    expect(apply("焔火と薬師寺と焔火。", "all")).toBe(
      "{焔火|ほむら}と{薬師寺|やくしじ}と{焔火|ほむら}。"
    );
  });

  it("何も見つからなければ、本文はそのまま", () => {
    const text = "誰も出てこない。";
    expect(apply(text)).toBe(text);
  });
});

describe("作者に見せる要約", () => {
  const name = (filePath: string) => filePath;

  it("話ごとの内訳を出す", () => {
    const text = describeRubyResults(
      [
        { filePath: "001.md", count: 3 },
        { filePath: "002.md", count: 1 },
      ],
      name
    );
    expect(text).toContain("2話");
    expect(text).toContain("4件");
    expect(text).toContain("001.md：3件");
  });

  it("0件の話は数に入れない", () => {
    const text = describeRubyResults(
      [
        { filePath: "001.md", count: 2 },
        { filePath: "002.md", count: 0 },
      ],
      name
    );
    expect(text).toContain("1話");
    expect(text).not.toContain("002.md");
  });

  it("対象にできない話は、理由を添えて分けて出す", () => {
    const text = describeRubyResults(
      [{ filePath: "003.md", count: 0, skipped: "読めませんでした" }],
      name
    );
    expect(text).toContain("対象にできない話");
    expect(text).toContain("読めませんでした");
  });

  it("1件も無ければ、その旨を言う", () => {
    expect(describeRubyResults([], name)).toContain("見つかりませんでした");
  });
});

/**
 * 1文字の語は振らない（設計書6.12.5）。
 *
 * 実機で能力「因」（読み「いん」）が本文の「原因」に当たり、
 * `原{因|いん}` と割れた（2026-09-06）。1文字はほかの語の一部に
 * 当たりやすく、前後を見ずに機械で当てるには短すぎる。
 */
describe("1文字の語", () => {
  it("「因」は「原因」に当たらない", () => {
    const text = "その原因を探した。";
    expect(
      applyRubyInsertions(
        text,
        planRubyInsertions(text, [{ text: "因", reading: "いん" }], "all")
      )
    ).toBe(text);
  });

  /** 呼び出し側が外し忘れても、planRubyInsertions が二重に守る */
  it("1文字だけで出てくるところにも振らない", () => {
    const text = "因が残る。";
    expect(planRubyInsertions(text, [{ text: "因", reading: "いん" }], "all"))
      .toEqual([]);
  });

  it("splitSingleCharTerms が1文字だけを分ける", () => {
    const split = splitSingleCharTerms([
      { text: "因", reading: "いん" },
      { text: "文佳", reading: "ふみか" },
      { text: " 果 ", reading: "か" },
    ]);

    expect(split.usable.map((term) => term.text)).toEqual(["文佳"]);
    expect(split.singleChar.map((term) => term.text)).toEqual(["因", " 果 "]);
  });

  /**
   * サロゲートペア（「𠮟」）は `String.length` では2になる。
   * コードポイントで数えないと、1文字の語をすり抜けさせてしまう
   */
  it("サロゲートペアの1文字も、1文字として外す", () => {
    const split = splitSingleCharTerms([{ text: "𠮟", reading: "しか" }]);

    expect(split.usable).toEqual([]);
    expect(split.singleChar).toHaveLength(1);
  });

  /** 2文字の名前は主要人物に多い。外すと本来の目的が果たせない */
  it("2文字の名前は外さない", () => {
    const text = "文佳が来た。";
    expect(
      applyRubyInsertions(
        text,
        planRubyInsertions(text, [{ text: "文佳", reading: "ふみか" }], "all")
      )
    ).toBe("{文佳|ふみか}が来た。");
  });
});

describe("語ごとの件数", () => {
  const fumika: RubyTerm = { text: "文佳", reading: "ふみか" };
  const okuhara: RubyTerm = { text: "奥原", reading: "おくはら" };

  it("多い順に数える", () => {
    const text = "文佳と奥原と文佳と文佳。";
    const totals = countByTerm(planRubyInsertions(text, [fumika, okuhara], "all"));

    expect(totals).toEqual([
      { term: fumika, count: 3 },
      { term: okuhara, count: 1 },
    ]);
  });

  /** 同数のときに順が揺れると、同じ操作なのに確認画面の見た目が変わる */
  it("同数なら語の順で並べる", () => {
    const text = "奥原と文佳。";
    const totals = countByTerm(planRubyInsertions(text, [fumika, okuhara], "all"));

    expect(totals.map((entry) => entry.term.text)).toEqual(["奥原", "文佳"]);
  });

  it("全話を合算して、読み仮名付きで出す", () => {
    const text = describeRubyTermTotals([
      { filePath: "001.md", count: 3, byTerm: [{ term: fumika, count: 2 }, { term: okuhara, count: 1 }] },
      { filePath: "002.md", count: 1, byTerm: [{ term: fumika, count: 1 }] },
    ]);

    // 件数を先に書く（作者の要望、2026-09-07「：〇件の位置をそろえて」。
    // ダイアログの字は等幅ではないので、名前のうしろだと長さぶんずれる）
    expect(text).toContain("3件　文佳（ふみか）");
    expect(text).toContain("1件　奥原（おくはら）");
    // 多い順
    expect(text.indexOf("文佳")).toBeLessThan(text.indexOf("奥原"));
  });

  it("語が多すぎるときは、上位だけ出して残りは数で言う", () => {
    const results = [
      {
        filePath: "001.md",
        count: 20,
        byTerm: Array.from({ length: 20 }, (_, index) => ({
          term: { text: `語${index}`, reading: `よみ${index}` },
          count: 20 - index,
        })),
      },
    ];

    const text = describeRubyTermTotals(results);
    expect(text.split("\n")).toHaveLength(13); // 12語＋「ほか」の行
    expect(text).toContain("…ほか8語");
  });

  it("語ごとの件数が無ければ、空文字にする", () => {
    expect(describeRubyTermTotals([{ filePath: "001.md", count: 0 }])).toBe("");
  });
});

/**
 * 戻せるのは、振った直後のままの本文だけ（設計書6.12.5）。
 *
 * 振ったあとに作者が書き足していたら、退避してある本文を書き戻すと
 * その書き足しが消える。
 */
describe("戻せるかどうか", () => {
  it("振った直後のままなら戻せる", () => {
    expect(canRevertRuby({ hashAfter: "abc" }, "abc")).toBe(true);
  });

  it("振ったあとに変わっていたら戻さない", () => {
    expect(canRevertRuby({ hashAfter: "abc" }, "def")).toBe(false);
  });
});
