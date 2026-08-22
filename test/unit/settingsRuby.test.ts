import { describe, expect, it } from "vitest";
import {
  applyRubyInsertions,
  describeRubyResults,
  planRubyInsertions,
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
  { text: "焔", reading: "ほむら" },
];

function apply(text: string, scope: "first" | "all" = "all"): string {
  return applyRubyInsertions(text, planRubyInsertions(text, terms, scope));
}

describe("どこへ振るか", () => {
  it("名前を見つけてルビにする", () => {
    expect(apply("薬師寺が笑った。")).toBe("{薬師寺|やくしじ}が笑った。");
  });

  it("同じ話に何度も出てきたら、すべてに振れる", () => {
    expect(apply("焔と焔。", "all")).toBe("{焔|ほむら}と{焔|ほむら}。");
  });

  /** 出てくるたびに振ると読みにくい。投稿作品でよくある形 */
  it("最初の1回だけ、も選べる", () => {
    expect(apply("焔と焔。", "first")).toBe("{焔|ほむら}と焔。");
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

  it("すでに振ってある箇所は飛ばし、まだの箇所には振る", () => {
    expect(apply("{焔|ほむら}と焔。", "all")).toBe(
      "{焔|ほむら}と{焔|ほむら}。"
    );
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
    expect(apply("焔と薬師寺と焔。", "all")).toBe(
      "{焔|ほむら}と{薬師寺|やくしじ}と{焔|ほむら}。"
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
