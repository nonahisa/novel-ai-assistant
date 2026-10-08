import { describe, expect, it } from "vitest";
import { emptyPlotSections, type PlotSections } from "../../../src/core/plotDoc";
import {
  PLOT_ADVICE_SUGGESTION_MARK,
  countQuestions,
  parsePlotAdviceAnswer,
  sectionOf,
} from "../../../src/core/plotAdviceValidation";

/**
 * プロットモードのAI助言（P-01、設計書6.4.10）の答えの検算。
 *
 * 動いたと言える条件：
 * 1. 区切りの後ろの JSON だけを書き込み案にする。壊れていれば案を捨て、
 *    会話の文は残す
 * 2. 項目は見出しでも鍵でも受け、書いてよい項目（タイトル・形式・ジャンル以外）に限る
 * 3. 雛形の言葉・伏せ字の案を通さない（CLAUDE.md の繰り返し起きた失敗3）
 * 4. 作者が書いた項目の言い換えは落とし、別の中身で置き換える案には印を付ける
 * 5. 問いが3つ以上・未記入の項目を2つ以上挙げた答えは、文を残してログ用の警告にする
 */

function sections(overrides: Partial<PlotSections> = {}): PlotSections {
  return { ...emptyPlotSections(), ...overrides };
}

const M = PLOT_ADVICE_SUGGESTION_MARK;

describe("書き込み案の読み取り", () => {
  it("区切りが無ければ案は無く、文はそのまま", () => {
    const answer = parsePlotAdviceAnswer("主人公は何を失うのでしょうか。", {
      sections: sections(),
      authorTexts: [],
    });
    expect(answer.reply).toBe("主人公は何を失うのでしょうか。");
    expect(answer.suggestion).toBeUndefined();
    expect(answer.dropped).toBeUndefined();
  });

  it("区切りの後ろの JSON を案にし、文には区切りから後ろを含めない", () => {
    const answer = parsePlotAdviceAnswer(
      `ログラインがはっきりしましたね。\n${M}\n{"field": "ログライン", "value": "試験に落ちた新人が、最強の班長の下で地下の配線を守る"}`,
      {
        sections: sections(),
        authorTexts: ["試験に落ちた新人が、最強の班長の下で地下の配線を守る話にしたい"],
      }
    );
    expect(answer.reply).toBe("ログラインがはっきりしましたね。");
    expect(answer.suggestion).toEqual({
      section: "logline",
      heading: "ログライン",
      value: "試験に落ちた新人が、最強の班長の下で地下の配線を守る",
      overwrites: false,
      grounded: true,
    });
  });

  it("コードフェンスで包まれた JSON も読む", () => {
    const answer = parsePlotAdviceAnswer(
      `決まりました。\n${M}\n\`\`\`json\n{"field": "theme", "value": "裏方の誇り"}\n\`\`\``,
      { sections: sections(), authorTexts: ["テーマは裏方の誇りです"] }
    );
    expect(answer.suggestion?.section).toBe("theme");
    expect(answer.suggestion?.value).toBe("裏方の誇り");
  });

  it("壊れた JSON は案を捨て、会話の文は残す", () => {
    const answer = parsePlotAdviceAnswer(
      `テーマはこれでよさそうです。\n${M}\n{"field": "テーマ", "value": "裏方の`,
      { sections: sections(), authorTexts: [] }
    );
    expect(answer.reply).toBe("テーマはこれでよさそうです。");
    expect(answer.suggestion).toBeUndefined();
    expect(answer.dropped).toBe("broken_json");
    expect(answer.rawSuggestion).toContain("裏方の");
  });

  it("区切りが2回あれば、最初の案だけを見て警告を残す", () => {
    const answer = parsePlotAdviceAnswer(
      `はい。\n${M}\n{"field": "テーマ", "value": "裏方の誇り"}\n${M}\n{"field": "モチーフ", "value": "配線"}`,
      { sections: sections(), authorTexts: ["裏方の誇り"] }
    );
    expect(answer.suggestion?.section).toBe("theme");
    expect(answer.warnings.some((w) => w.includes("区切り"))).toBe(true);
  });

  it("書いてよい項目に当たらない field は捨てる（タイトル・形式・ジャンル・知らない名前）", () => {
    for (const field of ["タイトル", "形式", "ジャンル", "見せ場", "対象項目名"]) {
      const answer = parsePlotAdviceAnswer(
        `はい。\n${M}\n{"field": "${field}", "value": "地下の配線"}`,
        { sections: sections(), authorTexts: [] }
      );
      expect(answer.suggestion, field).toBeUndefined();
      expect(answer.dropped, field).toBe("unknown_field");
    }
  });

  it("雛形の言葉・伏せ字・空の value は捨てる（指示の言葉が返ってくる）", () => {
    for (const value of [
      "書き込む内容",
      "項目の見出し",
      "（ここにログラインが入ります）",
      "〇〇が××する話",
      "",
    ]) {
      const answer = parsePlotAdviceAnswer(
        `はい。\n${M}\n${JSON.stringify({ field: "ログライン", value })}`,
        { sections: sections(), authorTexts: [] }
      );
      expect(answer.suggestion, value).toBeUndefined();
      expect(answer.dropped, value).toBe("placeholder_value");
    }
  });

  it("長すぎる案は下書きとみなして捨てる", () => {
    const answer = parsePlotAdviceAnswer(
      `はい。\n${M}\n${JSON.stringify({ field: "あらすじ", value: "あ".repeat(601) })}`,
      { sections: sections(), authorTexts: [] }
    );
    expect(answer.dropped).toBe("too_long");
  });
});

describe("作者の書いた項目を守る", () => {
  const written = sections({ theme: "裏方の仕事が、表の英雄を支えている" });

  it("書いてある中身と同じ案は捨てる", () => {
    const answer = parsePlotAdviceAnswer(
      `はい。\n${M}\n{"field": "テーマ", "value": "裏方の仕事が、表の英雄を支えている"}`,
      { sections: written, authorTexts: [] }
    );
    expect(answer.dropped).toBe("already_written");
  });

  it("作者の文を言い回しだけ変えた案は捨てる", () => {
    const answer = parsePlotAdviceAnswer(
      `はい。\n${M}\n{"field": "テーマ", "value": "裏方の仕事こそが、表の英雄を支えている"}`,
      { sections: written, authorTexts: [] }
    );
    expect(answer.dropped).toBe("rewrites_author");
  });

  it("別の中身で置き換える案は残し、置き換えの印を付ける", () => {
    const answer = parsePlotAdviceAnswer(
      `はい。\n${M}\n{"field": "テーマ", "value": "名前の残らない仕事の誇り"}`,
      { sections: written, authorTexts: ["名前の残らない仕事の誇りを書きたい"] }
    );
    expect(answer.suggestion?.overwrites).toBe(true);
    expect(answer.suggestion?.grounded).toBe(true);
  });

  it("作者の発言に無い言葉が多い案は、落とさずに印を付ける", () => {
    const answer = parsePlotAdviceAnswer(
      `はい。\n${M}\n{"field": "モチーフ", "value": "砕けた王冠と黒い薔薇"}`,
      { sections: sections(), authorTexts: ["地下の配線の話です"] }
    );
    expect(answer.suggestion?.section).toBe("motif");
    expect(answer.suggestion?.grounded).toBe(false);
  });
});

describe("振る舞いの決まりの見張り（文は捨てずに警告だけ）", () => {
  it("問いが3つ以上なら警告し、文は残す", () => {
    const text = "主人公は誰ですか？ 舞台はどこですか？ 結末は決まっていますか？";
    const answer = parsePlotAdviceAnswer(text, { sections: sections(), authorTexts: [] });
    expect(answer.reply).toBe(text);
    expect(answer.warnings.some((w) => w.includes("問いが 3 個"))).toBe(true);
  });

  it("問いが2つまでなら警告しない", () => {
    const answer = parsePlotAdviceAnswer("主人公は誰ですか？ 舞台はどこですか？", {
      sections: sections(),
      authorTexts: [],
    });
    expect(answer.warnings).toEqual([]);
  });

  it("引用の中の「？」は問いに数えない", () => {
    expect(countQuestions("作者は「なぜ？」と書いていますね。理由は何でしょう？")).toBe(1);
  });

  it("未記入の項目を2つ以上挙げたら警告する（書いてある項目は数えない）", () => {
    const answer = parsePlotAdviceAnswer(
      "次はテーマか、主人公の行動原理を考えるとよいでしょう。ログラインはできています。",
      { sections: sections({ logline: "新人が配線を守る" }), authorTexts: [] }
    );
    expect(answer.warnings.some((w) => w.includes("テーマ・主人公の行動原理"))).toBe(true);
  });

  it("指示の見出しが写った行は外して、警告に残す", () => {
    const answer = parsePlotAdviceAnswer("【作者の発言】\n主人公は何を失いますか？", {
      sections: sections(),
      authorTexts: [],
    });
    expect(answer.reply).toBe("主人公は何を失いますか？");
    expect(answer.warnings.some((w) => w.includes("指示の見出し"))).toBe(true);
  });
});

describe("項目の当て方", () => {
  it("見出し・鍵・括弧つきの見出しを受ける", () => {
    expect(sectionOf("ログライン")).toBe("logline");
    expect(sectionOf("logline")).toBe("logline");
    expect(sectionOf("【主要登場人物】")).toBe("mainCharacters");
    expect(sectionOf("## あらすじ")).toBe("outline");
  });

  it("タイトル・形式・ジャンルは書かない", () => {
    expect(sectionOf("タイトル")).toBeUndefined();
    expect(sectionOf("format")).toBeUndefined();
    expect(sectionOf("ジャンル")).toBeUndefined();
  });
});
