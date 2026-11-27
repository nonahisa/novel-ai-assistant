import { describe, expect, test } from "vitest";
import {
  emptyNotationChoiceSet,
  notationChoiceFileBody,
  parseNotationChoiceSet,
  withNotationChoice,
} from "../../../src/models/notationChoice";

describe("表記の決めごと（設定/notation_choices.json。設計書6.8.9）", () => {
  test("壊れた形は例外にする（空として書き足すと、作者の決めごとが消える）", () => {
    expect(() => parseNotationChoiceSet([])).toThrow();
    expect(() => parseNotationChoiceSet({ choices: "出来る" })).toThrow();
  });

  test("表記か読みの欠けた件・かなでない読み・同じ読みの2件目は読み飛ばす", () => {
    const set = parseNotationChoiceSet({
      choices: [
        { surface: "出来る", reading: "できる", decidedAt: "2026-11-21" },
        { surface: "", reading: "すべて" },
        { surface: "綺麗", reading: "キレイ" },
        { surface: "できる", reading: "できる" },
        "良い",
      ],
    });
    expect(set.choices).toEqual([
      { surface: "出来る", reading: "できる", decidedAt: "2026-11-21" },
    ]);
  });

  test("読み飛ばした件も、書き戻すときに消さない（作者が手で書いたもの。実装ルール2）", () => {
    const raw = {
      choices: [
        { surface: "出来る", reading: "できる", decidedAt: "2026-11-21" },
        { surface: "", reading: "すべて" },
        { surface: "綺麗", reading: "キレイ" },
        { surface: "できる", reading: "できる" },
        "良い",
      ],
    };
    const set = parseNotationChoiceSet(raw);
    const next = withNotationChoice(set, { surface: "分かる", reading: "わかる", decidedAt: "2026-11-27" });
    expect(next).toBeDefined();
    if (!next) return;
    const written = notationChoiceFileBody(next);
    expect(written.choices).toEqual([
      { surface: "出来る", reading: "できる", decidedAt: "2026-11-21" },
      { surface: "分かる", reading: "わかる", decidedAt: "2026-11-27" },
      { surface: "", reading: "すべて" },
      { surface: "綺麗", reading: "キレイ" },
      { surface: "できる", reading: "できる" },
      "良い",
    ]);
    // 書いたものを読み直しても、使う決めごとは変わらない（2件目の「できる」は先の件が勝つ）
    expect(parseNotationChoiceSet(written).choices).toEqual(next.choices);
  });

  test("選び直したら同じ読みの前の決めごとを置き換える。同じなら書かない", () => {
    const first = withNotationChoice(emptyNotationChoiceSet(), {
      surface: "出来る",
      reading: "できる",
      decidedAt: "2026-11-20",
    });
    expect(first?.choices).toHaveLength(1);
    if (!first) return;
    expect(
      withNotationChoice(first, { surface: "出来る", reading: "できる", decidedAt: "2026-11-21" })
    ).toBeUndefined();
    const changed = withNotationChoice(first, {
      surface: "できる",
      reading: "できる",
      decidedAt: "2026-11-21",
    });
    expect(changed?.choices).toEqual([
      { surface: "できる", reading: "できる", decidedAt: "2026-11-21" },
    ]);
    // 元の一覧は変えない
    expect(first.choices[0].surface).toBe("出来る");
  });
});
