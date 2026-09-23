import { describe, expect, test } from "vitest";
import { dropDiffEntries } from "../../src/core/dropDiffEntries";
import {
  emptyCharacter,
  type AddressForm,
  type AddressTerm,
  type Character,
} from "../../src/models/character";

/**
 * 更新案の中の1つだけを落としてから保存する（作者の依頼、2026-09-12）。
 *
 * 「呼称にハヤブサ先生があり、これが間違いです」——レコードまるごと
 * 見送るしかなかったところを、葉の単位で落とせるようにする。
 * **落とすのは反映の直前、メモリの上だけ**（承認待ちのファイルは触らない）。
 */

function form(term: string): AddressForm {
  return {
    term,
    category: null,
    context: null,
    firstChapter: null,
    lastChapter: null,
    status: "current",
    evidence: null,
  };
}

function addressTerm(
  targetName: string,
  terms: string[],
  authorLocked = false
): AddressTerm {
  return { targetName, targetId: null, forms: terms.map(form), authorLocked };
}

function character(overrides: Partial<Character> = {}): Character {
  return { ...emptyCharacter("char_001", "灯"), ...overrides };
}

describe("落とす葉を取り除く", () => {
  test("呼称の1つを落とすと、その呼び方だけが消える", () => {
    const before = character({
      addressTerms: [addressTerm("中神隼人", ["ハヤブサ先生", "先生", "センパイ"])],
    });

    const { character: after, dropped } = dropDiffEntries(before, [
      "address:中神隼人:ハヤブサ先生",
    ]);

    expect(dropped).toBe(1);
    expect(after.addressTerms).toHaveLength(1);
    expect(after.addressTerms[0].forms.map((f) => f.term)).toEqual([
      "先生",
      "センパイ",
    ]);
  });

  test("その相手の呼び方が全部落ちたら、項目ごと消える", () => {
    // **空の相手を残さない。** 誰も呼んでいない相手が資料に並ぶと、
    // 次の抽出が「この人を呼ぶ言い方が抜けている」と読み直す
    const before = character({
      addressTerms: [
        addressTerm("中神隼人", ["ハヤブサ先生", "先生"]),
        addressTerm("澪", ["澪さん"]),
      ],
    });

    const { character: after, dropped } = dropDiffEntries(before, [
      "address:中神隼人:ハヤブサ先生",
      "address:中神隼人:先生",
    ]);

    expect(dropped).toBe(2);
    expect(after.addressTerms.map((term) => term.targetName)).toEqual(["澪"]);
  });

  test("関係を落とす", () => {
    const before = character({
      relations: [
        { name: "澪", relation: "同僚" },
        { name: "中神隼人", relation: "上司" },
      ],
    });

    const { character: after, dropped } = dropDiffEntries(before, [
      "relation:中神隼人:上司",
    ]);

    expect(dropped).toBe(1);
    expect(after.relations).toEqual([{ name: "澪", relation: "同僚" }]);
  });

  test("別名を落とす", () => {
    const before = character({ aliases: ["ともり", "灯ちゃん"] });

    const { character: after, dropped } = dropDiffEntries(before, [
      "alias:灯ちゃん",
    ]);

    expect(dropped).toBe(1);
    expect(after.aliases).toEqual(["ともり"]);
  });

  test("作者が固定した呼称は落とせない", () => {
    // CLAUDE.md 規則2。`authorLocked: true` の呼称エントリは変更しない
    const before = character({
      addressTerms: [addressTerm("澪", ["澪さん"], true)],
    });

    const { character: after, dropped } = dropDiffEntries(before, [
      "address:澪:澪さん",
    ]);

    expect(dropped).toBe(0);
    expect(after.addressTerms[0].forms.map((f) => f.term)).toEqual(["澪さん"]);
  });

  test("落とす鍵が1つも無ければ、元のレコードと同じ", () => {
    const before = character({
      aliases: ["ともり"],
      relations: [{ name: "澪", relation: "同僚" }],
      addressTerms: [addressTerm("澪", ["澪さん"])],
    });

    expect(dropDiffEntries(before, [])).toEqual({
      character: before,
      dropped: 0,
    });
    // 当たらない鍵を渡しても同じ
    expect(dropDiffEntries(before, ["alias:別の名"])).toEqual({
      character: before,
      dropped: 0,
    });
  });

  test("元のレコードを書き換えない", () => {
    // 落とすのは反映の直前だけ。承認待ちの中身は残す
    const before = character({ aliases: ["ともり", "灯ちゃん"] });

    dropDiffEntries(before, ["alias:灯ちゃん"]);

    expect(before.aliases).toEqual(["ともり", "灯ちゃん"]);
  });
});
