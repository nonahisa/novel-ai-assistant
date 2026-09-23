import { describe, expect, it } from "vitest";
import {
  isStoryFactError,
  parseStoryFact,
  type StoryFact,
} from "../../src/models/storyFact";

/**
 * AIが返した事実の受け取り（設計書6.88.3）。
 *
 * **AIの出力を信用しない。** 知らない `kind`／`modality` は弾く。
 * 弾いた1件で抽出全体を止めないため、例外ではなく `{ error }` を返す。
 */

const valid = {
  id: "f0412",
  chapter: 12,
  lineRange: [340, 352],
  subject: "char_006",
  predicate: "髪の色",
  value: "銀",
  kind: "static",
  storyTime: { day: 14, part: "夕" },
  modality: "narration",
  pov: "char_001",
  speaker: null,
  topic: null,
};

describe("事実を受け取る", () => {
  it("正しい形はそのまま読む", () => {
    const parsed = parseStoryFact(valid);
    expect(isStoryFactError(parsed)).toBe(false);
    expect(parsed as StoryFact).toMatchObject({
      id: "f0412",
      subject: "char_006",
      storyTime: { day: 14, part: "夕" },
    });
  });

  it("省略できる項目は null で埋める", () => {
    const parsed = parseStoryFact({
      id: "f1",
      lineRange: [0, 0],
      subject: "char_001",
      predicate: "所在",
      value: "教室",
      kind: "state",
      modality: "narration",
    });
    expect(parsed).toMatchObject({
      chapter: null,
      storyTime: null,
      pov: null,
      speaker: null,
      topic: null,
    });
  });

  it("起点より前の時期（負の日）は通す", () => {
    const parsed = parseStoryFact({
      ...valid,
      storyTime: { day: -3, part: "朝" },
    });
    expect(parsed).toMatchObject({ storyTime: { day: -3, part: "朝" } });
  });

  /** 指示語がそのまま返ってくることがあるので、必ず弾く */
  it("知らない modality は弾く", () => {
    const parsed = parseStoryFact({ ...valid, modality: "narration|dialogue" });
    expect(isStoryFactError(parsed)).toBe(true);
  });

  it("modality が無ければ弾く（勝手に narration にしない）", () => {
    const without: Record<string, unknown> = { ...valid };
    delete without.modality;
    expect(isStoryFactError(parseStoryFact(without))).toBe(true);
  });

  it("知らない kind は弾く", () => {
    expect(isStoryFactError(parseStoryFact({ ...valid, kind: "fact" }))).toBe(
      true
    );
  });

  it("知らない区分の時期は弾く", () => {
    const parsed = parseStoryFact({
      ...valid,
      storyTime: { day: 3, part: "真夜中" },
    });
    expect(isStoryFactError(parsed)).toBe(true);
  });

  it("行の範囲は非負の整数2つ", () => {
    expect(
      isStoryFactError(parseStoryFact({ ...valid, lineRange: [-1, 3] }))
    ).toBe(true);
    expect(
      isStoryFactError(parseStoryFact({ ...valid, lineRange: [3] }))
    ).toBe(true);
    expect(
      isStoryFactError(parseStoryFact({ ...valid, lineRange: [1.5, 3] }))
    ).toBe(true);
  });

  it("subject が空なら弾く", () => {
    expect(isStoryFactError(parseStoryFact({ ...valid, subject: "  " }))).toBe(
      true
    );
  });

  it("値は空でもよい（死亡イベントのように出来事だけの事実がある）", () => {
    const parsed = parseStoryFact({
      ...valid,
      predicate: "死亡",
      value: "",
      kind: "event",
    });
    expect(isStoryFactError(parsed)).toBe(false);
  });
});
