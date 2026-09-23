import { describe, expect, test } from "vitest";
import {
  defaultTarget,
  groupOkuriganaVariants,
  isOkuriganaVariant,
  kanjiSkeleton,
  OKURIGANA_GROUPS,
  segment,
} from "../../src/core/okuriganaVariants";

/**
 * 送り仮名ゆれ（設計書6.13.6）。
 *
 * **設計書がこれを未実装にしていた理由は、活用形と見分けられないこと。**
 *
 * > 漢字の骨格が同じ語を機械的に束ねる方法はあるが、
 * > 「行った／行く」のような別語まで巻き込む。
 *
 * 見分け方は「**短いほうが、長いほうの末尾になっているか**」。
 * 送り仮名は語尾から付くので、付け方が違っても語尾は変わらない。
 * 活用すると語尾そのものが変わるので、この関係が崩れる。
 */
describe("**活用形を巻き込まない**", () => {
  test.each([
    ["行った", "行く"],
    ["書いた", "書く"],
    ["話した", "話す"],
    ["読んで", "読む"],
    ["立った", "立つ"],
  ])("活用形は組にしない: %s / %s", (a, b) => {
    expect(isOkuriganaVariant(a, b)).toBe(false);
  });

  test("骨格が同じでも、活用形なら束ねない", () => {
    // 「行」で始まる語がまとめて挙がってはいけない
    expect(groupOkuriganaVariants(["行った", "行く", "行けば"])).toEqual([]);
  });
});

describe("送り仮名ゆれとして拾う", () => {
  test.each([
    ["行なう", "行う"],
    ["表わす", "表す"],
    ["現われる", "現れる"],
    ["落ちる", "落る"],
    ["終わる", "終る"],
  ])("拾う: %s / %s", (a, b) => {
    expect(isOkuriganaVariant(a, b)).toBe(true);
  });

  test("送り仮名が途中にある語も拾う", () => {
    expect(isOkuriganaVariant("打ち合わせ", "打合せ")).toBe(true);
    expect(isOkuriganaVariant("申し込み", "申込み")).toBe(true);
  });

  test("同じ語は組にしない", () => {
    expect(isOkuriganaVariant("行う", "行う")).toBe(false);
  });

  test("漢字が違えば組にしない", () => {
    expect(isOkuriganaVariant("行う", "言う")).toBe(false);
  });

  test("漢字の数が違えば組にしない", () => {
    expect(isOkuriganaVariant("打ち合わせ", "打つ")).toBe(false);
  });
});

describe("語を区切る", () => {
  test("漢字ごとに、後ろの仮名を付ける", () => {
    expect(segment("打ち合わせ")).toEqual([
      { kanji: "打", kana: "ち" },
      { kanji: "合", kana: "わせ" },
    ]);
  });

  test("仮名で始まる語は扱わない", () => {
    // **語の切れ目が決められない**
    expect(segment("うち合わせ")).toBeNull();
  });

  test("記号や英数字が混ざる語は扱わない", () => {
    expect(segment("第1話")).toBeNull();
    expect(segment("行う。")).toBeNull();
  });

  test("骨格は漢字だけを並べる", () => {
    expect(kanjiSkeleton("打ち合わせ")).toBe("打合");
    expect(kanjiSkeleton("打合せ")).toBe("打合");
  });
});

describe("束ねる", () => {
  test("同じ骨格のものを1つの組にする", () => {
    const groups = groupOkuriganaVariants(["行なう", "行う"]);

    expect(groups).toHaveLength(1);
    expect(groups[0].sort()).toEqual(["行う", "行なう"].sort());
  });

  test("同じ語が2回来ても1つに数える", () => {
    expect(groupOkuriganaVariants(["行なう", "行う", "行なう"])[0]).toHaveLength(
      2
    );
  });

  test("1つしか無ければ組にしない", () => {
    expect(groupOkuriganaVariants(["行なう"])).toEqual([]);
  });

  test("同じ骨格に、ゆれと活用形が混ざっていても分けられる", () => {
    // 「行なう／行う」は組にし、「行った」は巻き込まない
    const groups = groupOkuriganaVariants(["行なう", "行う", "行った"]);

    expect(groups).toHaveLength(1);
    expect(groups[0]).not.toContain("行った");
  });
});

describe("揃える先の既定", () => {
  test("送り仮名の多いほうを既定にする", () => {
    // **どちらが正しいとも言えない。** 迷ったときに読み間違えにくいほう
    expect(defaultTarget(["行う", "行なう"])).toBe("行なう");
  });

  test("同じ長さなら決まった順で選ぶ（結果がぶれない）", () => {
    expect(defaultTarget(["終わる", "終える"])).toBe(
      defaultTarget(["終える", "終わる"])
    );
  });
});

/**
 * **分けられない組がある。** 読み仮名の辞書が無い以上、ここは無理である。
 * 確信度を下げて出し、作者が「無視」や「直さない語」で外せるようにする。
 */
describe("分けられないことを、隠さない", () => {
  test("読みの違う別語を、ゆれとして拾ってしまう", () => {
    // 上がる（あがる）と 上る（のぼる）は別の語だが、
    // 「る」は「がる」の末尾なので拾ってしまう
    expect(isOkuriganaVariant("上がる", "上る")).toBe(true);
  });
});

/**
 * **厳選した一覧**（2026-08-19）。
 *
 * 汎用の検出は、実データで壊れていた。語の切り出しに形態素解析が要る。
 * かな⇔漢字の表記ゆれと同じく「**網羅より精度**」で一覧を持つ。
 */
describe("一覧の中身が、判定と食い違っていないか", () => {
  test.each(OKURIGANA_GROUPS.map((g) => [g.join(" / "), g] as const))(
    "%s は、互いに送り仮名ゆれと判定される",
    (_label, group) => {
      // **食い違っていたら、一覧か判定のどちらかが間違っている**
      for (let i = 1; i < group.length; i++) {
        expect(isOkuriganaVariant(group[0], group[i]), group.join("/")).toBe(
          true
        );
      }
    }
  );

  test("同じ語が2つの組に出てこない", () => {
    // **どちらへ揃えるかが決まらなくなる**
    const seen = new Set<string>();
    for (const group of OKURIGANA_GROUPS) {
      for (const word of group) {
        expect(seen.has(word), word).toBe(false);
        seen.add(word);
      }
    }
  });

  test("どの組も2つ以上ある", () => {
    for (const group of OKURIGANA_GROUPS) {
      expect(group.length, group.join("/")).toBeGreaterThanOrEqual(2);
    }
  });

  test("活用形を入れていない", () => {
    // 「行った」のような形が混ざると、一覧が膨らんで抜けが増える
    for (const group of OKURIGANA_GROUPS) {
      for (const word of group) {
        expect(word, word).not.toMatch(/(った|んだ|いた|ます|ない)$/u);
      }
    }
  });
});
