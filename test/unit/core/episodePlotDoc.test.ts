import { describe, expect, test } from "vitest";
import {
  EPISODE_PLOT_SECTION_LABELS,
  describeEpisodePlotContrastConfirm,
  describeEpisodePlotDesignConfirm,
  episodePlotChapterOfPath,
  episodePlotCompletionParts,
  isEpisodePlotWritten,
  parseEpisodePlot,
} from "../../src/core/episodePlotDoc";
import {
  buildEpisodePlotTemplate,
  episodePlotChapterFromFileName,
  episodePlotFileName,
} from "../../src/core/resumeSheet";

/**
 * 単話プロット（設計書6.36.2）の読み取り。
 *
 * **AIへ渡す材料は、この解析が作る。** 雛形の見出しを変えたときに
 * 静かに空を送り始めないよう、雛形そのものを材料にした試験を置く。
 */

const WRITTEN = [
  "# 第3話の単話プロット",
  "",
  "## 視点",
  "ミナ（一人称）",
  "",
  "## この話の目標",
  "ミナが兄の死を受け入れ、旅に出ると決める。",
  "",
  "## 展開（箇条書き）",
  "- 朝、兄の部屋を片付ける",
  "- 形見の懐中時計を見つける",
  "・老人が訪ねてくる",
  "",
].join("\n");

describe("単話プロットの読み取り", () => {
  test("3つの節を取り出す", () => {
    const doc = parseEpisodePlot(WRITTEN);

    expect(doc.viewpoint).toBe("ミナ（一人称）");
    expect(doc.goal).toBe("ミナが兄の死を受け入れ、旅に出ると決める。");
    expect(doc.items.map((item) => item.text)).toEqual([
      "朝、兄の部屋を片付ける",
      "形見の懐中時計を見つける",
      "老人が訪ねてくる",
    ]);
  });

  test("箇条書きには行番号が付く（指摘から飛べるようにする）", () => {
    const doc = parseEpisodePlot(WRITTEN);

    // 「- 朝、兄の部屋を片付ける」は10行目
    expect(doc.items[0].line).toBe(10);
    expect(doc.items[2].line).toBe(12);
  });

  test("雛形のままなら、3つとも「まだ書かれていない」", () => {
    const doc = parseEpisodePlot(buildEpisodePlotTemplate(3));

    // 問いかけの括弧書きと、中身の無い箇条書きは中身として数えない
    expect(doc.viewpoint).toBe("");
    expect(doc.goal).toBe("");
    expect(doc.items).toEqual([]);
    expect(doc.blanks).toEqual([...EPISODE_PLOT_SECTION_LABELS]);
    expect(isEpisodePlotWritten(doc)).toBe(false);
  });

  test("展開だけ書かれていれば、検査はできる", () => {
    const doc = parseEpisodePlot(
      ["## 展開（箇条書き）", "- 兄の部屋を片付ける", "- 旅に出る"].join("\n")
    );

    expect(isEpisodePlotWritten(doc)).toBe(true);
    expect(doc.blanks).toContain("視点");
    expect(doc.blanks).toContain("この話の目標");
  });

  test("箇条書きの印が無くても、書かれた行は展開として拾う", () => {
    // 作者が「-」を付けずに書くことがある。**印の有無で黙って落とさない**
    const doc = parseEpisodePlot(
      ["## 展開（箇条書き）", "兄の部屋を片付ける", "", "旅に出る"].join("\n")
    );

    expect(doc.items.map((item) => item.text)).toEqual([
      "兄の部屋を片付ける",
      "旅に出る",
    ]);
  });

  test("見出しが1つも無ければ、何も読み取らない（推測で埋めない）", () => {
    const doc = parseEpisodePlot("ただのメモ\n- 何か\n");

    expect(doc.items).toEqual([]);
    expect(isEpisodePlotWritten(doc)).toBe(false);
  });

  test("ファイル名の話数は、作る側と読む側で往復する", () => {
    for (const chapter of [1, 19, 120]) {
      expect(
        episodePlotChapterFromFileName(episodePlotFileName(chapter))
      ).toBe(chapter);
    }
    // 単話プロットではないファイルは読み取らない（推測で埋めない）
    expect(episodePlotChapterFromFileName("第3話のメモ.md")).toBeNull();
    expect(episodePlotChapterFromFileName("plot.md")).toBeNull();
  });

  test("開いているファイルが単話プロットかは、置き場まで見て決める", () => {
    expect(
      episodePlotChapterOfPath("C:/work/設定/episode-plots/第3話.md")
    ).toBe(3);
    // 本文の「第3話.md」を単話プロットとして扱わない
    expect(episodePlotChapterOfPath("C:/work/本文/第3話.md")).toBeNull();
    expect(
      episodePlotChapterOfPath("C:/work/設定/episode-plots/メモ.md")
    ).toBeNull();
  });

  test("見出しの言い換えにも追随する（「## 展開」だけでも読む）", () => {
    const doc = parseEpisodePlot(
      ["## 語り手の視点", "ミナ", "## 展開", "- 旅に出る"].join("\n")
    );

    expect(doc.viewpoint).toBe("ミナ");
    expect(doc.items).toHaveLength(1);
  });
});

/**
 * AIを掛ける前の確認と、済んだあとの知らせ（実機確認リスト F-73）。
 *
 * **何を送るのかを、押す前に言い切る。** 「設計を検査」は箇条書きだけ、
 * 「本文と照合」は本文も送る——この違いが読めないと、作者は押せない。
 */
describe("AIを掛ける前の確認", () => {
  test("設計の検査は「本文は送りません」と言い切る（実機確認リスト F-73 の代わり）", () => {
    const text = describeEpisodePlotDesignConfirm({ items: 6, blanks: [] });
    expect(text).toContain("展開の箇条書き 6件を送ります（本文は送りません）。");
    expect(text).toContain("プロットは書き換えません。");
    // 無料のAIでは、課金の断りを出さない
    expect(text).not.toContain("課金");
  });

  test("空の節があれば、先に断る（実機確認リスト F-73 の代わり）", () => {
    const text = describeEpisodePlotDesignConfirm({
      items: 6,
      blanks: ["視点", "この話の目標"],
    });
    expect(text).toContain("まだ書かれていない節があります：視点・この話の目標");
  });

  test("有料のAIなら、1回ぶん課金されると言う（実機確認リスト F-73 の代わり）", () => {
    const text = describeEpisodePlotDesignConfirm({
      items: 3,
      blanks: [],
      paidProvider: "Google Gemini",
    });
    expect(text).toContain("Google Gemini は1回ぶん課金されます。");
  });

  test("本文との照合は、本文の字数も出す（実機確認リスト F-73 の代わり）", () => {
    const text = describeEpisodePlotContrastConfirm({
      bodyLength: 2547,
      items: 6,
      droppedChars: 0,
    });
    expect(text).toContain("本文 2547字と、展開の箇条書き 6件を送ります。");
    expect(text).not.toContain("送りません。");
  });

  test("入り切らないぶんは、黙って切らない（実機確認リスト F-73 の代わり）", () => {
    const text = describeEpisodePlotContrastConfirm({
      bodyLength: 30000,
      items: 6,
      droppedChars: 4200,
    });
    expect(text).toContain("この話は長いため、後ろの 4200字は送りません。");
  });
});

describe("済んだあとの知らせ", () => {
  test("捨てた件数と内訳を出す（実機確認リスト F-73 の代わり）", () => {
    expect(
      episodePlotCompletionParts({
        findings: 2,
        rejectedCount: 3,
        rejectSummary: "箇条書きに無い 2件、理由が空 1件",
      })
    ).toEqual(["指摘 2件", "捨てた 3件（箇条書きに無い 2件、理由が空 1件）"]);
  });

  test("捨てたものが無ければ、その行を出さない（実機確認リスト F-73 の代わり）", () => {
    expect(
      episodePlotCompletionParts({
        findings: 0,
        rejectedCount: 0,
        rejectSummary: "",
      })
    ).toEqual(["指摘 0件"]);
  });

  test("書かれていない節と、送らなかった字数も添える（実機確認リスト F-73 の代わり）", () => {
    expect(
      episodePlotCompletionParts({
        findings: 1,
        rejectedCount: 0,
        rejectSummary: "",
        blanks: ["視点"],
      })
    ).toEqual(["指摘 1件", "まだ書かれていない節：視点"]);

    expect(
      episodePlotCompletionParts({
        findings: 1,
        rejectedCount: 0,
        rejectSummary: "",
        droppedChars: 800,
      })
    ).toEqual(["指摘 1件", "長さの上限で 800字を送っていません"]);
  });
});
