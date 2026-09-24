import { describe, expect, it } from "vitest";
import {
  buildPlotSummaryPrompt,
  PLOT_SUMMARY_SCHEMA,
  PLOT_SUMMARY_SYSTEM_PROMPT,
} from "../../../src/prompts/plotSummary";
import {
  PLOT_DIALOGUE_SECTIONS,
  PLOT_SUPPLEMENT_MARK,
} from "../../../src/core/plotInterview";
import { validatePlotSummary } from "../../../src/core/plotDialogueValidation";

/**
 * P-44 対話式プロット作成のまとめ（設計書6.4.7）。
 */

describe("システムの指示", () => {
  it("削らない・補ったら印を付ける・字数の区切りを付ける", () => {
    expect(PLOT_SUMMARY_SYSTEM_PROMPT).toContain("削らないこと");
    expect(PLOT_SUMMARY_SYSTEM_PROMPT).toContain(`「${PLOT_SUPPLEMENT_MARK}」を付けること`);
    expect(PLOT_SUMMARY_SYSTEM_PROMPT).toContain("字数の目安");
    for (const section of PLOT_DIALOGUE_SECTIONS) {
      expect(PLOT_SUMMARY_SYSTEM_PROMPT).toContain(`- ${section.key}：`);
    }
  });
});

describe("材料", () => {
  it("作者の答えそのものと書く先の目安を渡す。型で見出しが変わる", () => {
    const prompt = buildPlotSummaryPrompt({
      workTitle: "回線の街",
      idea: "中級エリアで配線が切れる",
      ideaHeading: "作者が書きたい場面",
      writtenPlot: "",
      decisions: [{ topic: "最強の理由", answer: "回線が魔力も運ぶ", section: "worldview" }],
    });
    expect(prompt).toContain("# 作者が書きたい場面\n中級エリアで配線が切れる");
    expect(prompt).toContain("- 【最強の理由】回線が魔力も運ぶ（書く先の目安：worldview）");
  });
});

describe("答えの形", () => {
  it("書いてよい項目だけを、すべて required で持つ（タイトル・形式・ジャンルは無い）", () => {
    expect(PLOT_SUMMARY_SCHEMA.required).toEqual(PLOT_DIALOGUE_SECTIONS.map((s) => s.key));
    expect(Object.keys(PLOT_SUMMARY_SCHEMA.properties)).not.toContain("format");
  });

  it("指示の言葉（項目の説明）がそのまま返ったら中身にしない（CLAUDE.md 失敗3）", () => {
    const echoed = Object.fromEntries(PLOT_DIALOGUE_SECTIONS.map((s) => [s.key, s.note]));
    expect(validatePlotSummary(JSON.stringify(echoed), [])).toMatchObject({ ok: false, reason: "empty" });
  });
});
