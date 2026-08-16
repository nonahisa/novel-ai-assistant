import { describe, expect, test } from "vitest";
import {
  buildPlotMarkdown,
  emptyPlotSections,
  isBlankPlotSection,
  updatePlotMarkdown,
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

  test("同じ内容を書き足しても増えない", () => {
    // 保存のたびに同じ節が二重・三重に積もっては使いものにならない
    const first = updatePlotMarkdown(
      buildPlotTemplate("作品"),
      { theme: "喪失と再生" },
      { workTitle: "作品" }
    );
    const second = updatePlotMarkdown(
      first,
      { theme: "喪失と再生" },
      { workTitle: "作品" }
    );

    expect(second).toBe(first);
    expect(first.match(/## テーマ/g)).toHaveLength(1);
  });

  test("作者が書いたコメントは残す", () => {
    // 落とすのはテンプレート自身が置いた案内だけ。作者のメモは消さない
    const parsed = parsePlotMarkdown(
      "# 作品\n\n## テーマ\n<!-- あとで考える -->\n"
    );

    expect(parsed.sections.theme).toBe("<!-- あとで考える -->");
  });
});

/**
 * プロットは**自由に書けるMarkdown**である（作者の指示、2026-08-16）。
 *
 * 以前は決まった10個の見出しへ分解して全体を組み直しており、
 * 作者が立てた見出しは末尾へ寄せられ、順番も毎回元へ戻されていた。
 * それでは自由に書けない。
 */
describe("書き足しても、作者の文書の形を変えない", () => {
  test("見出しがあれば、その場所で入れ替える", () => {
    const before = [
      "# 作品",
      "",
      "## あらすじ",
      "- 昔書いたもの",
      "",
      "## テーマ",
      "旧",
      "",
      "## 参考にした作品",
      "- あの小説",
      "",
    ].join("\n");

    const after = updatePlotMarkdown(
      before,
      { theme: "新" },
      { workTitle: "作品" }
    );

    // 位置が動いていない
    expect(after.indexOf("## あらすじ")).toBeLessThan(after.indexOf("## テーマ"));
    expect(after.indexOf("## テーマ")).toBeLessThan(
      after.indexOf("## 参考にした作品")
    );
    expect(after).toContain("新");
    expect(after).not.toContain("旧");
  });

  test("作者が立てた見出しを末尾へ寄せない", () => {
    // ここが以前の作りのいちばんの問題だった
    const before = "# 作品\n\n## 参考にした作品\n- あの小説\n\n## テーマ\n旧\n";

    const after = updatePlotMarkdown(
      before,
      { theme: "新" },
      { workTitle: "作品" }
    );

    expect(after.indexOf("## 参考にした作品")).toBeLessThan(
      after.indexOf("## テーマ")
    );
  });

  test("見出しが無ければ末尾へ足す（決まった順に割り込ませない）", () => {
    const before = "# 作品\n\n## 参考にした作品\n- あの小説\n";

    const after = updatePlotMarkdown(
      before,
      { logline: "一文。" },
      { workTitle: "作品" }
    );

    expect(after.indexOf("## 参考にした作品")).toBeLessThan(
      after.indexOf("## ログライン")
    );
  });

  test("消された見出しを復活させない", () => {
    // 要らないと判断したものを毎回書き戻すのは、作者の編集を
    // 無かったことにするのと同じ
    const before = "# 作品\n\n## テーマ\n旧\n";

    const after = updatePlotMarkdown(
      before,
      { theme: "新" },
      { workTitle: "作品" }
    );

    expect(after).not.toContain("## モチーフ");
    expect(after).not.toContain("## 人称");
  });

  test("触らない節は1文字も変えない", () => {
    // 作者が付けた空行や書き方の癖を、書き足しのついでに均さない
    const before = "# 作品\n\n## あらすじ\n\n\n-   ゆるい書き方\n\n\n## テーマ\n旧\n";

    const after = updatePlotMarkdown(
      before,
      { theme: "新" },
      { workTitle: "作品" }
    );

    expect(after).toContain("\n\n\n-   ゆるい書き方\n\n\n");
  });

  test("見出しの無い文章も残す", () => {
    // 「思いついたことだけ書き並べる」書き方を壊さない
    const before = "# 作品\n\n主人公が海辺で誰かを待っている場面から始めたい。\n";

    const after = updatePlotMarkdown(
      before,
      { theme: "喪失と再生" },
      { workTitle: "作品" }
    );

    expect(after).toContain("主人公が海辺で誰かを待っている場面から始めたい。");
    expect(after).toContain("## テーマ");
  });

  test("ファイルが無くても組み立てられる", () => {
    const after = updatePlotMarkdown(
      "",
      { logline: "一文。" },
      { workTitle: "作品" }
    );

    expect(after).toContain("# 作品");
    expect(after).toContain("## ログライン");
  });

  test("書き足すものが無ければ、1文字も触らない", () => {
    const before = "# 作品\n\n## テーマ\n旧\n";

    expect(updatePlotMarkdown(before, {}, { workTitle: "作品" })).toBe(before);
  });

  test("改行コードを変えない", () => {
    // 作者の環境や外部ツールが決めたものを、書き足しのついでに揃えない
    const before = "# 作品\r\n\r\n## テーマ\r\n旧\r\n";

    const after = updatePlotMarkdown(
      before,
      { theme: "新" },
      { workTitle: "作品" }
    );

    expect(after).toContain("\r\n");
    expect(after).not.toMatch(/[^\r]\n/);
  });
});

describe("書き出し（テンプレート）", () => {
  test("埋める欄を並べない", () => {
    // 開いた瞬間に空欄が10個あるのは、自由に書く文書ではなく記入用紙である
    const template = buildPlotTemplate("作品");
    const headings = template.match(/^## /gm) ?? [];

    expect(headings.length).toBeLessThanOrEqual(2);
  });

  test("自由に書いてよいことを書く", () => {
    expect(buildPlotTemplate("作品")).toContain("自由に書けます");
  });

  test("使える見出しの名前は載せる", () => {
    // 使いたい人には名前が要る。使わない人には空欄が要らない
    const template = buildPlotTemplate("作品");

    expect(template).toContain("モチーフ");
    expect(template).toContain("主人公の行動原理");
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

  test("全項目がnullで返ってきても壊れない", () => {
    // スキーマで全項目を必須・null許容にしたので、読み取れなかった項目は
    // 省略ではなく null で返る。落とされるより、明示されるほうが扱いやすい
    const result = validatePlotReverseResult({
      logline: null,
      theme: null,
      motif: null,
      worldview: null,
      setting: null,
      narrativePerson: null,
      protagonistMotive: null,
      outline: null,
      mainCharacters: null,
      notes: null,
    });

    for (const [key, value] of Object.entries(result.sections)) {
      expect(value, key).toBe("");
    }
    expect(result.notes).toBeNull();
  });

  test("一部だけnullでも、埋まっている項目は取り込む", () => {
    const result = validatePlotReverseResult({
      logline: "一文。",
      theme: null,
      motif: null,
      outline: ["出来事"],
      mainCharacters: null,
      notes: null,
    });

    expect(result.sections.logline).toBe("一文。");
    expect(result.sections.theme).toBe("");
    expect(result.sections.outline).toBe("- 出来事");
  });
});
