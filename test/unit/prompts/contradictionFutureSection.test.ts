import { describe, expect, test } from "vitest";
import {
  CONTRADICTION_FUTURE_SECTION_VERSION,
  FUTURE_READER_UNAWARE_NOTE,
  buildContradictionCheckPrompt,
  contradictionFuturePromptVersion,
  type ContradictionCheckInput,
} from "../../../src/prompts/contradictionCheck";
import { deniesContradiction, lacksSetting } from "../../../src/core/contradictionValidation";

/**
 * 【あとの話で判明する事実】の欄（P-12、設計書6.10.4・6.10.5）。
 *
 * さくら Kimi-K2.6 が「第5話時点で読者は知らないため、ここでは矛盾として扱わない
 * （後の話の情報を前に当てはめない原則）」と書いて、台詞の仕込みを自分で落とした
 * （`docs/measurements/2026-10-26-future-facts-sakura-kimi.md` 156行、S2 台B 試行2）。
 * 「読者がまだ知らなくても照らしてよい」が欄に書かれていなかった。
 */
const BASE: ContradictionCheckInput = {
  chapterLabel: "第5話",
  chunkTextWithLineNumbers: "1: 「明日も市役所の窓口だよ」",
  characterDetails: "遥：市役所の職員",
  locationDetails: "",
  worldviewSummary: "",
  previousSynopses: "",
  categories: ["人物"],
};

describe("あとの話で判明する事実の欄", () => {
  test("事実を渡すと、読者が知らなくても照らしてよいと書く", () => {
    const prompt = buildContradictionCheckPrompt({
      ...BASE,
      futureFacts: "- 遥の紹介（第6話で判明）: 二年前に市役所を辞めている",
    });

    expect(prompt).toContain(FUTURE_READER_UNAWARE_NOTE);
  });

  test("事実を渡さなければ、欄ごと出ない（本命の文面は変わらない）", () => {
    const prompt = buildContradictionCheckPrompt(BASE);

    expect(prompt).not.toContain(FUTURE_READER_UNAWARE_NOTE);
    expect(prompt).not.toContain("【あとの話で判明する事実】");
  });

  // 指示の言葉は、答えの中身として返ってくる（CLAUDE.md「繰り返し起きた失敗」3番）
  test("足した一文が note・設定の欄に写って返っても、検算で落ちない", () => {
    expect(deniesContradiction(FUTURE_READER_UNAWARE_NOTE)).toBe(false);
    expect(lacksSetting(FUTURE_READER_UNAWARE_NOTE)).toBe(false);
  });

  test("future の控えの鍵にだけ、欄の版が入る", () => {
    expect(contradictionFuturePromptVersion("1.9:abc")).toBe(
      `1.9:abc|future:${CONTRADICTION_FUTURE_SECTION_VERSION}`
    );
  });
});
