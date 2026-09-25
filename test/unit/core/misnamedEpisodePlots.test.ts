import { describe, expect, test } from "vitest";
import {
  misnamedEpisodePlotNotice,
  misnamedEpisodePlots,
} from "../../../src/core/plotMode";
import { EPISODE_PLOT_MOVING_PREFIX } from "../../../src/core/episodePlotOrder";

/**
 * 単話プロットの置き場にある、`第N話.md` の形でないファイル
 * （2026-09-26 精査 R11 ③。引継ぎ書「いまの状態」【0.77.0 の不具合・粗さ】）。
 *
 * 確認用コピーには、手で置いた `episode_0005.md`（第5話の下ごしらえ）があり、
 * プロットモードには**何も言わずに**出なかった。名前から話数を読むのは
 * `episodePlotChapterFromFileName` の1か所だけ（読む側だけ別の形を覚えると、
 * 開く・作る・並べ替える側が `第N話.md` を探して食い違う）なので、
 * **並べずに、名前を直せば並ぶことを知らせる。** 名前は勝手に変えない。
 */
describe("名前の形が違う単話プロット", () => {
  test("第N話.md でない .md を拾い、直す先の名前を添える", () => {
    expect(misnamedEpisodePlots(["第1話.md", "episode_0005.md"])).toEqual([
      { name: "episode_0005.md", suggested: "第5話.md" },
    ]);
  });

  test("話数の読めない名前は、直す先を出さない（推測で決めない）", () => {
    expect(misnamedEpisodePlots(["メモ.md", "2026-09-01_案.md"])).toEqual([
      { name: "メモ.md", suggested: null },
      { name: "2026-09-01_案.md", suggested: null },
    ]);
  });

  test("直す先の名前が既にあれば、直す先を出さない（上書きさせない）", () => {
    expect(misnamedEpisodePlots(["第5話.md", "episode_0005.md"])).toEqual([
      { name: "episode_0005.md", suggested: null },
    ]);
  });

  test(".md でないもの・並べ替えの途中の一時名は数えない", () => {
    expect(
      misnamedEpisodePlots([
        "下書き.txt",
        `${EPISODE_PLOT_MOVING_PREFIX}第3話.md`,
        "第2話.md",
      ])
    ).toEqual([]);
  });

  test("知らせの文：名前と、直す先があれば直す先", () => {
    const notice = misnamedEpisodePlotNotice([
      { name: "episode_0005.md", suggested: "第5話.md" },
      { name: "メモ.md", suggested: null },
    ]);
    expect(notice).toContain("episode_0005.md（「第5話.md」にすると並びます）");
    expect(notice).toContain("メモ.md");
    expect(notice).toContain("名前は変えていません");
  });

  test("無ければ知らせない", () => {
    expect(misnamedEpisodePlotNotice([])).toBeNull();
  });

  test("多いときは先頭の5件と残りの数", () => {
    const many = Array.from({ length: 7 }, (_, index) => ({
      name: `メモ${index + 1}.md`,
      suggested: null,
    }));
    const notice = misnamedEpisodePlotNotice(many) ?? "";
    expect(notice).toContain("メモ5.md");
    expect(notice).not.toContain("メモ6.md");
    expect(notice).toContain("ほか2件");
  });
});
