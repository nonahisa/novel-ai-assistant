import { describe, expect, it } from "vitest";
import {
  buildPlotDialoguePrompt,
  PLOT_DIALOGUE_SCHEMA,
  PLOT_DIALOGUE_SYSTEM_PROMPT,
} from "../../../src/prompts/plotDialogue";
import {
  PLOT_DIALOGUE_LIMITS,
  validatePlotDialogueAnswer,
} from "../../../src/core/plotDialogueValidation";
import { PLOT_DIALOGUE_SECTIONS } from "../../../src/core/plotInterview";

/**
 * P-43 対話式プロット作成のプロンプト（設計書6.4.7）。
 */

describe("システムの指示", () => {
  it("字数と候補の数は、検算の定数から埋め込む（2か所に書かない）", () => {
    const L = PLOT_DIALOGUE_LIMITS;
    expect(PLOT_DIALOGUE_SYSTEM_PROMPT).toContain(`${L.candidatesMin}〜${L.candidatesMax}個`);
    expect(PLOT_DIALOGUE_SYSTEM_PROMPT).toContain(`${L.question}字以内`);
  });

  it("書く先の鍵を全部並べる", () => {
    for (const section of PLOT_DIALOGUE_SECTIONS) {
      expect(PLOT_DIALOGUE_SYSTEM_PROMPT).toContain(`- ${section.key}：`);
    }
  });

  it("決めるのは作者・問いは1つ・繰り返さない・汎用の文句を候補にしない", () => {
    expect(PLOT_DIALOGUE_SYSTEM_PROMPT).toContain("決めるのは作者です");
    expect(PLOT_DIALOGUE_SYSTEM_PROMPT).toContain("問いは1回に1つだけ");
    expect(PLOT_DIALOGUE_SYSTEM_PROMPT).toContain("二度と尋ねないこと");
    expect(PLOT_DIALOGUE_SYSTEM_PROMPT).toContain("一般的な文句");
  });

  it("目標の文字数と大きな流れも、問答の中で決める", () => {
    expect(PLOT_DIALOGUE_SYSTEM_PROMPT).toContain("目標の文字数");
    expect(PLOT_DIALOGUE_SYSTEM_PROMPT).toContain("どんでん返し");
  });
});

describe("指示の言葉がそのまま返ってきたら受け取らない（CLAUDE.md 失敗3）", () => {
  it("指示の鍵の言い回しを、そのまま問いに入れた答えは捨てる", () => {
    const echoed = JSON.stringify({
      confirm: "",
      topic: "最強の理由",
      question: "いま決めると話が一番広がる1点",
      why: "",
      candidates: ["回線が魔力も運ぶ", "地図を握っている", "配信が命綱"],
      section: "worldview",
    });
    expect(validatePlotDialogueAnswer(echoed, []).ok).toBe(false);
  });
});

describe("作者側の材料", () => {
  const base = {
    workTitle: "回線の街",
    idea: "配信のための通信線を敷く業者が最強",
    writtenPlot: "",
    decisions: [],
    asked: [],
  };

  it("最初の回は、着想を書いたところだと伝える", () => {
    const prompt = buildPlotDialoguePrompt(base);
    expect(prompt).toContain("配信のための通信線を敷く業者が最強");
    expect(prompt).toContain("（作者は着想を書いたところです）");
    expect(prompt).toContain("# ここまでに決まったこと（作者の答え）\n（まだありません）");
  });

  it("決まったこと・尋ねたこと（飛ばしたものも）・直前の答えを渡す", () => {
    const prompt = buildPlotDialoguePrompt({
      ...base,
      decisions: [{ topic: "最強の理由", answer: "回線が魔力も運ぶ", section: "worldview" }],
      asked: [
        { topic: "最強の理由", question: "なぜ最強？", skipped: false },
        { topic: "舞台", question: "どこで動く？", skipped: true },
      ],
      lastAnswer: { topic: "最強の理由", answer: "回線が魔力も運ぶ" },
    });
    expect(prompt).toContain("- 【最強の理由】回線が魔力も運ぶ");
    expect(prompt).toContain("- 最強の理由：なぜ最強？");
    expect(prompt).toContain("- 舞台：どこで動く？（作者は飛ばした）");
    expect(prompt).toContain("# 作者の直前の答え\n【最強の理由】回線が魔力も運ぶ");
  });

  it("プロットから始めたときは、着想の欄でそう伝える", () => {
    const prompt = buildPlotDialoguePrompt({ ...base, idea: "", writtenPlot: "【ログライン】回線業者が最強" });
    expect(prompt).toContain("下のプロットに書いてあることから始めたい");
    expect(prompt).toContain("【ログライン】回線業者が最強");
  });

  it("頼み直しの一言を末尾に添える", () => {
    const prompt = buildPlotDialoguePrompt({ ...base, retryNote: "同じ問いでした。" });
    expect(prompt.endsWith("同じ問いでした。")).toBe(true);
  });
});

describe("答えの形", () => {
  it("書く先は選択肢で縛り、候補には上限を置く", () => {
    expect(PLOT_DIALOGUE_SCHEMA.properties.section.enum).toEqual(
      PLOT_DIALOGUE_SECTIONS.map((section) => section.key)
    );
    expect(PLOT_DIALOGUE_SCHEMA.properties.candidates.maxItems).toBe(
      PLOT_DIALOGUE_LIMITS.candidatesMax
    );
    expect([...PLOT_DIALOGUE_SCHEMA.required].sort()).toEqual(
      ["candidates", "confirm", "question", "section", "topic", "why"]
    );
  });
});
