import { describe, it, expect } from "vitest";
import {
  PLOT_QUESTIONS,
  isBlank,
  pendingQuestions,
  nextQuestion,
  describeProgress,
  sectionKeyOf,
} from "../../src/core/plotInterview";
import {
  emptyPlotSections,
  parsePlotMarkdown,
  PLOT_SECTIONS,
} from "../../src/core/plotDoc";
import { buildPlotTemplate } from "../../src/core/plotTemplate";

/**
 * 対話でプロットを作る（設計書6.4.7）。
 *
 * **AIに筋書きを作らせない。** ここでやるのは引き出すことなので、
 * 「何を、どの順で尋ねるか」が機能そのものである。
 */

describe("尋ねる項目", () => {
  it("すべて plot.md に実在する見出しを指す", () => {
    // 存在しない項目を尋ねると、答えても書き込む先が無い
    for (const question of PLOT_QUESTIONS) {
      const found = PLOT_SECTIONS.find((s) => s.key === question.key);
      expect(found, question.key).toBeDefined();
      expect(found?.heading, question.key).toBe(question.heading);
    }
  });

  it("タイトル・形式・ジャンルは尋ねない", () => {
    // タイトルは作品を作るときに決めており、形式とジャンルは
    // 「形式とジャンルを決める」で選ぶ。同じことを2か所で聞かない
    const keys = PLOT_QUESTIONS.map((q) => q.key);
    expect(keys).not.toContain("title");
    expect(keys).not.toContain("format");
    expect(keys).not.toContain("genre");
  });

  it("ログラインを最初に尋ねる", () => {
    // 話を一言で言えると、テーマも世界観もそこから決まる。
    // 逆から始めると、話の無い設定だけが増える
    expect(PLOT_QUESTIONS[0].key).toBe("logline");
  });

  it("同じ項目を二度尋ねない", () => {
    const keys = PLOT_QUESTIONS.map((q) => q.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("どの問いにも、押すだけで答えられる例がある", () => {
    // **言葉に詰まったところで対話が止まる。** 例が無いと再開できない
    for (const question of PLOT_QUESTIONS) {
      expect(question.options.length, question.key).toBeGreaterThan(0);
    }
  });

  it("問いにMarkdownの記号を混ぜない", () => {
    // 相談パネルはHTMLを自分で組み立てるので、記号がそのまま出る
    for (const question of PLOT_QUESTIONS) {
      expect(question.question, question.key).not.toContain("**");
      for (const option of question.options) {
        expect(option, question.key).not.toContain("**");
      }
    }
  });
});

describe("まだ書かれていないかの判定", () => {
  it("空なら書かれていない", () => {
    expect(isBlank("")).toBe(true);
    expect(isBlank("   \n  \n")).toBe(true);
  });

  it("ひな形の案内文は「書かれている」に数えない", () => {
    // **これを数えると、テンプレートを作った直後に「全部埋まっています」と出る**
    expect(isBlank("<!-- 誰が / どんな状況で / 何を目指し / 何が障害か -->")).toBe(
      true
    );
  });

  it("箇条書きの空の印も数えない", () => {
    expect(isBlank("-")).toBe(true);
    expect(isBlank("-\n-\n-")).toBe(true);
  });

  it("何か書いてあれば、書かれている", () => {
    expect(isBlank("幽霊になった少年が、いじめの真相を暴く")).toBe(false);
    expect(isBlank("- 転生する")).toBe(false);
  });
});

describe("次に尋ねる項目", () => {
  it("何も書けていなければ、最初の項目から", () => {
    expect(nextQuestion(emptyPlotSections())?.key).toBe("logline");
  });

  it("書けている項目は飛ばす", () => {
    const sections = emptyPlotSections();
    sections.logline = "幽霊になった少年が、いじめの真相を暴く";
    sections.theme = "赦し";
    expect(nextQuestion(sections)?.key).toBe("worldview");
  });

  it("すべて書けていれば、尋ねるものが無い", () => {
    const sections = emptyPlotSections();
    for (const question of PLOT_QUESTIONS) sections[question.key] = "書いた";
    expect(nextQuestion(sections)).toBeUndefined();
    expect(pendingQuestions(sections)).toEqual([]);
  });

  it("尋ねる順は決めた順のまま", () => {
    const sections = emptyPlotSections();
    sections.logline = "書いた";
    expect(pendingQuestions(sections).map((q) => q.key)).toEqual(
      PLOT_QUESTIONS.slice(1).map((q) => q.key)
    );
  });
});

describe("どこまで進んだか", () => {
  it("残りが見えるように、数で出す", () => {
    // 終わりが見えないと、どこで切り上げてよいか分からない
    const sections = emptyPlotSections();
    expect(describeProgress(sections)).toContain("0項目");

    sections.logline = "書いた";
    sections.theme = "書いた";
    expect(describeProgress(sections)).toContain("2項目");
  });

  it("項目の総数と一致する", () => {
    expect(describeProgress(emptyPlotSections())).toContain(
      `${PLOT_QUESTIONS.length}項目`
    );
  });
});

describe("見出しから節を引く", () => {
  it("実在する見出しを引ける", () => {
    expect(sectionKeyOf("ログライン")).toBe("logline");
    expect(sectionKeyOf("主人公の行動原理")).toBe("protagonistMotive");
  });

  it("知らない見出しは引かない", () => {
    expect(sectionKeyOf("あとがき")).toBeUndefined();
  });
});

describe("作ったばかりのプロットで試す", () => {
  it("ひな形の直後は、最初の項目から尋ねる", () => {
    // **ここを間違えると、作った直後に「全部埋まっています」と出る。**
    // ひな形は案内をHTMLコメントで置くので、それを中身と数えてはいけない
    const sections = parsePlotMarkdown(
      buildPlotTemplate("いじめられっ子")
    ).sections;

    expect(nextQuestion(sections)?.key).toBe("logline");
    expect(pendingQuestions(sections)).toHaveLength(PLOT_QUESTIONS.length);
    expect(describeProgress(sections)).toContain("0項目");
  });

  it("ひな形に無い見出しでも、尋ねる対象にする", () => {
    // **ひな形が置くのはログラインとあらすじだけ**で、テーマや世界観の
    // 見出しは無い。「見出しが無い＝要らない」ではないので、尋ねる。
    // 書き込むときは `updatePlotMarkdown` が末尾へ見出しを足す（6.4.1）
    const template = buildPlotTemplate("いじめられっ子");
    expect(template).not.toContain("## テーマ");

    const sections = parsePlotMarkdown(template).sections;
    expect(pendingQuestions(sections).map((q) => q.key)).toContain("theme");
  });

  it("作品名は見出しに入るので、タイトルは尋ねない", () => {
    const template = buildPlotTemplate("いじめられっ子");
    expect(template).toContain("# いじめられっ子");
    expect(PLOT_QUESTIONS.map((q) => q.key)).not.toContain("title");
  });
});
