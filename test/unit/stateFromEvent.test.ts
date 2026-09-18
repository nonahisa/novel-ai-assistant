import { describe, expect, it } from "vitest";
import {
  stateBeforeEvent,
  statesBeforeEvents,
} from "../../src/core/stateFromEvent";
import type { StoryFact } from "../../src/models/storyFact";

/**
 * 出来事から、その直前まで成り立っていた状態を導く（設計書6.88.6）。
 *
 * **当てにいきすぎない。** 確実に言える形（何かが終わったと言い切っている
 * 言い回し）だけを見て、分からなければ導かない。
 */
function event(overrides: Partial<StoryFact> & { id: string }): StoryFact {
  return {
    id: overrides.id,
    chapter: 4,
    lineRange: [1, 1],
    subject: "char_0001",
    predicate: "怪我",
    value: "右足のギプスが外れた",
    kind: "event",
    storyTime: null,
    modality: "narration",
    pov: null,
    speaker: null,
    topic: null,
    ...overrides,
  };
}

describe("出来事から直前の状態を導く", () => {
  it("「〜が外れた」から、それ以前の状態を作る", () => {
    const derived = stateBeforeEvent(event({ id: "e1" }));
    expect(derived).not.toBeNull();
    expect(derived?.value).toBe("右足のギプス");
    expect(derived?.kind).toBe("state");
  });

  it("導いたものだと分かる印と、元の出来事を残す", () => {
    const derived = stateBeforeEvent(event({ id: "e1" }));
    expect(derived?.derivedFrom).toEqual({ eventId: "e1", rule: "が外れた" });
    // 元の事実と取り違えないよう、id も別にする
    expect(derived?.id).toBe("e1:derived");
  });

  it("項目・人物・場所は出来事のものを引き継ぐ", () => {
    const derived = stateBeforeEvent(event({ id: "e1" }));
    expect(derived).toMatchObject({
      subject: "char_0001",
      predicate: "怪我",
      chapter: 4,
      lineRange: [1, 1],
    });
  });

  it("治る・失う・脱ぐも同じ形で導ける", () => {
    expect(stateBeforeEvent(event({ id: "e1", value: "風邪が治った" }))?.value).toBe(
      "風邪"
    );
    expect(stateBeforeEvent(event({ id: "e2", value: "形見の鍵を失った" }))?.value).toBe(
      "形見の鍵"
    );
    expect(stateBeforeEvent(event({ id: "e3", value: "外套を脱いだ" }))?.value).toBe(
      "外套"
    );
  });

  it("前に別の文が付いていたら、最後の一区切りだけを見る", () => {
    const derived = stateBeforeEvent(
      event({ id: "e1", value: "坂を上った。右足のギプスが外れた" })
    );
    expect(derived?.value).toBe("右足のギプス");
  });

  it("あとの状態を言っている出来事からは導かない（向きが逆になる）", () => {
    expect(stateBeforeEvent(event({ id: "e1", value: "髪を黒く染めた" }))).toBeNull();
    expect(stateBeforeEvent(event({ id: "e2", value: "隊長になった" }))).toBeNull();
  });

  it("言い回しが途中にあるだけなら導かない", () => {
    expect(
      stateBeforeEvent(
        event({ id: "e1", value: "ギプスが外れた日に、坂を上った" })
      )
    ).toBeNull();
  });

  it("剥がしたあとが長すぎるものは導かない（名詞句ではなく一文である）", () => {
    expect(
      stateBeforeEvent(
        event({
          id: "e1",
          value:
            "十一月の最初の月曜に町の病院で見てもらった右足のぶあついギプスが外れた",
        })
      )
    ).toBeNull();
  });

  it("剥がしたあとが空なら導かない", () => {
    expect(stateBeforeEvent(event({ id: "e1", value: "が外れた" }))).toBeNull();
  });

  it("state の事実からは導かない（出来事だけを見る）", () => {
    expect(
      stateBeforeEvent(event({ id: "f1", kind: "state" }))
    ).toBeNull();
  });

  it("導けたものだけを並べる（導けないことは失敗ではない）", () => {
    const derived = statesBeforeEvents([
      event({ id: "e1" }),
      event({ id: "e2", value: "坂を上った" }),
      event({ id: "e3", kind: "state", value: "左の足首" }),
    ]);
    expect(derived.map((fact) => fact.id)).toEqual(["e1:derived"]);
  });
});
