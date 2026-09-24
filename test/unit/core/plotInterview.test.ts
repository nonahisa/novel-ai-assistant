import { describe, it, expect } from "vitest";
import {
  composeSectionContents,
  describePlotDialogueEnd,
  describePlotDialogueStart,
  describePlotTurn,
  describeWrittenPlot,
  isOptionReply,
  isPlaceholderContent,
  isRequestLikeOption,
  planPlotWrite,
  PLOT_DIALOGUE_SECTIONS,
  PLOT_SKIP_OPTION,
  PLOT_START_FROM_PLOT_OPTION,
  PLOT_WRITE_OPTION,
  type PlotDecision,
} from "../../../src/core/plotInterview";
import { emptyPlotSections, parsePlotMarkdown, PLOT_SECTIONS } from "../../../src/core/plotDoc";
import { buildPlotTemplate } from "../../../src/core/plotTemplate";

/**
 * 対話式プロット作成（設計書6.4.7。0.86.2 で作り直した）の、画面にもAIにも
 * 依らない部品。**AIは候補を出す。決めるのは作者**——決まったことは作者の
 * 答えそのもので、書くのは押したときだけ、作者が書いた項目は上書きしない。
 */

describe("書いてよい項目", () => {
  it("タイトル・形式・ジャンルは問答から書かない", () => {
    // 形式は作品のタイプ（メニューの並び）を決める値。答えを流し込むと扱いごと変わる
    const keys = PLOT_DIALOGUE_SECTIONS.map((section) => section.key as string);
    expect(keys).not.toContain("title");
    expect(keys).not.toContain("format");
    expect(keys).not.toContain("genre");
  });

  it("すべて plot.md に実在する項目", () => {
    for (const section of PLOT_DIALOGUE_SECTIONS) {
      expect(PLOT_SECTIONS.some((item) => item.key === section.key), section.key).toBe(true);
    }
  });
});

describe("最初の一言", () => {
  it("何をするのか・答えるとどうなるのか・書くのはいつかを言う", () => {
    const text = describePlotDialogueStart("回線の街", false);
    expect(text).toContain("自由に書いてください");
    expect(text).toContain("1点");
    expect(text).toContain(PLOT_WRITE_OPTION);
    expect(text).not.toContain(PLOT_START_FROM_PLOT_OPTION);
  });

  it("プロットに書いてある作品では、そこから始められると言う", () => {
    expect(describePlotDialogueStart("回線の街", true)).toContain(PLOT_START_FROM_PLOT_OPTION);
  });
});

describe("問いの見せ方", () => {
  const turn = {
    confirm: "業者が最強、という話ですね。",
    topic: "最強の理由",
    question: "業者はなぜ最強なのですか？",
    why: "理由が決まると敵も決まります",
  };

  it("確かめ直し →【決める1点】問い →（なぜ）の順", () => {
    const text = describePlotTurn(turn, false);
    expect(text.indexOf(turn.confirm)).toBeLessThan(text.indexOf("【最強の理由】"));
    expect(text).toContain("（理由が決まると敵も決まります）");
  });

  it("答え方の案内は最初の問いにだけ添える", () => {
    expect(describePlotTurn(turn, true)).toContain("自分の言葉で書いたり");
    expect(describePlotTurn(turn, false)).not.toContain("自分の言葉で書いたり");
  });
});

describe("札の照合", () => {
  it("鉤括弧や空白が付いていても当てる", () => {
    expect(isOptionReply(`「${PLOT_SKIP_OPTION}」`, PLOT_SKIP_OPTION)).toBe(true);
    expect(isOptionReply(` ${PLOT_SKIP_OPTION} `, PLOT_SKIP_OPTION)).toBe(true);
  });

  it("似ているだけの答えは札にしない", () => {
    // 「飛ばす」を含むだけで拾うと、作者の答えが捨てられる
    expect(isOptionReply("この話は時間を飛ばす構成です", PLOT_SKIP_OPTION)).toBe(false);
  });
});

describe("候補の見分け", () => {
  it("依頼文は候補にしない（手元の gemma4:e4b が実際に返したもの）", () => {
    for (const text of [
      "主人公の具体的な立場や動機を教えてほしい",
      "「何が障害か」の部分を強調した切り口で案を出してほしい",
      "主人公が「インフラ業者」側に近いのか知りたい",
      "主人公が「配信者」の視点から話を進めたい",
      "主人公の動機付けについて、さらに深掘りしてほしい",
      "案1を元にログラインを生成してほしい",
      "主人公はどんな人ですか？",
      "候補を3つ見せて",
      // 候補の出し方を言っている文（テーマの候補として返り、書かれてしまった）
      "A案をベースに、より「サスペンス」を深める方向で候補を出す",
      "案2で進める",
    ]) {
      expect(isRequestLikeOption(text), text).toBe(true);
    }
  });

  it("答えの文は依頼文にしない（「〜たい」だけでは当てない）", () => {
    for (const text of [
      "ダンジョン配信の回線を敷くインフラ業者の青年が、最強の裏方として配信者を支える",
      "妹を守りたい",
      "失った居場所を取り戻したい",
      "三人称一元",
      // 「案」が入っていても、言葉の一部なら答えのまま
      "図案家の少女が街を描き直す",
    ]) {
      expect(isRequestLikeOption(text), text).toBe(false);
    }
  });

  it("案内文と伏せ字は中身にしない", () => {
    for (const text of [
      "（ここに最終決定したログラインが入ります）",
      "ここにテーマを書きます",
      "〇〇が××する話",
      "【未定】",
      "",
    ]) {
      expect(isPlaceholderContent(text), text).toBe(true);
    }
    expect(isPlaceholderContent("回線業者が最強の世界")).toBe(false);
  });
});

describe("決まったことを項目の中身に組む", () => {
  const decisions: PlotDecision[] = [
    { topic: "着想", answer: "現代にダンジョン。回線業者が最強", section: "outline" },
    { topic: "最強の理由", answer: "回線が魔力も運ぶ", section: "worldview" },
    { topic: "主人公", answer: "その業者に入った新人", section: "mainCharacters" },
    { topic: "目標の文字数", answer: "10万字", section: "outline" },
  ];

  it("何についての答えかを残す（「名前：答え」）", () => {
    const contents = composeSectionContents(decisions);
    expect(contents.get("worldview")).toBe("最強の理由：回線が魔力も運ぶ");
  });

  it("箇条書きの項目・2件以上は `- ` で並べる", () => {
    const contents = composeSectionContents(decisions);
    expect(contents.get("outline")).toBe(
      "- 着想：現代にダンジョン。回線業者が最強\n- 目標の文字数：10万字"
    );
    expect(contents.get("mainCharacters")).toBe("- 主人公：その業者に入った新人");
  });

  it("名前が見出しと同じなら、答えだけを書く", () => {
    const contents = composeSectionContents([
      { topic: "テーマ", answer: "裏方の誇り", section: "theme" },
    ]);
    expect(contents.get("theme")).toBe("裏方の誇り");
  });

  it("同じ名前で答え直したら、あとの答えを使う", () => {
    const contents = composeSectionContents([
      { topic: "最強の理由", answer: "古い答え", section: "worldview" },
      { topic: "最強の理由", answer: "新しい答え", section: "worldview" },
    ]);
    expect(contents.get("worldview")).toBe("最強の理由：新しい答え");
  });
});

describe("どの項目を書くか（作者が書いたものを上書きしない）", () => {
  const decisions: PlotDecision[] = [
    { topic: "最強の理由", answer: "回線が魔力も運ぶ", section: "worldview" },
    { topic: "テーマ", answer: "裏方の誇り", section: "theme" },
  ];

  it("空の項目は書く。作者が書いた項目は書かず、中身ごと返す", () => {
    const sections = emptyPlotSections();
    sections.theme = "作者が書いたテーマ";
    const plan = planPlotWrite(decisions, sections, new Map());

    expect(plan.write).toEqual([
      { section: "worldview", content: "最強の理由：回線が魔力も運ぶ" },
    ]);
    expect(plan.kept).toEqual([
      { section: "theme", heading: "テーマ", content: "裏方の誇り" },
    ]);
  });

  it("この問答が前に書いたままの項目は、書き足してよい", () => {
    const sections = emptyPlotSections();
    sections.worldview = "最強の理由：回線が魔力も運ぶ";
    const more: PlotDecision[] = [
      ...decisions,
      { topic: "ダンジョンの形", answer: "地下に亀裂が開く", section: "worldview" },
    ];
    const plan = planPlotWrite(
      more,
      sections,
      new Map([["worldview", "最強の理由：回線が魔力も運ぶ"]])
    );
    expect(plan.write.map((item) => item.section)).toContain("worldview");
    expect(plan.kept).toEqual([]);
  });

  it("作者が手で直したあとは、前に書いた項目でも書かない", () => {
    const sections = emptyPlotSections();
    sections.worldview = "作者が直した世界観";
    const plan = planPlotWrite(
      decisions,
      sections,
      new Map([["worldview", "最強の理由：回線が魔力も運ぶ"]])
    );
    expect(plan.kept.map((item) => item.section)).toContain("worldview");
  });

  it("雛形の案内だけの項目は空として書く", () => {
    const sections = parsePlotMarkdown(buildPlotTemplate("回線の街")).sections;
    const plan = planPlotWrite(
      [{ topic: "ログライン", answer: "回線業者が最強", section: "logline" }],
      sections,
      new Map()
    );
    expect(plan.write).toEqual([{ section: "logline", content: "回線業者が最強" }]);
  });

  it("もう同じ中身が入っていれば、書き直さない", () => {
    const sections = emptyPlotSections();
    sections.worldview = "最強の理由：回線が魔力も運ぶ";
    const plan = planPlotWrite(decisions.slice(0, 1), sections, new Map());
    expect(plan.write).toEqual([]);
    expect(plan.kept).toEqual([]);
  });
});

describe("AIへ渡すプロットの中身", () => {
  it("書いてある項目と作者が立てた見出しを渡し、雛形の案内は落とす", () => {
    const parsed = parsePlotMarkdown(
      [
        "# 回線の街",
        "",
        "## ログライン",
        "<!-- 誰が / どんな状況で -->",
        "回線業者が最強",
        "",
        "## テーマ",
        "",
        "## 着想",
        "配信のための通信線を敷く業者",
        "",
      ].join("\n")
    );
    const text = describeWrittenPlot(parsed.sections, parsed.extra);
    expect(text).toContain("【ログライン】回線業者が最強");
    expect(text).not.toContain("<!--");
    expect(text).not.toContain("【テーマ】");
    expect(text).toContain("配信のための通信線を敷く業者");
  });

  it("雛形だけなら何も渡さない", () => {
    const parsed = parsePlotMarkdown(buildPlotTemplate("回線の街"));
    expect(describeWrittenPlot(parsed.sections, parsed.extra)).toBe("");
  });
});

describe("終えるときの一言", () => {
  it("決まったことを一覧で残す", () => {
    const text = describePlotDialogueEnd([
      { topic: "最強の理由", answer: "回線が魔力も運ぶ", section: "worldview" },
    ]);
    expect(text).toContain("・最強の理由：回線が魔力も運ぶ");
    expect(text).toContain(PLOT_WRITE_OPTION);
  });
});
