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
  it("削らない・補ったら印を付ける・字数の区切りは決まっているときだけ", () => {
    expect(PLOT_SUMMARY_SYSTEM_PROMPT).toContain("削らないこと");
    expect(PLOT_SUMMARY_SYSTEM_PROMPT).toContain(`「${PLOT_SUPPLEMENT_MARK}」を付けること`);
    expect(PLOT_SUMMARY_SYSTEM_PROMPT).toContain("目標の文字数が決まっているときだけ");
    expect(PLOT_SUMMARY_SYSTEM_PROMPT).toContain("決まっていないことを、決まったように書かないこと");
    for (const section of PLOT_DIALOGUE_SECTIONS) {
      expect(PLOT_SUMMARY_SYSTEM_PROMPT).toContain(`- ${section.key}：`);
    }
  });

  it("「目安」の言葉を使わない（gemma4:26b が「（結末の目安：執筆時に設定）」として返した。CLAUDE.md 失敗3）", () => {
    expect(PLOT_SUMMARY_SYSTEM_PROMPT).not.toContain("目安");
  });
});

describe("材料", () => {
  it("作者の答えそのものを、いま入っている項目ごとに渡す。型で見出しが変わる", () => {
    const prompt = buildPlotSummaryPrompt({
      workTitle: "回線の街",
      idea: "中級エリアで配線が切れる",
      ideaHeading: "作者が書きたい場面",
      writtenPlot: "",
      decisions: [
        { topic: "最強の理由", answer: "回線が魔力も運ぶ", section: "worldview" },
        { topic: "書きたい場面", answer: "中級エリアで配線が切れる", section: "outline" },
        { topic: "場面の直前", answer: "新人が初めて現場に出る", section: "outline" },
      ],
    });
    expect(prompt).toContain("# 作者が書きたい場面\n中級エリアで配線が切れる");
    expect(prompt).toContain("## worldview\n- 【最強の理由】回線が魔力も運ぶ");
    expect(prompt).toContain(
      "## outline\n- 【書きたい場面】中級エリアで配線が切れる\n- 【場面の直前】新人が初めて現場に出る"
    );
    // 答えの後ろに括弧書きを付けない（括弧書きごと写して返ってくる）
    expect(prompt).not.toContain("目安");
    expect(prompt).not.toMatch(/運ぶ（/u);
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
