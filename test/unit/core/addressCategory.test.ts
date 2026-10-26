import { describe, expect, test } from "vitest";
import {
  ADDRESS_CATEGORY_GUIDES,
  cleanAddressCategory,
} from "../../../src/core/addressCategory";
import { normalizeExtractedCharacter } from "../../../src/core/characterExtractionValidation";

/**
 * P-04a 5.12：呼称の区分（addressTerms.category）の説明と、必須にした欄の空の扱い
 * （作者の裁定 2026-10-26「直して測ってから入れる」）。
 *
 * 新しく書いた指示の言葉は、そのまま値として返ってくる前提で見張る
 * （CLAUDE.md「繰り返し起きた失敗」3）。
 */

describe("呼称の区分の値を受け取る", () => {
  test("区分名そのもの・作品側の言い方は残す", () => {
    for (const guide of ADDRESS_CATEGORY_GUIDES) {
      expect(cleanAddressCategory(guide.label)).toBe(guide.label);
    }
    // 設計書の例にある自由記述（区分名の一覧に無い言い方）も捨てない
    expect(cleanAddressCategory("名前呼び捨て")).toBe("名前呼び捨て");
    // 区分名を含むが一覧の写しではない組み合わせ（「名＋敬称」を字として含む）
    expect(cleanAddressCategory("あだ名＋敬称")).toBe("あだ名＋敬称");
    expect(cleanAddressCategory("役職・肩書き")).toBe("役職・肩書き");
  });

  test("空・不在の文言は null", () => {
    expect(cleanAddressCategory("")).toBeNull();
    expect(cleanAddressCategory("  ")).toBeNull();
    expect(cleanAddressCategory(null)).toBeNull();
    expect(cleanAddressCategory(undefined)).toBeNull();
    expect(cleanAddressCategory(3)).toBeNull();
    expect(cleanAddressCategory("不明")).toBeNull();
    expect(cleanAddressCategory("なし")).toBeNull();
  });

  test("指示の説明文が値に返ってきたら null", () => {
    for (const guide of ADDRESS_CATEGORY_GUIDES) {
      // 説明の行をまるごと写した形
      expect(cleanAddressCategory(`${guide.label}：${guide.meaning}`)).toBeNull();
      // 説明の部分だけを写した形
      expect(cleanAddressCategory(guide.meaning)).toBeNull();
    }
  });

  test("区分名を並べたまま返ってきたら null（選べていない）", () => {
    const [first, second] = ADDRESS_CATEGORY_GUIDES;
    expect(cleanAddressCategory(`${first.label}／${second.label}`)).toBeNull();
    expect(cleanAddressCategory(`${first.label}、${second.label}`)).toBeNull();
    expect(cleanAddressCategory("区分名")).toBeNull();
    expect(cleanAddressCategory("区分")).toBeNull();
  });
});

describe("抽出の答えを受け取るときの空の扱い（必須にした欄）", () => {
  test("呼称の区分は cleanAddressCategory を通る", () => {
    const character = normalizeExtractedCharacter({
      name: "エバン",
      addressTerms: [
        { targetName: "シル", term: "シルさん", category: "" },
        { targetName: "シル", term: "シル", category: "不明" },
        {
          targetName: "シル",
          term: "シルちゃん",
          category: `${ADDRESS_CATEGORY_GUIDES[0].label}：${ADDRESS_CATEGORY_GUIDES[0].meaning}`,
        },
        { targetName: "シル", term: "シル様", category: "名＋敬称" },
      ],
    });
    expect(character.addressTerms?.map((term) => term.category)).toEqual([
      null,
      null,
      null,
      "名＋敬称",
    ]);
  });

  test("一人称が空文字・不在の文言・指示の語なら null、本文の語は残す", () => {
    const of = (firstPerson: unknown) =>
      normalizeExtractedCharacter({ name: "エバン", firstPerson }).firstPerson;
    expect(of("")).toBeNull();
    expect(of(null)).toBeNull();
    expect(of("不明")).toBeNull();
    expect(of("一人称")).toBeNull();
    expect(of("一人称は俺")).toBeNull();
    // 頼み方の言い回しの写し
    expect(of("自分を指すときに使う語")).toBeNull();
    expect(of("本文の表記のまま")).toBeNull();
    expect(of("俺")).toBe("俺");
    // 「自分」は一人称として正しい語なので落とさない
    expect(of("自分")).toBe("自分");
  });

  test("別名・呼称が空配列で返っても、空配列のまま受け取る", () => {
    const character = normalizeExtractedCharacter({
      name: "エバン",
      aliases: [],
      addressTerms: [],
    });
    expect(character.aliases).toEqual([]);
    expect(character.addressTerms).toEqual([]);
  });
});
