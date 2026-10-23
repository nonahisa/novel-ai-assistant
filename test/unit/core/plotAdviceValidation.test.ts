import { describe, expect, it } from "vitest";
import { emptyPlotSections, type PlotSections } from "../../../src/core/plotDoc";
import {
  PLOT_ADVICE_SUGGESTION_MARK,
  countQuestions,
  isPlotAdviceWriteRequest,
  parsePlotAdviceDraft,
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

describe("作者が自分で話題にした項目は、勧めた数に入れない（2026-10-23 の実測の再現）", () => {
  it("作者が世界観を話していれば、答えが世界観に触れても勧めとして数えない", () => {
    const answer = parsePlotAdviceAnswer(
      "世界観はダンジョンが日常にある現代ですね。主人公の行動原理とも結びつけられそうです。",
      {
        sections: sections({ logline: "新人が配線を守る", theme: "裏方の誇り" }),
        authorTexts: ["世界観をどう作ればいいか迷っています。"],
      }
    );
    expect(answer.warnings.filter((w) => w.includes("未記入の項目"))).toEqual([]);
  });

  it("履歴の作者の発言で名指しした項目（短い言い方を含む）も数えない", () => {
    const answer = parsePlotAdviceAnswer(
      "あらすじと主人公の行動原理、それに舞台も見えてきました。",
      {
        sections: sections(),
        authorTexts: ["続きです", "行動原理は決まりました", "あらすじも考えたい"],
      }
    );
    const warning = answer.warnings.find((w) => w.includes("未記入の項目"));
    expect(warning).toBeUndefined();
  });

  it("作者が話していない項目を2つ挙げたら、従来どおり警告する", () => {
    const answer = parsePlotAdviceAnswer("次は舞台か、主人公の行動原理を考えるとよいでしょう。", {
      sections: sections(),
      authorTexts: ["世界観をどう作ればいいか迷っています。"],
    });
    expect(answer.warnings.some((w) => w.includes("舞台・主人公の行動原理"))).toBe(true);
  });
});

/*
  「書いて」と頼まれたときの2回目（P-01b、設計書6.4.10 の12）。
  2回目を呼ぶかどうかの判定と、2回目の value の見張り。
*/
describe("書く依頼の言い方（isPlotAdviceWriteRequest）", () => {
  it("2026-10-23 の台本の言い方は、どれも書く依頼として拾う", () => {
    for (const text of [
      "主人公の行動原理も決まった。ミナは兄に「必ず迎えに来る」と約束されたまま三年待たされたので、自分から迎えに行く。これをプロットに入れて。",
      "舞台は瀬戸内の小さな漁村にする。決まりだから舞台の欄に書いてほしい。",
      "あらすじの案を書き込んでほしい。第一幕は旅立ち、第二幕は島での兄の痕跡探し、第三幕は満潮が迫る中の脱出。",
      "テーマはこれで反映して",
      "ログラインに記入してください",
      "舞台に書いといて",
      "世界観に書いてもらえる？",
    ]) {
      expect(isPlotAdviceWriteRequest(text), text).toBe(true);
    }
  });

  it("書いてある・書いていない・あらすじの中の動き（手に入れて逃げる）は書く依頼にしない", () => {
    for (const text of [
      "テーマは書いてあるけど、舞台はどうしよう",
      "あらすじはまだ書いていない",
      "舞台は書いてない",
      "主人公は鍵を手に入れて逃げる",
      "手紙を書いて、兄に渡す場面がある",
      "動機はもう入れている",
      "舞台をどうするか迷っている",
      "まだ書かないで",
    ]) {
      expect(isPlotAdviceWriteRequest(text), text).toBe(false);
    }
  });

  /*
    2026-10-23 の測定で取りこぼした形。「舞台に入れて、あとは…」は読点が続くので
    頼む形と見なされず、e4b・26b とも6回中0回で案が出なかった。
    項目の名前＋「に／の欄に／へ」の直後なら、読点が続いても書く依頼とみなす。
  */
  it("項目の名前＋「に」「の欄に」「へ」の直後の「入れて、」「書いて、」は書く依頼として拾う", () => {
    for (const text of [
      "舞台は瀬戸内の小さな漁村に決めた。舞台に入れて、あとは時代もそのうち考えたい。",
      "世界観の欄に書いて、それから人物の話をしたい",
      "あらすじへ書き込んで、次は結末を考える",
      "行動原理に入れて、ほかは後で",
      "主人公の行動原理に書いて、残りは任せる",
    ]) {
      expect(isPlotAdviceWriteRequest(text), text).toBe(true);
    }
  });

  it("項目の名前が前に無い「〜て、」は、読点が続けば書く依頼にしない（作中の動作と紛れる）", () => {
    for (const text of [
      "手紙を書いて、兄に渡す場面がある",
      "主人公は鍵を手に入れて、島から逃げる",
      "テーマを書いて、兄に渡す",
      "日記に書いて、引き出しにしまう",
      "舞台に書いてある、漁村の話",
      "テーマに入れていない、あの話",
    ]) {
      expect(isPlotAdviceWriteRequest(text), text).toBe(false);
    }
  });
});

describe("2回目の value の見張り（parsePlotAdviceDraft）", () => {
  const author = ["舞台は瀬戸内の小さな漁村にする。決まりだから舞台の欄に書いてほしい。"];

  it("value を、コードが持つ項目の案にする（field はAIに書かせない）", () => {
    const result = parsePlotAdviceDraft(
      '{"value": "瀬戸内の小さな漁村"}',
      "setting",
      { sections: sections(), authorTexts: author }
    );
    expect(result).toEqual({
      suggestion: {
        section: "setting",
        heading: "舞台",
        value: "瀬戸内の小さな漁村",
        overwrites: false,
        grounded: true,
      },
    });
  });

  it("AIが field を足して別の項目を書いてきても、項目はコードが持つものにする", () => {
    const result = parsePlotAdviceDraft(
      '{"field": "テーマ", "value": "瀬戸内の小さな漁村"}',
      "setting",
      { sections: sections(), authorTexts: author }
    );
    expect("suggestion" in result && result.suggestion.section).toBe("setting");
  });

  it("壊れた JSON・空・雛形の言葉・長すぎる案は捨てる（1回目と同じ見張り）", () => {
    const context = { sections: sections(), authorTexts: author };
    expect(parsePlotAdviceDraft('{"value": ', "setting", context)).toEqual({ dropped: "broken_json" });
    expect(parsePlotAdviceDraft("", "setting", context)).toEqual({ dropped: "broken_json" });
    expect(parsePlotAdviceDraft('{"value": ""}', "setting", context)).toEqual({ dropped: "placeholder_value" });
    // P-01b の指示語がそのまま返ってきた形（CLAUDE.md の繰り返し起きた失敗3）
    expect(parsePlotAdviceDraft('{"value": "項目に入れる文"}', "setting", context)).toEqual({
      dropped: "placeholder_value",
    });
    expect(parsePlotAdviceDraft('{"value": "【作者の発言】舞台は漁村"}', "setting", context)).toEqual({
      dropped: "placeholder_value",
    });
    expect(
      parsePlotAdviceDraft(JSON.stringify({ value: "漁村".repeat(400) }), "setting", context)
    ).toEqual({ dropped: "too_long" });
  });

  it("作者への問い返しで終わる value は案にしない（e4b は問いを返す癖が測れている）", () => {
    const result = parsePlotAdviceDraft(
      '{"value": "漁村の名前や時代はどうしますか？"}',
      "setting",
      { sections: sections(), authorTexts: author }
    );
    expect(result).toEqual({ dropped: "asks_back" });
  });

  it("作者自身が問いの形で決めた中身（テーマの問い）は落とさない", () => {
    const result = parsePlotAdviceDraft(
      '{"value": "人は何のために待つのか？"}',
      "theme",
      { sections: sections(), authorTexts: ["テーマは「人は何のために待つのか？」にする。テーマに書いて。"] }
    );
    expect("suggestion" in result).toBe(true);
  });

  it("作者の発言に無い言葉が多い案は、落とさずに印を付ける", () => {
    const result = parsePlotAdviceDraft(
      '{"value": "霧に包まれた北の港町。灯台守の一族が暮らす"}',
      "setting",
      { sections: sections(), authorTexts: author }
    );
    expect("suggestion" in result && result.suggestion.grounded).toBe(false);
  });
});
