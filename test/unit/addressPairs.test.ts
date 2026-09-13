import { describe, expect, test } from "vitest";
import {
  addressesOf,
  buildAddressPairs,
  describePair,
  describeUse,
  pairsInChapter,
  useCoversChapter,
  ADDRESS_ISSUE_LABELS,
  type AddressUse,
} from "../../src/core/addressPairs";
import { emptyCharacter } from "../../src/models/character";
import type { AddressTerm, Character } from "../../src/models/character";

/**
 * **登場人物どうしの呼び合い**（設計書6.92）。
 *
 * 作者の依頼（2026-09-13）：「人物設定のパネルに、登場人物間の二人称を
 * 表示させることは可能でしょうか？　本編から開いている場合には、その話で
 * 登場している人物のみ表示するとか。」
 *
 * **AIを呼ばない。** 材料は人物レコードの `addressTerms` にもう入っている。
 *
 * ここで守るのは2つ。**壊れている組を黙って捨てないこと**と、
 * **話で絞ったときに使えるものが残ること**である。
 */

function person(
  id: string,
  name: string,
  options: {
    aliases?: string[];
    chapters?: number[];
    terms?: AddressTerm[];
  } = {}
): Character {
  return {
    ...emptyCharacter(),
    id,
    name,
    aliases: options.aliases ?? [],
    appearedChapters: options.chapters ?? [],
    addressTerms: options.terms ?? [],
  };
}

function term(
  targetName: string,
  forms: Array<Partial<AddressUse> & { term: string }>,
  targetId: string | null = null
): AddressTerm {
  return {
    targetName,
    targetId,
    authorLocked: false,
    forms: forms.map((form) => ({
      term: form.term,
      category: form.category ?? null,
      context: form.context ?? null,
      firstChapter: form.firstChapter ?? null,
      lastChapter: form.lastChapter ?? null,
      status: form.status ?? "current",
      evidence: null,
    })),
  };
}

describe("呼び合いを組み立てる", () => {
  const cast = [
    person("char_1", "灰原直哉", {
      chapters: [1, 2, 3],
      terms: [term("香坂結", [{ term: "結", firstChapter: 1, lastChapter: 3 }])],
    }),
    person("char_2", "香坂結", {
      chapters: [1, 2, 3],
      terms: [term("灰原直哉", [{ term: "灰原くん", firstChapter: 1 }])],
    }),
  ];

  test("互いの呼び方が、向きごとに1組ずつになる", () => {
    const { usable, needsCheck } = buildAddressPairs(cast);
    expect(needsCheck).toEqual([]);
    expect(usable.map(describePair)).toEqual([
      "灰原直哉 → 香坂結：結（第1〜3話）",
      "香坂結 → 灰原直哉：灰原くん（第1話から）",
    ]);
  });

  test("**同じ相手への呼び方はまとめる**（1人が2行に割れない）", () => {
    const [pair] = buildAddressPairs([
      person("char_1", "灰原直哉", {
        terms: [
          term("香坂結", [{ term: "結" }]),
          term("香坂結", [{ term: "香坂さん", status: "past" }]),
        ],
      }),
      person("char_2", "香坂結"),
    ]).usable;
    expect(pair.uses).toHaveLength(2);
    expect(describePair(pair)).toBe(
      "灰原直哉 → 香坂結：結・香坂さん［いまは使わない］"
    );
  });

  test("姓と名を空けて書いてあれば、名だけで呼んでも当たる", () => {
    // 名前の広げ方は相関図と同じ部品（`characterNameResolve.ts`）を通る。
    // **1文字の部分は広げない**（普通名詞と重なりやすい）ので、
    // 2文字以上の名で確かめる
    const { usable } = buildAddressPairs([
      person("char_1", "灰原直哉", {
        terms: [term("美結", [{ term: "美結さん" }])],
      }),
      person("char_2", "香坂 美結"),
    ]);
    expect(usable[0]?.toId).toBe("char_2");
    expect(usable[0]?.toName).toBe("香坂 美結");
  });

  /**
   * **区切りの無い名前は、勝手に分けない。**
   *
   * 「香坂結」から「結」を作ると、日本語の名前では当て推量になる
   * （どこが姓でどこが名かは字面から決まらない）。当たらなかった相手は
   * 要確認へ残るので、作者は別名を足して直せる——黙って別人へ結ぶより
   * そのほうがよい。
   */
  test("区切りの無い名前は分けない（当て推量で別人へ結ばない）", () => {
    const { usable, needsCheck } = buildAddressPairs([
      person("char_1", "灰原直哉", { terms: [term("結", [{ term: "結さん" }])] }),
      person("char_2", "香坂結"),
    ]);
    expect(usable).toEqual([]);
    expect(needsCheck[0]?.issue).toBe("notFound");
  });

  test("idがあれば信じる。指し先が消えていたら名前で引き直す", () => {
    const { usable } = buildAddressPairs([
      person("char_1", "灰原直哉", {
        // 消えたidを持っている（改名・統合の名残）
        terms: [term("香坂結", [{ term: "結" }], "char_999")],
      }),
      person("char_2", "香坂結"),
    ]);
    expect(usable[0]?.toId).toBe("char_2");
  });
});

/**
 * **壊れている組を、黙って捨てない**（作者の裁定、2026-09-13）。
 *
 * 実データ（ハイエルフ未亡人、呼び方48件）では**25件が自分あて**だった。
 * 抽出が「呼び方」と「呼ばれ方」を取り違えている。捨てると、抽出が
 * 壊れていることに気づく機会が消える。
 */
describe("要確認に分ける", () => {
  test("**自分あては、使えるほうへ混ぜない**", () => {
    const { usable, needsCheck } = buildAddressPairs([
      person("char_1", "灰原直哉", {
        terms: [term("灰原直哉", [{ term: "灰原くん", context: "香坂から" }])],
      }),
    ]);
    expect(usable).toEqual([]);
    expect(needsCheck[0]?.issue).toBe("self");
    // **呼ばれ方として拾われたことが読める**ように、状況を落とさない
    expect(describePair(needsCheck[0])).toContain("香坂から");
  });

  test("別名で自分を指していても、自分あてと分かる", () => {
    const { needsCheck } = buildAddressPairs([
      person("char_1", "灰原直哉", {
        aliases: ["直哉"],
        terms: [term("直哉", [{ term: "直哉くん" }])],
      }),
    ]);
    expect(needsCheck[0]?.issue).toBe("self");
  });

  test("資料に無い相手は、名前を残したまま要確認へ", () => {
    const { needsCheck } = buildAddressPairs([
      person("char_1", "灰原直哉", { terms: [term("俺", [{ term: "あなた" }])] }),
    ]);
    expect(needsCheck[0]?.issue).toBe("notFound");
    expect(needsCheck[0]?.toName).toBe("俺");
    expect(needsCheck[0]?.toId).toBeNull();
  });

  test("同じ名前が複数居たら、どちらへも結ばない", () => {
    const { usable, needsCheck } = buildAddressPairs([
      person("char_1", "灰原直哉", {
        terms: [term("美結", [{ term: "美結さん" }])],
      }),
      person("char_2", "香坂 美結"),
      person("char_3", "白石 美結"),
    ]);
    expect(usable).toEqual([]);
    expect(needsCheck[0]?.issue).toBe("ambiguous");
  });

  test("理由には、作者に読める名前が付いている", () => {
    for (const label of Object.values(ADDRESS_ISSUE_LABELS)) {
      expect(label.length).toBeGreaterThan(2);
    }
  });

  test("呼び方が空の項目は、要確認にも出さない", () => {
    // 中身の無いものを「要確認」に並べても、作者にできることが無い
    const { usable, needsCheck } = buildAddressPairs([
      person("char_1", "灰原直哉", { terms: [term("香坂結", [{ term: "  " }])] }),
      person("char_2", "香坂結"),
    ]);
    expect(usable).toEqual([]);
    expect(needsCheck).toEqual([]);
  });
});

/**
 * **その話に出る人どうしだけにする**（作者の依頼、2026-09-13
 * 「本編から開いている場合には、その話で登場している人物のみ表示するとか」）。
 */
describe("話で絞る", () => {
  const cast = [
    person("char_1", "灰原直哉", {
      chapters: [1, 2],
      terms: [
        term("香坂結", [{ term: "結" }]),
        term("白石透", [{ term: "白石" }]),
      ],
    }),
    person("char_2", "香坂結", { chapters: [1, 2] }),
    person("char_3", "白石透", { chapters: [5] }),
  ];

  test("**両方がその話に出ている組だけ残る**", () => {
    const { usable } = buildAddressPairs(cast);
    expect(usable).toHaveLength(2);
    const here = pairsInChapter(usable, 1, cast);
    expect(here.map(describePair)).toEqual(["灰原直哉 → 香坂結：結"]);
  });

  test("片方しか出ていない話では、その組は出ない", () => {
    const { usable } = buildAddressPairs(cast);
    // 第5話に出るのは白石だけ。灰原が出ていないので呼び合いにならない
    expect(pairsInChapter(usable, 5, cast)).toEqual([]);
  });

  /**
   * **登場話数を持たない人物を落とさない。**
   *
   * 空なのは「出ていない」ではなく「まだ数えていない」ことがある
   * （作者が手で足したレコード）。落とすと、手で書いた人物だけが黙って消える。
   */
  test("登場話数が空の人物は、どの話でも残す", () => {
    const hand = [
      person("char_1", "灰原直哉", {
        terms: [term("香坂結", [{ term: "結" }])],
      }),
      person("char_2", "香坂結"),
    ];
    const { usable } = buildAddressPairs(hand);
    expect(pairsInChapter(usable, 99, hand)).toHaveLength(1);
  });

  test("資料に無い相手は、話で落とさない（居るかどうかが分からない）", () => {
    const cast2 = [
      person("char_1", "灰原直哉", {
        chapters: [1],
        terms: [term("誰か", [{ term: "あんた" }])],
      }),
    ];
    const { needsCheck } = buildAddressPairs(cast2);
    expect(pairsInChapter(needsCheck, 1, cast2)).toHaveLength(1);
  });
});

describe("その話で使っている呼び方か", () => {
  const use = (
    first: number | null,
    last: number | null
  ): AddressUse => ({
    term: "結",
    category: null,
    context: null,
    firstChapter: first,
    lastChapter: last,
    status: "current",
  });

  test("範囲の中なら使っている", () => {
    expect(useCoversChapter(use(3, 11), 5)).toBe(true);
    expect(useCoversChapter(use(3, 11), 3)).toBe(true);
    expect(useCoversChapter(use(3, 11), 11)).toBe(true);
  });

  test("範囲の外なら使っていない", () => {
    expect(useCoversChapter(use(3, 11), 1)).toBe(false);
    expect(useCoversChapter(use(3, 11), 12)).toBe(false);
  });

  test("**範囲が無いものは「使っている」と読む**", () => {
    // 話数が入っていないのは抽出が取れなかっただけで、
    // 使っていない証拠ではない
    expect(useCoversChapter(use(null, null), 7)).toBe(true);
    expect(useCoversChapter(use(3, null), 99)).toBe(true);
    expect(useCoversChapter(use(null, 3), 1)).toBe(true);
  });
});

describe("ある人物から見た呼び合い", () => {
  const cast = [
    person("char_1", "灰原直哉", {
      terms: [term("香坂結", [{ term: "結" }])],
    }),
    person("char_2", "香坂結", {
      terms: [term("灰原直哉", [{ term: "灰原くん" }])],
    }),
  ];

  test("呼ぶほうと呼ばれるほうを、別々に取れる", () => {
    const { usable } = buildAddressPairs(cast);
    const view = addressesOf(usable, "char_1");
    expect(view.calls.map(describePair)).toEqual(["灰原直哉 → 香坂結：結"]);
    expect(view.calledBy.map(describePair)).toEqual([
      "香坂結 → 灰原直哉：灰原くん",
    ]);
  });
});

describe("1行の書き方", () => {
  const base: AddressUse = {
    term: "結",
    category: null,
    context: null,
    firstChapter: null,
    lastChapter: null,
    status: "current",
  };

  test("**話数が無いときは、断りを足さない**", () => {
    // 無いもののほうが多いので、「（話数不明）」ばかりが並ぶ形にしない
    expect(describeUse(base)).toBe("結");
  });

  test("1話だけなら「第3話」、続いていれば「第3話から」", () => {
    expect(describeUse({ ...base, firstChapter: 3, lastChapter: 3 })).toBe(
      "結（第3話）"
    );
    expect(describeUse({ ...base, firstChapter: 3 })).toBe("結（第3話から）");
    expect(describeUse({ ...base, lastChapter: 3 })).toBe("結（第3話まで）");
  });

  test("状況と、いま使っていないことを添える", () => {
    expect(
      describeUse({ ...base, context: "人前では", status: "past" })
    ).toBe("結／人前では［いまは使わない］");
  });
});
