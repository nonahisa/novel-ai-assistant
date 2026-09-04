import { describe, expect, test } from "vitest";
import {
  EPISODE_PLOT_SECTION_LABELS,
  episodePlotChapterOfPath,
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
