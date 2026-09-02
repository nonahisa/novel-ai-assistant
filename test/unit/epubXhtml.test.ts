import { describe, expect, test } from "vitest";
import {
  buildChapterFragment,
  buildChapterPlacement,
  buildChapterXhtml,
  countParagraphs,
  describePlacementOverflow,
  missingEpisodeNotices,
  placementsIn,
  splitParagraphs,
  type EpubBodyOptions,
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

/**
 * 挿絵とページ分割（設計書6.65.10）。
 *
 * 位置は「第M段落のあと」で、**段落は詰める前の数え方**——空行で区切った
 * 塊で数える。`collapseBlankLines` を切り替えても位置がずれてはいけない
 * （切り替えたとたんに挿絵が別の場面へ移る本になる）。
 */
describe("段落の数え方", () => {
  test("空行で区切った塊を1段落と数える", () => {
    expect(countParagraphs("あ\n\nい\n\n\nう")).toBe(3);
    // 続いた行は1つの塊。空行が段落を分ける
    expect(countParagraphs("あ\nい\n\nう")).toBe(2);
    expect(countParagraphs("")).toBe(0);
  });

  test("前後の空行は数に入らない", () => {
    expect(countParagraphs("\n\nあ\n\n\n")).toBe(1);
  });

  test("シーンメモの行は段落に数えない（本にも入らないので）", () => {
    expect(countParagraphs("あ\n// あとで直す\n\nい")).toBe(2);
  });

  test("段落の中身も取り出せる（欄の一覧に使う）", () => {
    expect(splitParagraphs("あ\nい\n\nう")).toEqual(["あ\nい", "う"]);
  });
});

describe("挿絵とページ分割", () => {
  function placed(body: string, options: Partial<EpubBodyOptions> = {}) {
    return buildChapterPlacement(
      { heading: "第一話", body, notation: "curly" },
      { collapseBlankLines: true, ...options }
    );
  }

  const illustration = {
    afterParagraph: 2,
    href: "illust-1.png",
    caption: "",
  };

  test("挿絵は指定した段落の直後に入る", () => {
    const html = placed("あ\n\nい\n\nう", {
      illustrations: [illustration],
    }).html;

    expect(html).toMatch(/<p>い<\/p>\n<figure class="illustration">/);
    expect(html.indexOf("<figure")).toBeLessThan(html.indexOf("<p>う</p>"));
  });

  test("詰める設定を変えても、同じ段落の直後に入る", () => {
    // **これが「詰める前の段落番号」の意味**である（設計書6.65.10）
    const body = "あ\n\nい\n\n\nう";
    for (const collapseBlankLines of [true, false]) {
      const html = placed(body, {
        collapseBlankLines,
        illustrations: [illustration],
      }).html;
      expect(html).toMatch(/<p>い<\/p>\n<figure/);
    }
  });

  test("解説文があれば figcaption を添える", () => {
    const html = placed("あ\n\nい", {
      illustrations: [{ ...illustration, afterParagraph: 1, caption: "出会い" }],
    }).html;

    expect(html).toContain("<figcaption>出会い</figcaption>");
    expect(html).toContain('alt="出会い"');
  });

  test("解説文が空なら figcaption を出さない", () => {
    const html = placed("あ\n\nい", {
      illustrations: [{ ...illustration, afterParagraph: 1 }],
    }).html;

    expect(html).toContain("<figure");
    expect(html).not.toContain("figcaption");
  });

  test("解説文と画像の場所も、XMLとして逃がす", () => {
    const html = placed("あ", {
      illustrations: [
        { afterParagraph: 1, href: "illust&1.png", caption: 'A & B <tag>' },
      ],
    }).html;

    expect(html).toContain("A &amp; B &lt;tag&gt;");
    expect(html).toContain('src="illust&amp;1.png"');
  });

  test("改ページは次の段落にクラスが付く", () => {
    const html = placed("あ\n\nい", { pageBreaks: [1] }).html;

    expect(html).toContain('<p class="page-break">い</p>');
    expect(html).toContain("<p>あ</p>");
  });

  test("話の末尾を指したら何も付かない（後ろに段落が無い）", () => {
    const result = placed("あ\n\nい", { pageBreaks: [2] });

    expect(result.html).not.toContain("page-break");
    expect(result.overflow).toEqual([]);
  });

  test("段落数を超えた挿絵は末尾に置き、超えたことを返す", () => {
    const result = placed("あ\n\nい", {
      illustrations: [{ ...illustration, afterParagraph: 9 }],
    });

    expect(result.paragraphCount).toBe(2);
    expect(result.overflow).toEqual([
      { kind: "illustration", afterParagraph: 9 },
    ]);
    // 黙って捨てない。末尾には入る
    expect(result.html.indexOf("<figure")).toBeGreaterThan(
      result.html.indexOf("<p>い</p>")
    );
  });

  test("段落数を超えた改ページも、超えたことを返す", () => {
    const result = placed("あ\n\nい", { pageBreaks: [9] });

    expect(result.overflow).toEqual([{ kind: "pageBreak", afterParagraph: 9 }]);
    expect(result.html).not.toContain("page-break");
  });

  test("超過の言い方は1か所で作る（書き出しと画面で食い違わせない）", () => {
    expect(
      describePlacementOverflow("第一話　出会い", {
        kind: "illustration",
        afterParagraph: 9,
      })
    ).toContain("第9段落");
    expect(
      describePlacementOverflow("第一話　出会い", {
        kind: "illustration",
        afterParagraph: 9,
      })
    ).toContain("第一話　出会い");
  });

  test("プレビューのときだけ、改ページの位置に印を置く", () => {
    // 画面は1枚の面なので実際には割れない。**見えないより印**（6.65.10）
    expect(
      placed("あ\n\nい", { pageBreaks: [1], markPageBreaks: true }).html
    ).toContain("ここで改ページ");
    // 本には入れない
    expect(placed("あ\n\nい", { pageBreaks: [1] }).html).not.toContain(
      "ここで改ページ"
    );
  });

  /**
   * 指し先の話が見つからない指定（設計書6.65.10）。
   *
   * **改題・移動で必ず起きる。** 位置の超過と同じで、黙って消さずに伝える
   * ——ただしこちらは末尾へ置くこともできない（入る先の話が無い）。
   */
  test("見つからない話の指定は、本に入らない", () => {
    const items = [
      { episodePath: "本文/第1話.txt", afterParagraph: 1 },
      { episodePath: "本文/第3話.txt", afterParagraph: 1 },
    ];

    expect(placementsIn(items, "本文/第1話.txt")).toHaveLength(1);
    // 改題された話を指しているものは、どの話にも選ばれない
    expect(placementsIn(items, "本文/第2話.txt")).toEqual([]);
  });

  test("見つからない話の挿絵・改ページは、パス付きで知らせる", () => {
    const notes = missingEpisodeNotices(["本文/第1話.txt"], {
      illustrations: [{ episodePath: "本文/第3話.txt" }],
      pageBreaks: [{ episodePath: "本文/第4話.txt" }],
    });

    expect(notes).toHaveLength(2);
    // 作者が「あれを改題したからだ」と辿れるよう、パスを出す
    expect(notes[0]).toContain("本文/第3話.txt");
    expect(notes[0]).toContain("挿絵");
    expect(notes[1]).toContain("本文/第4話.txt");
    expect(notes[1]).toContain("改ページ");
  });

  test("見つかる話については何も言わない", () => {
    expect(
      missingEpisodeNotices(["本文/第1話.txt", "本文/第2話.txt"], {
        illustrations: [{ episodePath: "本文/第1話.txt" }],
        pageBreaks: [{ episodePath: "本文/第2話.txt" }],
      })
    ).toEqual([]);
  });

  test("同じ話に何枚あっても、言うのは1度だけ", () => {
    // 同じ文が3つ並んでも、作者に伝わるものは増えない
    expect(
      missingEpisodeNotices([], {
        illustrations: [
          { episodePath: "本文/第3話.txt" },
          { episodePath: "本文/第3話.txt" },
        ],
        pageBreaks: [],
      })
    ).toHaveLength(1);
  });

  test("指定が無ければ、いままでと同じものが出る", () => {
    const bare = buildChapterFragment(
      { heading: "第一話", body: "あ\n\nい", notation: "curly" },
      { collapseBlankLines: true }
    );
    expect(bare).toBe(placed("あ\n\nい").html);
    expect(bare).not.toContain("figure");
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
