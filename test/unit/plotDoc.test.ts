import { describe, expect, test } from "vitest";
import {
  buildPlotMarkdown,
  emptyPlotSections,
  isBlankPlotSection,
  parsePlotMarkdown,
} from "../../src/core/plotDoc";
import { buildPlotTemplate } from "../../src/core/plotTemplate";
import {
  parsePlotReverseResult,
  validatePlotReverseResult,
} from "../../src/core/plotReverseValidation";

describe("プロットの読み取りと組み立て", () => {
  test("見出しごとに中身を取り出す", () => {
    const parsed = parsePlotMarkdown(
      "# 作品\n\n## ログライン\n幽霊になった少年が転生する。\n\n## テーマ\nいじめと赦し。\n"
    );

    expect(parsed.sections.logline).toBe("幽霊になった少年が転生する。");
    expect(parsed.sections.theme).toBe("いじめと赦し。");
    expect(parsed.sections.worldview).toBe("");
  });

  test("書いたものをそのまま読み戻せる", () => {
    const sections = emptyPlotSections();
    sections.logline = "一文のログライン。";
    sections.outline = "- 出来事1\n- 出来事2";

    const parsed = parsePlotMarkdown(buildPlotMarkdown("作品", sections));

    expect(parsed.sections.logline).toBe("一文のログライン。");
    expect(parsed.sections.outline).toBe("- 出来事1\n- 出来事2");
  });

  test("作者が足した見出しを落とさない", () => {
    // 読み取れなかった部分を捨てると、書き戻したときに作者の文章が消える
    const parsed = parsePlotMarkdown(
      "# 作品\n\n## ログライン\n本文。\n\n## 参考にした作品\n- あの小説\n"
    );

    expect(parsed.extra).toContain("## 参考にした作品");
    expect(parsed.extra).toContain("- あの小説");

    const rebuilt = buildPlotMarkdown("作品", parsed.sections, {
      extra: parsed.extra,
    });
    expect(rebuilt).toContain("## 参考にした作品");
    expect(rebuilt).toContain("- あの小説");
  });

  test("テンプレートのままなら、どの項目も「書かれていない」と見なす", () => {
    // ここを空と見なさないと、テンプレートを作っただけの作品で
    // 「すでに作者が書いている」と判断し、逆算した内容を書き込めなくなる
    const parsed = parsePlotMarkdown(buildPlotTemplate("作品"));

    for (const [key, body] of Object.entries(parsed.sections)) {
      expect(isBlankPlotSection(body), key).toBe(true);
    }
  });

  test("一文字でも書いてあれば「書かれている」と見なす", () => {
    expect(isBlankPlotSection("あ")).toBe(false);
    expect(isBlankPlotSection("- 出来事")).toBe(false);
  });

  test("読み書きを繰り返しても内容が増えない", () => {
    // 組み立て側は案内コメントを毎回付け直す。読み取りで落としておかないと
    // 前回の案内が中身として残り、保存のたびに二重・三重に積もる
    const first = buildPlotTemplate("作品");
    const second = buildPlotMarkdown("作品", parsePlotMarkdown(first).sections, {
      hints: true,
    });
    const third = buildPlotMarkdown("作品", parsePlotMarkdown(second).sections, {
      hints: true,
    });

    expect(second).toBe(first);
    expect(third).toBe(first);
  });

  test("作者が書いたコメントは残す", () => {
    // 落とすのはテンプレート自身が置いた案内だけ。作者のメモは消さない
    const parsed = parsePlotMarkdown(
      "# 作品\n\n## テーマ\n<!-- あとで考える -->\n"
    );

    expect(parsed.sections.theme).toBe("<!-- あとで考える -->");
  });
});

describe("プロット逆算の応答の検証", () => {
  test("コードフェンス付きでも読める", () => {
    const parsed = parsePlotReverseResult(
      '```json\n{"logline":"一文。","outline":["出来事"]}\n```'
    );

    expect(parsed?.logline).toBe("一文。");
  });

  test("箇条書きの項目は Markdown の形にする", () => {
    const result = validatePlotReverseResult({
      logline: "一文。",
      outline: ["出来事1", "出来事2"],
      mainCharacters: [{ name: "灯", summary: "主人公。" }],
      motif: ["塔", "手紙"],
    });

    expect(result.sections.outline).toBe("- 出来事1\n- 出来事2");
    expect(result.sections.mainCharacters).toBe("- **灯**: 主人公。");
    expect(result.sections.motif).toBe("塔、手紙");
  });

  test("字数を超えても切り詰めず、超過を知らせる", () => {
    // 途中で切れた文はプロットとして使えない。直すか捨てるかは作者が決める
    const result = validatePlotReverseResult({
      logline: "あ".repeat(120),
      outline: [],
    });

    expect(result.sections.logline).toHaveLength(120);
    expect(result.overLimit.join()).toContain("ログライン");
  });

  test("読み取れなかった項目は埋めない", () => {
    // AIは「不明」「null」を文字列で返すことがある
    const result = validatePlotReverseResult({
      logline: "一文。",
      theme: "不明",
      worldview: "null",
      outline: [],
    });

    expect(result.sections.theme).toBe("");
    expect(result.sections.worldview).toBe("");
  });

  test("同じ項目が重なったら1つにする", () => {
    const result = validatePlotReverseResult({
      logline: "一文。",
      outline: ["出来事", "出来事", "別の出来事"],
    });

    expect(result.sections.outline).toBe("- 出来事\n- 別の出来事");
  });

  test("件数の上限を超えたら切る", () => {
    const result = validatePlotReverseResult({
      logline: "一文。",
      outline: Array.from({ length: 30 }, (_, index) => `出来事${index}`),
    });

    expect(result.sections.outline.split("\n")).toHaveLength(20);
  });

  test("形が違えば何も埋めない（壊れた値を書き込まない）", () => {
    const result = validatePlotReverseResult("文字列");

    expect(result.sections.logline).toBe("");
    expect(result.overLimit).toEqual([]);
  });
});
