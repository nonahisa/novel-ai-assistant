import { describe, expect, it } from "vitest";
import { buildLocationResolver } from "../../../src/core/locationConsistency";
import { buildSceneClock } from "../../../src/core/sceneClock";
import {
  buildWhereabouts,
  placeTextOf,
  resolvePlace,
} from "../../../src/core/whereabouts";
import { parseLocation, type Location } from "../../../src/models/location";
import type { StoryFact } from "../../../src/models/storyFact";

/**
 * 事実から所在を組む（設計書6.88）。場所の引き方は名前と別名の完全一致だけ
 * （母艦の判断 2026-10-25。部分一致は誤検出の元）。
 */

function fact(overrides: Partial<StoryFact> & { id: string }): StoryFact {
  return {
    chapter: 1,
    lineRange: [1, 1],
    subject: "char_001",
    predicate: "所在",
    value: "王都",
    kind: "state",
    storyTime: null,
    modality: "narration",
    pov: null,
    speaker: null,
    topic: null,
    ...overrides,
  };
}

function place(id: string, name: string, aliases: string[] = []): Location {
  return parseLocation({ id, name, aliases });
}

const resolver = buildLocationResolver([
  place("loc_1", "王都", ["リヴェルス"]),
  place("loc_2", "港町"),
  place("loc_3", "はるか村"),
]);

describe("値から場所の名前を取り出す", () => {
  it("居場所の項目名なら値そのもの、着いた出来事なら着いた先", () => {
    expect(placeTextOf(fact({ id: "a" }))).toBe("王都");
    expect(placeTextOf(fact({ id: "b", predicate: "居場所", value: "港町" }))).toBe("港町");
    expect(
      placeTextOf(fact({ id: "c", predicate: "移動", kind: "event", value: "港町に着いた" }))
    ).toBe("港町");
    expect(
      placeTextOf(fact({ id: "d", predicate: "移動", kind: "event", value: "王都へ到着した。" }))
    ).toBe("王都");
  });

  /** 「発った」「向かった」は着いたかどうかを言っていない */
  it("発った・向かった出来事は所在にしない", () => {
    expect(
      placeTextOf(fact({ id: "a", predicate: "移動", kind: "event", value: "王都を発った" }))
    ).toBeNull();
    expect(
      placeTextOf(fact({ id: "b", predicate: "移動", kind: "event", value: "港町" }))
    ).toBeNull();
    expect(placeTextOf(fact({ id: "c", predicate: "所持品", value: "王都" }))).toBeNull();
    // 居場所の項目名の出来事は値を読むが、「向かった」は完全一致で引けない
    expect(
      resolvePlace(
        placeTextOf(fact({ id: "d", predicate: "所在", kind: "event", value: "港町へ向かった" })) ?? "",
        resolver
      )
    ).toBeNull();
  });

  /** gemma4:26b は「その頃、リナは港町にいた」を「所在＝港町（event）」で返した（2026-10-25） */
  it("居場所の項目名なら、出来事でも値を読む", () => {
    expect(
      placeTextOf(fact({ id: "a", predicate: "所在", kind: "event", value: "港町" }))
    ).toBe("港町");
  });
});

describe("場所を引く", () => {
  it("名前と別名の完全一致", () => {
    expect(resolvePlace("王都", resolver)).toBe("loc_1");
    expect(resolvePlace("リヴェルス", resolver)).toBe("loc_1");
  });

  /**
   * 作者の選択③（2026-10-25）。旅の台で値が「港町の宿」「王都の城門」のように場所の名前で
   * なく、完全一致では引けなかった（26b：所在の事実15件→引けた10件）。
   */
  it("台帳の名前（別名）がちょうど1つだけ含まれるなら、その場所に引く", () => {
    expect(resolvePlace("港町の宿", resolver)).toBe("loc_2");
    expect(resolvePlace("リヴェルスの城門の詰所", resolver)).toBe("loc_1");
    // 名前と別名が両方出ても、同じ場所なら1つ
    expect(resolvePlace("王都リヴェルスの城門", resolver)).toBe("loc_1");
  });

  it("2か所の名前を含むもの・1つも含まないものは引かない", () => {
    expect(resolvePlace("港町の宿で王都の手紙を読む", resolver)).toBeNull();
    expect(resolvePlace("灯台の上", resolver)).toBeNull();
    expect(resolvePlace("その人波の中", resolver)).toBeNull();
  });

  /** 「港町へ向かった」は向かった先にいたことを言っていない（着いた結びと同じ考え） */
  it("向かった・発った値は、名前を含んでいても引かない", () => {
    expect(resolvePlace("港町へ向かった", resolver)).toBeNull();
    expect(resolvePlace("王都を発った", resolver)).toBeNull();
    expect(resolvePlace("港町を目指して", resolver)).toBeNull();
  });

  /**
   * 入れ子の組（港は港町の中）。「港町の宿」は字面では「港」も含むが、それは「港町」の
   * 一部なので数えない。そうしないと例の「港町の宿」が2か所になって引けない
   */
  it("長い名前の一部として出た短い名前は数えない", () => {
    const nested = buildLocationResolver([
      place("loc_2", "港町"),
      place("loc_3", "港"),
    ]);
    expect(resolvePlace("港町の宿", nested)).toBe("loc_2");
    expect(resolvePlace("港の桟橋", nested)).toBe("loc_3");
    // 港と港町が別々に出るのは2か所（含みの数え方は値まるごとで、切れ目のうしろは試さない）
    expect(resolvePlace("港から港町の宿", nested)).toBeNull();
    expect(resolvePlace("港と港町", nested)).toBeNull();
  });

  it("主語や起点の後ろを試す。名前の中の字では割らない", () => {
    expect(resolvePlace("エドは港町", resolver)).toBe("loc_2");
    expect(resolvePlace("王都から港町", resolver)).toBe("loc_2");
    expect(resolvePlace("はるか村", resolver)).toBe("loc_3");
  });

  it("「港町と王都」のような2か所の値は引かない", () => {
    expect(resolvePlace("港町と王都", resolver)).toBeNull();
  });
});

describe("所在を組む", () => {
  const clock = buildSceneClock([
    { filePath: "1.txt", chapter: 1, text: "　王都にいた。\n　＊\n　翌朝、港町に着いた。" },
  ]);
  const places = new Map([
    ["f1", { filePath: "1.txt", line: 1 }],
    ["f2", { filePath: "1.txt", line: 3 }],
    ["f3", { filePath: "1.txt", line: 1 }],
  ]);

  it("地の文だけを使い、工程ごとに数える", () => {
    const result = buildWhereabouts({
      facts: [
        fact({ id: "f1" }),
        fact({ id: "f2", predicate: "移動", kind: "event", value: "港町に着いた" }),
        // 台詞の地名は、その人の居場所を言っていない
        fact({ id: "f3", value: "港町", modality: "dialogue" }),
        // 台帳に無い
        fact({ id: "f4", value: "市場" }),
      ],
      places,
      resolver,
      clock,
    });
    expect(result.stats).toEqual({ whereaboutsFacts: 4, resolved: 2, clocked: 2 });
    expect(result.entries.map((entry) => [entry.factId, entry.locationId])).toEqual([
      ["f1", "loc_1"],
      ["f2", "loc_2"],
    ]);
    expect(result.entries[1].clock).toMatchObject({ dayLow: 1, dayHigh: 1 });
  });

  it("本文の場所が分からない事実は、時計を持たない", () => {
    const result = buildWhereabouts({
      facts: [fact({ id: "f9" })],
      places,
      resolver,
      clock,
    });
    expect(result.entries[0].clock).toBeNull();
    expect(result.stats.clocked).toBe(0);
  });
});
