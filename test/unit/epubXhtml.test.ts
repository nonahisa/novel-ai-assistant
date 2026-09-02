import { describe, expect, test } from "vitest";
import {
  buildChapterFragment,
  buildChapterXhtml,
} from "../../src/core/epubXhtml";

/**
 * 話1つぶんのXHTML（設計書6.65.4の第1段）。
 *
 * **XMLとして閉じていないと、リーダーは本を開かない**（HTMLと違って
 * 直してくれない）。本文に書かれた `&` や `<` が素通りしないことを見る。
 */
function fragment(
  body: string,
  options?: { collapseBlankLines?: boolean; heading?: string }
): string {
  return buildChapterFragment(
    {
      heading: options?.heading ?? "第一話　出会い",
      body,
      notation: "curly",
    },
    { collapseBlankLines: options?.collapseBlankLines ?? true }
  );
}

describe("ルビと傍点", () => {
  test("{漢字|かんじ} は <ruby> になる", () => {
    expect(fragment("{漢字|かんじ}を読む")).toContain(
      "<ruby>漢字<rt>かんじ</rt></ruby>を読む"
    );
  });

  test("{{強調}} は傍点の span になる", () => {
    expect(fragment("これは{{大事}}だ")).toContain(
      '<span class="emphasis">大事</span>'
    );
  });

  test("投稿サイトの記法（.txt）も組む", () => {
    const html = buildChapterFragment(
      { heading: "見出し", body: "｜漢字《かんじ》", notation: "site" },
      { collapseBlankLines: true }
    );
    expect(html).toContain("<ruby>漢字<rt>かんじ</rt></ruby>");
  });
});

describe("XMLとして閉じている", () => {
  test("& < > \" が逃がされる", () => {
    const html = fragment('A & B <tag> "引用"');

    expect(html).toContain("A &amp; B &lt;tag&gt; &quot;引用&quot;");
    expect(html).not.toContain("<tag>");
  });

  test("ルビの中身も逃がされる", () => {
    expect(fragment("{A&B|えーあんどびー}")).toContain(
      "<ruby>A&amp;B<rt>えーあんどびー</rt></ruby>"
    );
  });

  test("見出しも逃がされる", () => {
    expect(fragment("本文", { heading: "第一話　<運命>&出会い" })).toContain(
      "第一話　&lt;運命&gt;&amp;出会い"
    );
  });

  test("空要素は自分で閉じる（<br> ではなく <br />）", () => {
    const html = fragment("あ\n\n\nい", { collapseBlankLines: false });
    expect(html).toContain("<br />");
    expect(html).not.toMatch(/<br>/);
  });
});

describe("空行の詰め方", () => {
  /**
   * 仕様（設計書6.65.2「改行が2つ並んでいたら1つに」を一般化したもの）：
   * **続いた空行は1つ減る。**
   *
   *   - 空行1つ（改行2連続）→ 0（消える）……Webの作法の「段落ごとの1行空け」が消える
   *   - 空行2つ（改行3連続）→ 1 ……作者が意図して広く空けた場面転換は、空きとして残る
   *   - 空行3つ → 2
   *
   * 全部消してしまうと場面の切り替わりが消え、そのまま残すと本にしたとき
   * 隙間だらけになる。「1つ減らす」はその両方を避ける。
   */
  function blanks(html: string): number {
    return [...html.matchAll(/<p class="blank">/g)].length;
  }

  test("空行1つは消える", () => {
    const html = fragment("あ\n\nい");
    expect(blanks(html)).toBe(0);
    expect([...html.matchAll(/<p>/g)]).toHaveLength(2);
  });

  test("空行2つは1つになる", () => {
    expect(blanks(fragment("あ\n\n\nい"))).toBe(1);
  });

  test("空行3つは2つになる", () => {
    expect(blanks(fragment("あ\n\n\n\nい"))).toBe(2);
  });

  test("collapseBlankLines が false なら詰めない", () => {
    expect(blanks(fragment("あ\n\nい", { collapseBlankLines: false }))).toBe(1);
    expect(
      blanks(fragment("あ\n\n\nい", { collapseBlankLines: false }))
    ).toBe(2);
  });

  test("本文の前後の空行は、詰める設定に関わらず落とす", () => {
    // 話の頭に空きが入ると、見出しから本文までが不揃いになる
    const html = fragment("\n\nあ\n\n", { collapseBlankLines: false });
    expect(blanks(html)).toBe(0);
  });

  test("改行コードがCRLFでも同じに詰める", () => {
    expect(blanks(fragment("あ\r\n\r\n\r\nい"))).toBe(1);
  });
});

describe("シーンメモは本へ入れない", () => {
  test("メモ行は行ごと落ちる（空きも作らない）", () => {
    const html = fragment("あ\n// あとで直す\nい");
    expect(html).not.toContain("あとで直す");
    expect([...html.matchAll(/<p>/g)]).toHaveLength(2);
  });
});

describe("XHTML文書の枠", () => {
  test("宣言・名前空間・スタイルシートが揃う", () => {
    const doc = buildChapterXhtml(
      { heading: "第一話", body: "あ", notation: "curly" },
      { collapseBlankLines: true, cssHref: "style.css", vertical: true }
    );

    expect(doc.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(doc).toContain('xmlns="http://www.w3.org/1999/xhtml"');
    expect(doc).toContain('<link rel="stylesheet" type="text/css" href="style.css" />');
    expect(doc).toContain('<body class="vertical">');
    expect(doc.trimEnd().endsWith("</html>")).toBe(true);
  });

  test("横書きなら body の目印が変わる", () => {
    const doc = buildChapterXhtml(
      { heading: "第一話", body: "あ", notation: "curly" },
      { collapseBlankLines: true, cssHref: "style.css", vertical: false }
    );
    expect(doc).toContain('<body class="horizontal">');
  });
});
