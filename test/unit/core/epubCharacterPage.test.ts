import { describe, expect, test } from "vitest";
import { emptyCharacter, type Character } from "../../src/models/character";
import {
  buildCharacterPageFragment,
  characterIconPath,
  selectBookCharacters,
  toCharacterEntry,
} from "../../src/core/epubCharacterPage";

/**
 * 登場人物一覧（設計書6.65.11）。
 *
 * 台帳はAIが本文から読み取ったものが混ざっている。**本へ入れてよいのは
 * 「登場済み・モブでない・いちばん公開寄り」の人物だけ**で、項目も名前と
 * 紹介文に絞る（役割・関係・外見まで並べると設定資料集になる）。
 */

function person(name: string, overrides: Partial<Character> = {}): Character {
  return { ...emptyCharacter("char_001", name), ...overrides };
}

describe("本へ載せる人物を選ぶ", () => {
  test("登場済み・モブでない・公開の人物だけが残る", () => {
    const selected = selectBookCharacters([
      person("月島灯"),
      person("未登場の人", { status: "未登場" }),
      person("取調官たち", { isMob: true }),
      person("編集部だけの人", { spoilerLevel: "staff_only" }),
      person("作者だけの人", { spoilerLevel: "author_only" }),
    ]);

    expect(selected.map((entry) => entry.name)).toEqual(["月島灯"]);
  });

  /**
   * **並べ替えない。** 台帳の並びは作者が決めたものなので、本でも守る
   * （設計書6.65.11）。
   */
  test("並びは台帳の順のまま", () => {
    const selected = selectBookCharacters([
      person("わたる"),
      person("あかり"),
      person("さくら"),
    ]);

    expect(selected.map((entry) => entry.name)).toEqual([
      "わたる",
      "あかり",
      "さくら",
    ]);
  });

  test("1人も残らないこともある（そのときは面を出さない側が決める）", () => {
    expect(selectBookCharacters([person("モブ", { isMob: true })])).toEqual([]);
  });

  /**
   * **名前の無い人物は載せない**（設計書6.65.11）。
   *
   * 台帳には、抽出の途中で作られた名前の空のレコードが混ざることがある。
   * そのまま組むと**中身の無い人物の枠**が本に並ぶ（名前も紹介文も無い
   * `<div>` だけ）。読者から見れば意味の無い空白であり、載せる用が無い。
   *
   * ここで落とすので、画面の「◯人が載ります」にも入らない（見えている
   * 人数と本の中身がずれない）。
   */
  test("名前が空の人物は載せない（欄の人数にも入らない）", () => {
    const selected = selectBookCharacters([
      person("月島灯"),
      person(""),
      person("   "),
    ]);

    expect(selected.map((entry) => entry.name)).toEqual(["月島灯"]);
  });
});

describe("本へ入れる項目", () => {
  /** 本へ入れるのは名前と紹介文だけ（設計書6.65.11） */
  test("名前・読み仮名・紹介文だけを取り出す", () => {
    const entry = toCharacterEntry(
      person("月島灯", {
        reading: "つきしまあかり",
        summary: "生活保護課の新人",
        role: "主人公",
        appearance: "背が高い",
        authorNotes: "作者のメモ",
      })
    );

    expect(entry).toEqual({
      name: "月島灯",
      reading: "つきしまあかり",
      summary: "生活保護課の新人",
      iconHref: null,
    });
  });

  test("紹介文が無ければ空文字（名前だけの人物になる）", () => {
    expect(toCharacterEntry(person("月島灯")).summary).toBe("");
  });
});

describe("人物イラストの場所", () => {
  test("作品フォルダの中を指す相対パスだけを受け取る", () => {
    expect(characterIconPath("素材/月島.png")).toBe("素材/月島.png");
    // Windowsで書かれた区切りも読める（挿絵と同じ揃え方）
    expect(characterIconPath("素材\\月島.png")).toBe("素材/月島.png");
  });

  test("外を指すもの・空のものは受け取らない（名前だけで本は出す）", () => {
    expect(characterIconPath(null)).toBeNull();
    expect(characterIconPath("   ")).toBeNull();
    expect(characterIconPath("/etc/passwd")).toBeNull();
    expect(characterIconPath("C:/秘密/画像.png")).toBeNull();
    expect(characterIconPath("../外/月島.png")).toBeNull();
  });
});

describe("一覧の面の組み方", () => {
  test("読み仮名があればルビになる", () => {
    const html = buildCharacterPageFragment([
      { name: "月島灯", reading: "つきしまあかり", summary: "", iconHref: null },
    ]);

    expect(html).toContain("<ruby>月島灯<rt>つきしまあかり</rt></ruby>");
  });

  test("読み仮名が無ければ名前だけ（空のルビを作らない）", () => {
    const html = buildCharacterPageFragment([
      { name: "月島灯", reading: null, summary: "", iconHref: null },
    ]);

    expect(html).toContain("月島灯");
    expect(html).not.toContain("<ruby>");
  });

  test("紹介文が無ければ、紹介文の段落そのものを出さない", () => {
    const html = buildCharacterPageFragment([
      { name: "月島灯", reading: null, summary: "   ", iconHref: null },
    ]);

    expect(html).not.toContain("character-summary");
  });

  test("紹介文があれば名前の下に出る", () => {
    const html = buildCharacterPageFragment([
      {
        name: "月島灯",
        reading: null,
        summary: "生活保護課の新人",
        iconHref: null,
      },
    ]);

    expect(html).toContain("生活保護課の新人");
    expect(html.indexOf("月島灯")).toBeLessThan(html.indexOf("生活保護課の新人"));
  });

  test("イラストがあれば画像、無ければ名前だけ", () => {
    const withIcon = buildCharacterPageFragment([
      { name: "月島灯", reading: null, summary: "", iconHref: "portrait-1.png" },
    ]);
    const without = buildCharacterPageFragment([
      { name: "月島灯", reading: null, summary: "", iconHref: null },
    ]);

    expect(withIcon).toContain('src="portrait-1.png"');
    expect(without).not.toContain("<img");
  });

  /** XHTMLはXMLである。逃がし忘れると本ごと開けなくなる（第1段と同じ約束） */
  test("名前も紹介文も逃がして組む", () => {
    const html = buildCharacterPageFragment([
      {
        name: "A & B",
        reading: "<よみ>",
        summary: "紹介 & 説明",
        iconHref: null,
      },
    ]);

    expect(html).toContain("A &amp; B");
    expect(html).toContain("&lt;よみ&gt;");
    expect(html).toContain("紹介 &amp; 説明");
    expect(html).not.toContain("A & B");
  });

  test("並びは渡された順のまま", () => {
    const html = buildCharacterPageFragment([
      { name: "わたる", reading: null, summary: "", iconHref: null },
      { name: "あかり", reading: null, summary: "", iconHref: null },
    ]);

    expect(html.indexOf("わたる")).toBeLessThan(html.indexOf("あかり"));
  });

  /**
   * 組む側でも名前の空は落とす。**空の要素は出さない**という奥付・紹介文と
   * 同じ約束で、ここが最後の関所になる（選び方を変えても空の枠は出ない）。
   */
  test("名前が空の人物は、枠ごと出さない", () => {
    const html = buildCharacterPageFragment([
      { name: "月島灯", reading: null, summary: "", iconHref: null },
      { name: "   ", reading: null, summary: "名無し", iconHref: "portrait-1.png" },
    ]);

    expect([...html.matchAll(/<div class="character">/g)]).toHaveLength(1);
    expect(html).toContain("月島灯");
    expect(html).not.toContain("名無し");
    // 名前が無いのに絵だけ載る、ということも起きない
    expect(html).not.toContain("portrait-1.png");
  });

  test("全員の名前が空なら、人物の枠は1つも出ない", () => {
    const html = buildCharacterPageFragment([
      { name: "", reading: null, summary: "", iconHref: null },
    ]);

    expect(html).not.toContain('<div class="character">');
    // 見出しの枠そのものは残る（面を出すかは呼び出し側が決める）
    expect(html).toContain("登場人物");
  });

  test("見出しは「登場人物」", () => {
    const html = buildCharacterPageFragment([
      { name: "月島灯", reading: null, summary: "", iconHref: null },
    ]);

    expect(html).toContain("登場人物");
  });
});
