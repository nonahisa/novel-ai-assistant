import { describe, expect, it } from "vitest";
import { hasWrittenPlot } from "../../../src/core/prerequisiteCheck";
import { updatePlotMarkdown } from "../../../src/core/plotDoc";
import { buildPlotTemplate } from "../../../src/core/plotTemplate";

/**
 * 「プロットが書かれているか」の数え方（設計書6.94）。
 *
 * **分類の覚書だけの `plot.md` を「プロットがある」と読んではいけない**
 * （2026-09-19、作者の実機確認）。ZIPからの取り込みは `about.txt` の
 * ジャンルとタグを `## ジャンル`・`## モチーフ` へ下書きするので、
 * 取り込んだ直後の作品は必ずこの形になる。これを「ある」と読むと、
 * 「ひと通り仕上げる」がプロット逆算を飛ばし、**中身の無いプロットの
 * まま先へ進んでしまう。**
 *
 * 見逃し（本当はあるのに無いと言う）と誤検出（無いのにあると言う）の
 * 両方を見る——片方だけだと「いつでも無いと言う実装」が満点になる。
 */

const TITLE = "星を継ぐ者たち";

/** ZIPの取り込みが書くのと同じ形の `plot.md` を作る */
function importedPlot(): string {
  return updatePlotMarkdown(
    "",
    { genre: "- 異世界ファンタジー", motif: "- 異世界転生\n- チート" },
    { workTitle: TITLE }
  );
}

describe("プロットに中身があるか", () => {
  it("ZIPから取り込んだ直後（ジャンルとモチーフだけ）は、まだ無いと読む", () => {
    const text = importedPlot();
    // 前提：下書きそのものは書けている（判定だけを見ている）
    expect(text).toContain("異世界ファンタジー");
    expect(text).toContain("チート");

    expect(hasWrittenPlot(text)).toBe(false);
  });

  it("「形式とジャンルを決める」だけを実行した状態も、まだ無いと読む", () => {
    const text = updatePlotMarkdown(
      "",
      { format: "長編", genre: "- 現代ドラマ（カクヨム）" },
      { workTitle: TITLE }
    );

    expect(hasWrittenPlot(text)).toBe(false);
  });

  it("タイトルだけが入っていても、まだ無いと読む", () => {
    const text = updatePlotMarkdown("", { title: TITLE }, { workTitle: TITLE });

    expect(hasWrittenPlot(text)).toBe(false);
  });

  it("ログラインが書かれていれば、あると読む", () => {
    const text = updatePlotMarkdown(
      importedPlot(),
      { logline: "受験生の少年が、教科書の知識だけで異世界を生き抜く。" },
      { workTitle: TITLE }
    );

    expect(hasWrittenPlot(text)).toBe(true);
  });

  it("あらすじが1行でも書かれていれば、あると読む", () => {
    const text = updatePlotMarkdown(
      "",
      { outline: "- 第1話　転生前夜" },
      { workTitle: TITLE }
    );

    expect(hasWrittenPlot(text)).toBe(true);
  });

  it("雛形のまま（見出しと案内だけ）は、まだ無いと読む", () => {
    expect(hasWrittenPlot(buildPlotTemplate(TITLE))).toBe(false);
  });

  it("ファイルが無ければ、まだ無いと読む", () => {
    expect(hasWrittenPlot(undefined)).toBe(false);
  });
});
