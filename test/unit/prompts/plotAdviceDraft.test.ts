import { describe, expect, it } from "vitest";
import { emptyPlotSections, type PlotSections } from "../../../src/core/plotDoc";
import {
  PLOT_ADVICE_DRAFT_SCHEMA,
  PLOT_ADVICE_DRAFT_SYSTEM_PROMPT,
  PLOT_ADVICE_DRAFT_TEMPERATURE,
  buildPlotAdviceDraftPrompt,
  plotAdviceDraftTarget,
} from "../../../src/prompts/plotAdviceDraft";
import { PLOT_ADVICE_TEMPERATURE } from "../../../src/prompts/plotAdvice";

/**
 * 「書いて」と頼まれたときの2回目（P-01b、設計書6.4.10 の12）。
 *
 * 動いたと言える条件：
 * 1. 1回目に案が無く、今回の発言が項目をちょうど1つ名指しし、書く依頼の言い方を
 *    含み、その項目がまだ空のときだけ、2回目の項目を返す
 * 2. 案を求めない相談・名指しが2つ・1回目に案がある・作者の書いた項目・
 *    1回目の案を作者を守る見張りで落とした回は返さない
 * 3. 依頼文は名指しした項目の見出しと作者の発言を渡し、指示の雛形の言葉を書かない
 */

function sections(overrides: Partial<PlotSections> = {}): PlotSections {
  return { ...emptyPlotSections(), ...overrides };
}

/** 2026-10-23 の台本（決めて「書いて」と頼む問い） */
const ASKS = [
  {
    text: "主人公の行動原理も決まった。ミナは兄に「必ず迎えに来る」と約束されたまま三年待たされたので、自分から迎えに行く。これをプロットに入れて。",
    field: "protagonistMotive",
  },
  { text: "舞台は瀬戸内の小さな漁村にする。決まりだから舞台の欄に書いてほしい。", field: "setting" },
  {
    text: "あらすじの案を書き込んでほしい。第一幕は旅立ち、第二幕は島での兄の痕跡探し、第三幕は満潮が迫る中の脱出。",
    field: "outline",
  },
] as const;

describe("2回目を呼ぶかどうか（plotAdviceDraftTarget）", () => {
  it.each(ASKS)("台本の「$field」の問いは、1回目に案が無ければ2回目の項目を返す", ({ text, field }) => {
    expect(
      plotAdviceDraftTarget({ userMessage: text, sections: sections(), firstAnswer: {} })
    ).toBe(field);
  });

  it("案を求めない相談では呼ばない（項目を名指ししていても）", () => {
    expect(
      plotAdviceDraftTarget({
        userMessage: "舞台を瀬戸内の漁村にするか、山あいの町にするか迷っている",
        sections: sections(),
        firstAnswer: {},
      })
    ).toBeUndefined();
  });

  it("名指しが2つあれば呼ばない（どちらへ書くかをコードが決められない）", () => {
    expect(
      plotAdviceDraftTarget({
        userMessage: "舞台は漁村、テーマは待つことの意味。プロットに入れて。",
        sections: sections(),
        firstAnswer: {},
      })
    ).toBeUndefined();
  });

  it("名指しが無ければ呼ばない", () => {
    expect(
      plotAdviceDraftTarget({ userMessage: "これをプロットに入れて。", sections: sections(), firstAnswer: {} })
    ).toBeUndefined();
  });

  it("1回目に案があれば呼ばない", () => {
    expect(
      plotAdviceDraftTarget({
        userMessage: ASKS[1].text,
        sections: sections(),
        firstAnswer: {
          suggestion: {
            section: "setting",
            heading: "舞台",
            value: "瀬戸内の小さな漁村",
            overwrites: false,
            grounded: true,
          },
        },
      })
    ).toBeUndefined();
  });

  it("1回目の案が壊れていた・雛形だった回は呼ぶ（案が無いのと同じ）", () => {
    for (const dropped of ["broken_json", "placeholder_value", "unknown_field", "too_long"] as const) {
      expect(
        plotAdviceDraftTarget({ userMessage: ASKS[1].text, sections: sections(), firstAnswer: { dropped } }),
        dropped
      ).toBe("setting");
    }
  });

  it("1回目の案を作者を守る見張り（同じ・言い換え）で落とした回は呼ばない", () => {
    for (const dropped of ["already_written", "rewrites_author"] as const) {
      expect(
        plotAdviceDraftTarget({ userMessage: ASKS[1].text, sections: sections(), firstAnswer: { dropped } }),
        dropped
      ).toBeUndefined();
    }
  });

  it("作者がもう書いた項目へは呼ばない（2回目で作者の文を置き換える案を作らない）", () => {
    expect(
      plotAdviceDraftTarget({
        userMessage: ASKS[1].text,
        sections: sections({ setting: "山あいの町" }),
        firstAnswer: {},
      })
    ).toBeUndefined();
  });
});

describe("2回目の依頼文", () => {
  it("名指しした項目の見出しと作者の発言を渡す", () => {
    const prompt = buildPlotAdviceDraftPrompt({
      workTitle: "満潮の島",
      section: "setting",
      userMessage: ASKS[1].text,
      history: [
        { role: "author", text: "兄を探しに行く話にしたい" },
        { role: "assistant", text: "兄はどこにいるのでしょう？" },
      ],
    });
    expect(prompt).toContain("# 作品\n満潮の島");
    expect(prompt).toContain("【書く項目】\n舞台");
    expect(prompt).toContain("作者：兄を探しに行く話にしたい\n編集者：兄はどこにいるのでしょう？");
    expect(prompt).toContain(`【作者の発言】\n${ASKS[1].text}`);
  });

  it("渡す会話は直近3往復まで", () => {
    const history = Array.from({ length: 10 }, (_, i) => [
      { role: "author" as const, text: `発言${i + 1}` },
      { role: "assistant" as const, text: `答え${i + 1}` },
    ]).flat();
    const prompt = buildPlotAdviceDraftPrompt({
      workTitle: "t",
      section: "theme",
      userMessage: "テーマに書いて",
      history,
    });
    expect(prompt).not.toContain("発言7\n");
    expect(prompt).toContain("作者：発言8");
    expect(prompt).toContain("編集者：答え10");
  });

  it("最初の発言なら会話の段にそう書く", () => {
    const prompt = buildPlotAdviceDraftPrompt({
      workTitle: "t",
      section: "theme",
      userMessage: "テーマに書いて",
      history: [],
    });
    expect(prompt).toContain("【直前の会話】\n（ありません）");
  });

  it("指示に雛形の言葉を書かない。形は value の1つだけ", () => {
    expect(PLOT_ADVICE_DRAFT_SYSTEM_PROMPT).not.toContain("対象項目名");
    expect(PLOT_ADVICE_DRAFT_SYSTEM_PROMPT).not.toContain("書き込む内容");
    expect(PLOT_ADVICE_DRAFT_SCHEMA).toEqual({
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
    });
  });

  it("温度は会話（P-01）より低い（決まった中身を写す仕事）", () => {
    expect(PLOT_ADVICE_DRAFT_TEMPERATURE).toBeLessThan(PLOT_ADVICE_TEMPERATURE);
  });
});
