import { describe, expect, test } from "vitest";
import { buildPlotTemplate } from "../../src/core/plotTemplate";
import { PLOT_SECTIONS } from "../../src/core/plotDoc";

/**
 * プロットの書き出し。
 *
 * **用紙ではなく書き出しにする**（作者の指示、2026-08-16）。
 * 以前は決まった10個の見出しを空のまま並べていた。開いた瞬間に
 * 埋めるべき欄が10個あるのは、自由に書く文書ではなく記入用紙である。
 */
describe("プロットの書き出し", () => {
  test("作品名を見出しにする", () => {
    const template = buildPlotTemplate("こちら冒険者ギルド生活保護課!!");

    expect(template.split("\n")[0]).toBe("# こちら冒険者ギルド生活保護課!!");
  });

  test("空欄を並べない", () => {
    const headings = buildPlotTemplate("無題").match(/^## /gm) ?? [];

    expect(headings.length).toBeLessThanOrEqual(2);
  });

  test("自由に書いてよいと書く", () => {
    // 見出しがあると、それを埋めるものだと受け取られる
    const template = buildPlotTemplate("無題");

    expect(template).toContain("自由に書けます");
    expect(template).toContain("消してよく");
  });

  test("使える見出しの名前は、案内に全部載せる", () => {
    // 使いたい人には名前が要る。使わない人には空欄が要らない。
    // 設計書6.4がプロットモードで扱う項目
    const template = buildPlotTemplate("無題");

    for (const section of PLOT_SECTIONS) {
      expect(template, section.heading).toContain(section.heading);
    }
  });

  test("AIが何をするかを書く", () => {
    // 「書き足される」ことが分からないと、自由に書いてよいのか判断できない
    const template = buildPlotTemplate("無題");

    expect(template).toContain("その場所へ");
    expect(template).toContain("末尾へ足します");
  });

  test("書き方に迷う項目には注釈を添える", () => {
    // 「ログライン」と言われて何を書くか分かる作者ばかりではない
    expect(buildPlotTemplate("無題")).toContain(
      "誰が / どんな状況で / 何を目指し / 何が障害か"
    );
  });
});
