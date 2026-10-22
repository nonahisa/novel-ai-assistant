import { describe, expect, it } from "vitest";
import { emptyPlotSections, type PlotSections } from "../../../src/core/plotDoc";
import {
  PLOT_ADVICE_SUGGESTION_MARK,
  plotAdviceFieldsNamed,
} from "../../../src/core/plotAdviceValidation";
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
      userMessage: "続きを相談したいです",
      history: [],
    });
    expect(prompt).toContain("【ログライン】試験に落ちた新人が地下の配線を守る");
    expect(prompt).toContain("【まだ書かれていない項目】\nテーマ、モチーフ、世界観");
    expect(prompt).toContain("【話が途切れたときに勧める項目（まだ勧めていません）】\nテーマ");
    expect(prompt).toContain("【作者の発言】\n続きを相談したいです");
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

  it("作者が決めて「書いて／入れて」と頼んだら、書き込み案を先にすると言う（1.1）", () => {
    expect(PLOT_ADVICE_SYSTEM_PROMPT).toContain("「書いて」「入れて」と頼んだ");
    expect(PLOT_ADVICE_SYSTEM_PROMPT).toContain("書き込み案を出すことを先にする");
    // 1.0 の見出しの名で指さない（依頼文にもう無い段を探させない）
    expect(PLOT_ADVICE_SYSTEM_PROMPT).not.toContain("次に考えるとよい項目");
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

/** 勧める項目の段（見出しから【これまでの会話】の前まで）だけを切り出す */
function recommendBlock(prompt: string): string {
  // 1.0 の見出し（【次に考えるとよい項目】）でも切り出す。新しい見出しだけを
  // 探すと、直す前の依頼文では段が見つからず、再現テストが空で通ってしまう
  const found = ["【話が途切れたときに勧める項目", "【次に考えるとよい項目】"]
    .map((label) => prompt.indexOf(label))
    .filter((at) => at >= 0);
  const start = found.length > 0 ? Math.min(...found) : -1;
  if (start < 0) return "";
  const end = prompt.indexOf("【これまでの会話】", start);
  return prompt.slice(start, end < 0 ? undefined : end);
}

/** 実物で測った作り物のプロット（ログライン・テーマ・主要登場人物だけ記入） */
const measured = sections({
  logline: "試験に落ちた新人が、最強の班長の下で地下の配線を守る",
  theme: "名前の残らない仕事の誇り",
  mainCharacters: "- 新人\n- 班長",
});

describe("作者が話している項目を、勧める項目に入れない（2026-10-23 の実測の再現）", () => {
  it("世界観の相談なのに、主人公の行動原理を勧める段に入れない", () => {
    const prompt = buildPlotAdvicePrompt({
      workTitle: "現代ダンジョンのインフラ担当",
      sections: measured,
      userMessage: "世界観をどう作ればいいか迷っています。",
      history: [],
    });
    expect(recommendBlock(prompt)).not.toContain("主人公の行動原理");
  });

  it("行動原理を決めて「入れて」と頼んだ回に、行動原理を「次に」と渡さない", () => {
    const prompt = buildPlotAdvicePrompt({
      workTitle: "現代ダンジョンのインフラ担当",
      sections: measured,
      userMessage:
        "主人公の行動原理も決まった。誰にも気づかれない仕事でも手を抜きたくない。これをプロットに入れて。",
      history: [],
    });
    expect(recommendBlock(prompt)).not.toContain("主人公の行動原理");
  });

  it("「動機」のような短い言い方でも、名指しとみなす", () => {
    expect(plotAdviceFieldsNamed(["主人公の動機を考えたい"])).toContain("protagonistMotive");
    expect(plotAdviceFieldsNamed(["第2幕が弱い気がする"])).toContain("outline");
    expect(plotAdviceFieldsNamed(["一人称で書くか迷う"])).toContain("narrativePerson");
  });

  it("項目の話でなければ、まだ勧めていないことが分かる見出しで1項目を渡す", () => {
    const prompt = buildPlotAdvicePrompt({
      workTitle: "作品",
      sections: measured,
      userMessage: "どう広げればいいですか",
      history: [],
    });
    expect(prompt).toContain(
      "【話が途切れたときに勧める項目（まだ勧めていません）】\n主人公の行動原理"
    );
    expect(prompt).not.toContain("【次に考えるとよい項目】");
  });

  it("編集者がもう勧めた項目は、また「まだ勧めていない」と渡さない", () => {
    const prompt = buildPlotAdvicePrompt({
      workTitle: "作品",
      sections: measured,
      userMessage: "どう広げればいいですか",
      history: [
        { role: "author", text: "相談です" },
        { role: "assistant", text: "主人公の行動原理を考えてみませんか。" },
      ],
    });
    expect(recommendBlock(prompt)).toBe("");
  });
});
