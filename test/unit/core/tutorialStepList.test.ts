import { describe, expect, test } from "vitest";
import {
  buildTutorialStepItems,
  type TutorialStepMark,
} from "../../../src/core/tutorialStepList";

const steps = [
  { command: "a.cmd", label: "一つ目", why: "理由1" },
  { command: "b.cmd", label: "二つ目", why: "理由2" },
];

function build(marks: [string, TutorialStepMark][] = []) {
  return buildTutorialStepItems({
    steps,
    later: ["あとでできること"],
    marks: new Map(marks),
  });
}

describe("はじめの案内の一覧", () => {
  test("印の無い段は description が無い", () => {
    const stepItems = build().items.filter((i) => i.kind === "step");
    expect(stepItems.map((i) => i.description)).toEqual([undefined, undefined]);
  });

  test("opened の段は「開いた」が付き、行は消えない", () => {
    const list = build([["a.cmd", "opened"]]);
    const stepItems = list.items.filter((i) => i.kind === "step");
    expect(stepItems).toHaveLength(2);
    expect(stepItems[0].description).toContain("開いた");
    expect(stepItems[1].description).toBeUndefined();
  });

  test("skipped の段は「飛ばした」が付く", () => {
    const first = build([["a.cmd", "skipped"]]).items[0];
    expect(first.description).toContain("飛ばした");
    expect(first.description).not.toContain("開いた");
  });

  test("並びは 段 → 説明だけの行 → 選び直す → 案内を終える", () => {
    expect(build().items.map((i) => i.kind)).toEqual([
      "step",
      "step",
      "later",
      "back",
      "finish",
    ]);
  });

  test("全部に印が付いたときだけ allMarked が true", () => {
    expect(build().allMarked).toBe(false);
    expect(build([["a.cmd", "opened"]]).allMarked).toBe(false);
    expect(
      build([
        ["a.cmd", "opened"],
        ["b.cmd", "skipped"],
      ]).allMarked
    ).toBe(true);
  });
});
