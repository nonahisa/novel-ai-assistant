import { describe, expect, it } from "vitest";
import { emptyPlotSections, type PlotSections } from "../../../src/core/plotDoc";
import { PLOT_ADVICE_SUGGESTION_MARK } from "../../../src/core/plotAdviceValidation";
import {
  PLOT_ADVICE_HISTORY_TURNS,
  PLOT_ADVICE_SYSTEM_PROMPT,
  PLOT_ADVICE_TEMPERATURE,
  buildPlotAdvicePrompt,
  emptyPlotAdviceFields,
  nextPlotAdviceField,
  recentPlotAdviceHistory,
  type PlotAdviceTurn,
} from "../../../src/prompts/plotAdvice";

/**
 * P-01 プロットモードのAI助言のプロンプト（設計書6.4.10）。
 *
 * 動いたと言える条件：
 * 1. 未記入の項目と、次に勧める1項目（コードが推奨順で決めたもの）が入る
 * 2. 履歴は直近10往復で切れ、答えだけが先頭に残らない
 * 3. 雛形の言葉（「対象項目名」「書き込む内容」）と作品固有の例文を書かない
 *    ——指示の言葉は答えとして返ってくる（CLAUDE.md の繰り返し起きた失敗3）
 */

function sections(overrides: Partial<PlotSections> = {}): PlotSections {
  return { ...emptyPlotSections(), ...overrides };
}

function history(turns: number): PlotAdviceTurn[] {
  const out: PlotAdviceTurn[] = [];
  for (let i = 1; i <= turns; i++) {
    out.push({ role: "author", text: `作者の${i}回目` });
    out.push({ role: "assistant", text: `編集者の${i}回目` });
  }
  return out;
}

describe("未記入の項目と次に勧める1項目", () => {
  it("推奨順で最初の未記入を勧める（ログライン→テーマ→主人公の行動原理…）", () => {
    expect(nextPlotAdviceField(sections())).toBe("logline");
    expect(nextPlotAdviceField(sections({ logline: "新人が配線を守る" }))).toBe("theme");
    expect(
      nextPlotAdviceField(sections({ logline: "a", theme: "b" }))
    ).toBe("protagonistMotive");
  });

  it("雛形の案内だけの項目は未記入とみなす", () => {
    expect(
      nextPlotAdviceField(sections({ logline: "<!-- 誰が / どんな状況で -->" }))
    ).toBe("logline");
  });

  it("タイトル・形式・ジャンルは未記入の一覧にも勧める先にも入れない", () => {
    const empty = emptyPlotAdviceFields(sections());
    expect(empty).not.toContain("title");
    expect(empty).not.toContain("format");
    expect(empty).not.toContain("genre");
    const allWritten = sections({
      logline: "a",
      theme: "b",
      motif: "c",
      worldview: "d",
      setting: "e",
      narrativePerson: "f",
      protagonistMotive: "g",
      outline: "- h",
      mainCharacters: "- i",
    });
    expect(nextPlotAdviceField(allWritten)).toBeUndefined();
  });

  it("依頼文に、いまのプロット・未記入の項目・次に勧める1項目・作者の発言が入る", () => {
    const prompt = buildPlotAdvicePrompt({
      workTitle: "現代ダンジョンのインフラ担当",
      sections: sections({ logline: "試験に落ちた新人が地下の配線を守る" }),
      userMessage: "テーマを決めたいです",
      history: [],
    });
    expect(prompt).toContain("【ログライン】試験に落ちた新人が地下の配線を守る");
    expect(prompt).toContain("【まだ書かれていない項目】\nテーマ、モチーフ、世界観");
    expect(prompt).toContain("【次に考えるとよい項目】\nテーマ");
    expect(prompt).toContain("【作者の発言】\nテーマを決めたいです");
    expect(prompt).toContain("（これが最初の発言です）");
  });

  it("全部書いてあれば、噛み合いを見るように言う", () => {
    const prompt = buildPlotAdvicePrompt({
      workTitle: "作品",
      sections: sections({
        logline: "a",
        theme: "b",
        motif: "c",
        worldview: "d",
        setting: "e",
        narrativePerson: "f",
        protagonistMotive: "g",
        outline: "- h",
        mainCharacters: "- i",
      }),
      userMessage: "見直してください",
      history: [],
    });
    expect(prompt).toContain("【まだ書かれていない項目】\n（ありません）");
    expect(prompt).toContain("噛み合い");
  });

  it("作者が自分で立てた節も渡す", () => {
    const prompt = buildPlotAdvicePrompt({
      workTitle: "作品",
      sections: sections(),
      extra: "## 着想\n班長が実は最強",
      userMessage: "どう広げればいいですか",
      history: [],
    });
    expect(prompt).toContain("班長が実は最強");
  });
});

describe("履歴", () => {
  it(`直近${PLOT_ADVICE_HISTORY_TURNS}往復で切る`, () => {
    const recent = recentPlotAdviceHistory(history(12));
    expect(recent).toHaveLength(PLOT_ADVICE_HISTORY_TURNS * 2);
    expect(recent[0]).toEqual({ role: "author", text: "作者の3回目" });
    expect(recent[recent.length - 1]).toEqual({ role: "assistant", text: "編集者の12回目" });
  });

  it("切れ目で答えだけが先頭に残ったら落とす", () => {
    const odd: PlotAdviceTurn[] = [
      { role: "assistant", text: "前の答え" },
      ...history(2),
    ];
    expect(recentPlotAdviceHistory(odd, 2)[0].role).toBe("author");
  });

  it("依頼文には作者と編集者の名で並べ、11往復目より古いものは入れない", () => {
    const prompt = buildPlotAdvicePrompt({
      workTitle: "作品",
      sections: sections(),
      userMessage: "続きです",
      history: history(11),
    });
    expect(prompt).toContain("作者：作者の2回目");
    expect(prompt).toContain("編集者：編集者の11回目");
    expect(prompt).not.toContain("作者の1回目");
  });
});

describe("指示文", () => {
  it("区切りと、書いてよい項目の見出しを並べる（タイトルは並べない）", () => {
    expect(PLOT_ADVICE_SYSTEM_PROMPT).toContain(PLOT_ADVICE_SUGGESTION_MARK);
    expect(PLOT_ADVICE_SYSTEM_PROMPT).toContain("ログライン、テーマ、モチーフ");
    expect(PLOT_ADVICE_SYSTEM_PROMPT).not.toContain("タイトル");
  });

  it("問いは2つまで・勧めるのは1項目だけ・上書きしない、を言う", () => {
    expect(PLOT_ADVICE_SYSTEM_PROMPT).toContain("問いは2つまで");
    expect(PLOT_ADVICE_SYSTEM_PROMPT).toContain("1つだけ勧める");
    expect(PLOT_ADVICE_SYSTEM_PROMPT).toContain("上書きしない");
  });

  it("雛形の言葉と作品固有の例文を書かない", () => {
    for (const word of ["対象項目名", "書き込む内容", "復讐", "〇〇"]) {
      expect(PLOT_ADVICE_SYSTEM_PROMPT, word).not.toContain(word);
    }
  });

  it("温度は設計の節のとおり 0.7", () => {
    expect(PLOT_ADVICE_TEMPERATURE).toBe(0.7);
  });
});
