import { describe, expect, test } from "vitest";
import { detectNarrator } from "../../../src/core/narrator";
import { emptyCharacter, type Character } from "../../../src/models/character";

/**
 * 地の文の「俺」が誰かを名指しする（設計書6.10.6）。
 *
 * **推測で決め打ちしない**のがここの要である。同じ一人称を使う人物は
 * いくらでもいる（作者の指摘：「『僕』はキャラごとに独自ということは
 * ないと思いますが……」）ので、**候補が1人に絞れるときだけ**言う。
 */

function person(options: {
  id: string;
  name: string;
  firstPerson?: string | null;
  variants?: string[];
}): Character {
  return {
    ...emptyCharacter(options.id, options.name),
    firstPerson: {
      default: options.firstPerson ?? null,
      variants: (options.variants ?? []).map((form) => ({
        form,
        context: null,
        chapters: [],
        evidence: null,
      })),
    },
  };
}

/**
 * 地の文だけの本文を作る。
 *
 * `detectFirstPerson` は「台詞を落として500字以上」「10回以上」を条件に
 * するので、短い見本では**いつでも null** になってしまう。
 */
function narration(word: string, times = 14): string {
  return Array.from(
    { length: times },
    (_, index) =>
      `${word}は坂の下で足を止めた。息が白く濁って、街灯の光がゆっくりとにじんでいく。` +
      `冬の匂いがした。${index}`
  ).join("\n");
}

describe("語り手を名指しする", () => {
  test("一人称が一致する人物が1人だけなら、その人を返す", () => {
    const haruto = person({
      id: "char_001",
      name: "相沢 春人",
      firstPerson: "俺",
    });
    const chinatsu = person({
      id: "char_002",
      name: "黒瀬 千夏",
      firstPerson: "私",
    });

    expect(
      detectNarrator({
        narrationText: narration("俺"),
        people: [haruto, chinatsu],
      })
    ).toEqual({ firstPerson: "俺", name: "相沢 春人" });
  });

  test("場面によって変える一人称（variants）でも当たる", () => {
    const haruto = person({
      id: "char_001",
      name: "相沢 春人",
      firstPerson: null,
      variants: ["俺"],
    });

    expect(
      detectNarrator({ narrationText: narration("俺"), people: [haruto] })
    ).toEqual({ firstPerson: "俺", name: "相沢 春人" });
  });

  test("同じ一人称の人物が2人いたら黙る", () => {
    // **一人称から人物を決めない**（作者の裁定）。「俺」を使う人物は
    // いくらでもいるので、絞れないときは何も言わない
    const haruto = person({
      id: "char_001",
      name: "相沢 春人",
      firstPerson: "俺",
    });
    const goichi = person({
      id: "char_003",
      name: "蓬田 吾一",
      firstPerson: "俺",
    });

    expect(
      detectNarrator({
        narrationText: narration("俺"),
        people: [haruto, goichi],
      })
    ).toBeNull();
  });

  test("同じ人物の資料が2件あっても、名前が同じなら1人と数える", () => {
    // 重複した資料があるというだけの理由で、語り手を言えなくしない
    const first = person({
      id: "char_001",
      name: "相沢 春人",
      firstPerson: "俺",
    });
    const duplicated = person({
      id: "char_009",
      name: "相沢 春人",
      firstPerson: "俺",
    });

    expect(
      detectNarrator({
        narrationText: narration("俺"),
        people: [first, duplicated],
      })
    ).toEqual({ firstPerson: "俺", name: "相沢 春人" });
  });

  test("一人称が一致する人物が1人もいなければ黙る", () => {
    const chinatsu = person({
      id: "char_002",
      name: "黒瀬 千夏",
      firstPerson: "私",
    });

    expect(
      detectNarrator({ narrationText: narration("俺"), people: [chinatsu] })
    ).toBeNull();
  });

  test("一人称が登録されていない人物しかいなければ黙る", () => {
    const goichi = person({ id: "char_003", name: "蓬田 吾一" });

    expect(
      detectNarrator({ narrationText: narration("俺"), people: [goichi] })
    ).toBeNull();
  });

  test("似た一人称は別の語として扱う（部分一致で拾わない）", () => {
    const haruto = person({
      id: "char_001",
      name: "相沢 春人",
      firstPerson: "俺様",
    });

    expect(
      detectNarrator({ narrationText: narration("俺"), people: [haruto] })
    ).toBeNull();
  });

  test("地の文が短くて一人称を決められなければ黙る", () => {
    // 数え方は `detectFirstPerson` のまま（台詞を落として500字未満は決めない）
    const haruto = person({
      id: "char_001",
      name: "相沢 春人",
      firstPerson: "俺",
    });

    expect(
      detectNarrator({
        narrationText: "俺は坂の下で足を止めた。",
        people: [haruto],
      })
    ).toBeNull();
  });

  test("三人称の本文では黙る", () => {
    const haruto = person({
      id: "char_001",
      name: "相沢 春人",
      firstPerson: "俺",
    });

    expect(
      detectNarrator({
        narrationText: narration("春人"),
        people: [haruto],
      })
    ).toBeNull();
  });

  test("台詞の中の一人称は数えない（語り手のものとは限らない）", () => {
    // 地の文は三人称、台詞だけが「俺」。ここで「俺」を語り手の一人称と
    // すると、喋っている別人を語り手だと言うことになる
    const haruto = person({
      id: "char_001",
      name: "相沢 春人",
      firstPerson: "俺",
    });
    const text = Array.from(
      { length: 14 },
      (_, index) =>
        `「俺が行く」春人は坂の下で足を止めた。息が白く濁って、街灯の光が` +
        `ゆっくりとにじんでいく。冬の匂いがした。${index}`
    ).join("\n");

    expect(detectNarrator({ narrationText: text, people: [haruto] })).toBeNull();
  });

  test("材料に載っていない人物は渡さない（渡さなければ名指ししない）", () => {
    // 呼ぶ側（`relevantFor`）は、材料に載った人物だけを渡す約束である。
    // 載っていない人物を「地の文の『俺』はこの人です」とは言えない
    expect(
      detectNarrator({ narrationText: narration("俺"), people: [] })
    ).toBeNull();
  });
});
