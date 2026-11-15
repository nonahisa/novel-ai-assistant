import { describe, expect, test } from "vitest";
import {
  buildContradictionCheckPrompt,
  CONTRADICTION_CATEGORIES,
} from "../../../src/prompts/contradictionCheck";

/**
 * 矛盾検知の【組織設定】【能力設定】の欄（P-12 1.10。2026-11-15 作者の決定）。
 *
 * **空なら欄ごと出さない。** 組織・能力の資料を持たない作品では、
 * 送る文面が 1.9 と1文字も変わらないことを見張る（版は上げてあるので
 * 控えは作り直しになるが、AIが読む文面そのものは同じにしておく）。
 */
function input(
  overrides: Partial<Parameters<typeof buildContradictionCheckPrompt>[0]> = {}
) {
  return {
    chapterLabel: "第3話",
    chunkTextWithLineNumbers: "1: 冒険者ギルドの窓口で、回復魔法を頼んだ。",
    characterDetails: "名前: 月島 灯",
    locationDetails: "名前: 月見坂",
    worldviewSummary: "見出し: 通貨",
    previousSynopses: "",
    categories: CONTRADICTION_CATEGORIES,
    ...overrides,
  };
}

describe("組織・能力の欄", () => {
  test("中身があれば、場所の欄と世界観の欄のあいだに出る", () => {
    const prompt = buildContradictionCheckPrompt(
      input({
        organizationDetails: "名前: 冒険者ギルド\n説明: 依頼の仲介料を取る",
        abilityDetails: "名前: 回復魔法\n制約: 自分には使えない",
      })
    );

    const place = prompt.indexOf("【場所設定】");
    const org = prompt.indexOf("【組織設定】（本文に登場する組織のみ）");
    const ability = prompt.indexOf("【能力設定】（本文に登場する能力のみ）");
    const world = prompt.indexOf("【世界観設定】");
    expect(place).toBeGreaterThanOrEqual(0);
    expect(org).toBeGreaterThan(place);
    expect(ability).toBeGreaterThan(org);
    expect(world).toBeGreaterThan(ability);
    expect(prompt).toContain("説明: 依頼の仲介料を取る");
    expect(prompt).toContain("制約: 自分には使えない");
    // 欄と欄のあいだは、ほかの欄と同じく空行1つ
    expect(prompt).toContain(
      "名前: 月見坂\n\n【組織設定】（本文に登場する組織のみ）\n名前: 冒険者ギルド\n説明: 依頼の仲介料を取る\n\n【能力設定】"
    );
    expect(prompt).toContain("制約: 自分には使えない\n\n【世界観設定】");
  });

  test("空なら欄ごと出さず、渡さないときと1文字も変わらない", () => {
    const without = buildContradictionCheckPrompt(input());
    const empty = buildContradictionCheckPrompt(
      input({ organizationDetails: "", abilityDetails: "  " })
    );

    expect(empty).toBe(without);
    expect(without).not.toContain("【組織設定】");
    expect(without).not.toContain("【能力設定】");
    // 場所の欄と世界観の欄のあいだは、1.9 と同じく空行1つ
    expect(without).toContain("名前: 月見坂\n\n【世界観設定】");
  });

  test("片方だけでも、その欄だけが出る", () => {
    const prompt = buildContradictionCheckPrompt(
      input({ abilityDetails: "名前: 回復魔法" })
    );

    expect(prompt).not.toContain("【組織設定】");
    expect(prompt).toContain("名前: 月見坂\n\n【能力設定】（本文に登場する能力のみ）\n名前: 回復魔法\n\n【世界観設定】");
  });
});
