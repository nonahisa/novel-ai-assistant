import { describe, expect, test } from "vitest";
import {
  addressLastChapter,
  buildAddressListView,
  buildCharacterAddressView,
} from "../../../src/core/addressPairsView";
import {
  emptyCharacter,
  type AddressForm,
  type Character,
} from "../../../src/models/character";

/**
 * 呼び合いの一覧を第M〜N話で絞る（作者の答え 2026-11-10。設計書6.92.6）。
 *
 * 人は「範囲のどこかに両方が出たか」、呼び方は「第N話までに使われ始めたか」
 * で見る（相関図と同じ判断）。範囲が効くのは作品ぜんたいの一覧だけで、
 * 本文から開いて1話で絞っているあいだはつまみを出さない。
 */

function form(
  term: string,
  firstChapter: number | null,
  lastChapter: number | null = null
): AddressForm {
  return {
    term,
    category: null,
    context: null,
    firstChapter,
    lastChapter,
    status: "current",
    evidence: null,
  };
}

function person(
  id: string,
  name: string,
  chapters: number[],
  calls: Array<{ target: string; forms: AddressForm[] }> = []
): Character {
  return {
    ...emptyCharacter(id, name),
    appearedChapters: chapters,
    addressTerms: calls.map((call) => ({
      targetName: call.target,
      targetId: null,
      authorLocked: false,
      forms: call.forms,
    })),
  };
}

/**
 * 灰原（第1〜3・9話）→ 結（第1〜3話）：「結」第1話から
 * 結 → 灰原：「灰原くん」第1話から、「直哉」第3話から
 * 黒木（第9話だけ）→ 灰原：「灰原」第9話から
 * 手書きの人（登場話数なし）→ 灰原：「先輩」話数なし
 */
const cast: Character[] = [
  person("char_1", "灰原", [1, 2, 3, 9], [{ target: "結", forms: [form("結", 1)] }]),
  person("char_2", "結", [1, 2, 3], [
    { target: "灰原", forms: [form("灰原くん", 1), form("直哉", 3)] },
  ]),
  person("char_3", "黒木", [9], [{ target: "灰原", forms: [form("灰原", 9)] }]),
  person("char_4", "手書きの人", [], [{ target: "灰原", forms: [form("先輩", null)] }]),
];

const lines = (characters: Character[], from: number | null, to: number | null) =>
  buildAddressListView(characters, {
    chapter: null,
    showAll: false,
    range: { from, to },
  }).usable.map((line) => line.text);

describe("呼び合いの一覧を第M〜N話で絞る", () => {
  test("範囲に両方が出ていない組は落ちる", () => {
    const shown = lines(cast, 1, 2);
    expect(shown.some((text) => text.startsWith("黒木"))).toBe(false);
    expect(shown.some((text) => text.startsWith("灰原 → 結"))).toBe(true);
  });

  test("呼び方は第N話までに使われ始めたものだけ", () => {
    const early = lines(cast, 1, 2);
    const yui = early.find((text) => text.startsWith("結 → 灰原"));
    expect(yui).toContain("灰原くん");
    expect(yui).not.toContain("直哉");

    const later = lines(cast, 1, 3);
    expect(later.find((text) => text.startsWith("結 → 灰原"))).toContain("直哉");
  });

  test("第M話より前に始まった呼び方も、範囲に2人が居れば残す", () => {
    const shown = lines(cast, 3, 3);
    expect(shown.find((text) => text.startsWith("結 → 灰原"))).toContain(
      "灰原くん"
    );
  });

  test("範囲の端（M・N ちょうど）に出た人は残る", () => {
    expect(lines(cast, 9, 9).some((text) => text.startsWith("黒木"))).toBe(true);
    expect(lines(cast, 4, 8).some((text) => text.startsWith("黒木"))).toBe(false);
  });

  test("登場話数の無い人と、話数の無い呼び方は落とさない", () => {
    expect(lines(cast, 9, 9).some((text) => text.startsWith("手書きの人"))).toBe(
      true
    );
  });

  test("件数の断りに範囲が出る", () => {
    const view = buildAddressListView(cast, {
      chapter: null,
      showAll: false,
      range: { from: 2, to: 3 },
    });
    expect(view.summary).toBe(`第2話〜第3話：${view.usable.length}組`);
    expect(view.rangeSlider).toEqual({
      last: 9,
      from: 2,
      to: 3,
      text: "第2話〜第3話",
    });
  });

  test("範囲で0件になったら、範囲のせいだと分かる案内にする", () => {
    const view = buildAddressListView(cast, {
      chapter: null,
      showAll: false,
      range: { from: 5, to: 8 },
    });
    // 手書きの人→灰原 は灰原が範囲に居ないので落ちる
    expect(view.usable).toEqual([]);
    expect(view.emptyNote).toBe("第5話〜第8話の呼び合いはありません。");
  });

  test("開いたとき（範囲なし）は作品ぜんたいで、つまみは第1話〜最終話", () => {
    const view = buildAddressListView(cast, { chapter: null, showAll: false });
    expect(view.summary).toBe(`作品ぜんたい：${view.usable.length}組`);
    expect(view.rangeSlider).toEqual({
      last: 9,
      from: 1,
      to: 9,
      text: "第1話〜第9話",
    });
  });

  test("本文から開いて1話で絞っているあいだは、範囲を使わずつまみも出さない", () => {
    const view = buildAddressListView(cast, {
      chapter: 9,
      showAll: false,
      range: { from: 1, to: 2 },
    });
    expect(view.rangeSlider).toBeNull();
    expect(view.summary.startsWith("第9話に出る人どうし")).toBe(true);
    expect(view.usable.some((line) => line.text.startsWith("黒木"))).toBe(true);
  });

  test("「全部を見る」を押したあとは、範囲のつまみが使える", () => {
    const view = buildAddressListView(cast, {
      chapter: 9,
      showAll: true,
      range: { from: 1, to: 2 },
    });
    expect(view.rangeSlider?.text).toBe("第1話〜第2話");
    expect(view.usable.some((line) => line.text.startsWith("黒木"))).toBe(false);
  });

  test("最終話が1話だけの作品では、つまみを出さない", () => {
    const single = [
      person("char_1", "灰原", [1], [{ target: "結", forms: [form("結", 1)] }]),
      person("char_2", "結", [1]),
    ];
    expect(addressLastChapter(single)).toBe(1);
    expect(
      buildAddressListView(single, { chapter: null, showAll: false }).rangeSlider
    ).toBeNull();
  });

  test("人物詳細の節には範囲を効かせない", () => {
    // 範囲を渡しても、節は話の絞りだけで組む（会話を書きながら見るため）
    const withRange = buildCharacterAddressView(cast, "char_1", {
      chapter: null,
      showAll: false,
      range: { from: 1, to: 2 },
    });
    const without = buildCharacterAddressView(cast, "char_1", {
      chapter: null,
      showAll: false,
    });
    expect(withRange).toEqual(without);
  });
});
