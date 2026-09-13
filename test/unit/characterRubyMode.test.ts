import { describe, expect, test } from "vitest";
import {
  buildCharacterPageFragment,
  shouldRubyName,
  type EpubCharacterEntry,
} from "../../src/core/epubCharacterPage";
import {
  DEFAULT_CHARACTER_RUBY_MODE,
  defaultBookConfig,
  parseBookConfig,
} from "../../src/models/book";

/**
 * 人物紹介の名前のルビ（作者の指定、2026-09-13「人物紹介もルビは選べる
 * ようにしたほうが良いかも」）。
 *
 * 読み仮名があれば必ずルビが付いていたため、実機では「イント→いんと」
 * 「ターナ先生→たーなせんせい」のような、読みの助けにならないルビが
 * 並んでいた。**既定は `all`**（いままでと同じ）で、選んだときだけ減る。
 */

function entry(
  name: string,
  reading: string | null
): EpubCharacterEntry {
  return { name, reading, summary: "", iconHref: null };
}

describe("ルビを付けるかの判定", () => {
  test("all はすべてに付ける", () => {
    expect(shouldRubyName("イント", "all")).toBe(true);
    expect(shouldRubyName("ターナ先生", "all")).toBe(true);
    expect(shouldRubyName("月島灯", "all")).toBe(true);
  });

  test("none は付けない", () => {
    expect(shouldRubyName("月島灯", "none")).toBe(false);
    expect(shouldRubyName("イント", "none")).toBe(false);
  });

  test("kanjiOnly は漢字を含む名前だけに付ける", () => {
    expect(shouldRubyName("月島灯", "kanjiOnly")).toBe(true);
    expect(shouldRubyName("イント", "kanjiOnly")).toBe(false);
    expect(shouldRubyName("あかり", "kanjiOnly")).toBe(false);
    expect(shouldRubyName("Tina", "kanjiOnly")).toBe(false);
  });

  /** 仮名と漢字が混ざる名前は、漢字の側の読みが要る */
  test("kanjiOnly は漢字が1文字でもあれば付ける", () => {
    expect(shouldRubyName("ターナ先生", "kanjiOnly")).toBe(true);
    expect(shouldRubyName("Ａ組の灯", "kanjiOnly")).toBe(true);
  });

  /** 範囲を手で並べると常用外の字を取りこぼす（`\p{Script=Han}` を使う） */
  test("kanjiOnly は常用外の漢字も漢字として数える", () => {
    expect(shouldRubyName("髙梨", "kanjiOnly")).toBe(true);
  });

  test("省略は既定（すべてに付ける）と同じ", () => {
    expect(DEFAULT_CHARACTER_RUBY_MODE).toBe("all");
    expect(shouldRubyName("イント", undefined)).toBe(true);
  });
});

describe("組み上がった面", () => {
  const entries = [entry("月島灯", "つきしまあかり"), entry("イント", "いんと")];

  test("省略すると、いままでどおり両方にルビが付く", () => {
    const html = buildCharacterPageFragment(entries);

    expect(html).toContain("<ruby>月島灯<rt>つきしまあかり</rt></ruby>");
    expect(html).toContain("<ruby>イント<rt>いんと</rt></ruby>");
  });

  test("kanjiOnly なら、仮名だけの名前はルビが消えて名前だけになる", () => {
    const html = buildCharacterPageFragment(entries, undefined, "kanjiOnly");

    expect(html).toContain("<ruby>月島灯<rt>つきしまあかり</rt></ruby>");
    expect(html).not.toContain("いんと");
    expect(html).toContain('<p class="character-name">イント</p>');
  });

  test("none ならルビがひとつも出ない", () => {
    const html = buildCharacterPageFragment(entries, undefined, "none");

    expect(html).not.toContain("<ruby>");
    expect(html).toContain('<p class="character-name">月島灯</p>');
  });

  /** 読み仮名の無い人は、どの選び方でも名前だけ（空の `<rt>` を作らない） */
  test("読み仮名が無ければ、all でもルビにならない", () => {
    const html = buildCharacterPageFragment([entry("月島灯", null)], undefined, "all");

    expect(html).not.toContain("<ruby>");
  });
});

describe("本の台帳への書かれ方", () => {
  function parsed(characterPage: Record<string, unknown>) {
    return parseBookConfig(
      { ...defaultBookConfig("氷の街"), characterPage },
      "氷の街"
    ).characterPage;
  }

  test("既定（all）のときは台帳に項目を書かない", () => {
    const page = parsed({ showIcons: true, rubyMode: "all" });

    expect(page.rubyMode).toBeUndefined();
    expect(JSON.stringify(page)).not.toContain("rubyMode");
  });

  test("何も書いていない本も、項目を持たない", () => {
    const page = parsed({ showIcons: true });

    expect(page.rubyMode).toBeUndefined();
  });

  test("既定でない値は、そのまま持つ", () => {
    expect(parsed({ showIcons: true, rubyMode: "kanjiOnly" }).rubyMode).toBe(
      "kanjiOnly"
    );
    expect(parsed({ showIcons: true, rubyMode: "none" }).rubyMode).toBe("none");
  });

  /**
   * **知らない値で設計図ごと開けなくしない。** 綴りを1つ間違えただけで
   * エディター画面にたどり着けなくなると、直しようが無い。
   */
  test("知らない値は既定へ落ちる（例外にしない）", () => {
    expect(parsed({ showIcons: true, rubyMode: "kanji" }).rubyMode).toBeUndefined();
    expect(parsed({ showIcons: true, rubyMode: 7 }).rubyMode).toBeUndefined();
    expect(parsed({ showIcons: true, rubyMode: null }).rubyMode).toBeUndefined();
  });

  test("ほかの項目は巻き込まない", () => {
    expect(parsed({ showIcons: false, rubyMode: "none" }).showIcons).toBe(false);
  });
});
