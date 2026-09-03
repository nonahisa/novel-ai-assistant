import { describe, expect, test } from "vitest";
import {
  applyTateChuYoko,
  buildChapterFragment,
  buildChapterPlacement,
  buildChapterXhtml,
  countParagraphs,
  describeDroppedPlacements,
  describeMissingIllustrationImage,
  describePlacementOverflow,
  escapeDisplayText,
  escapeXml,
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
  options?: {
    collapseBlankLines?: boolean;
    heading?: string;
    vertical?: boolean;
  }
): string {
  return buildChapterFragment(
    {
      heading: options?.heading ?? "第一話　出会い",
      body,
      notation: "curly",
    },
    {
      collapseBlankLines: options?.collapseBlankLines ?? true,
      vertical: options?.vertical,
    }
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

/**
 * 半角の縦中横（設計書6.65.15の2）。
 *
 * 縦書きの本文・見出しで、半角の数字・「!」「?」の1〜3文字の連続を
 * `<span class="tcy">` で包む。4文字以上は従来どおり横倒しのまま。
 */
describe("半角の縦中横", () => {
  test("1〜3文字の数字・!・?は tcy で包む", () => {
    expect(applyTateChuYoko("12")).toBe('<span class="tcy">12</span>');
    expect(applyTateChuYoko("!?")).toBe('<span class="tcy">!?</span>');
    expect(applyTateChuYoko("100")).toBe('<span class="tcy">100</span>');
  });

  test("4文字以上は包まない（横倒しのまま）", () => {
    expect(applyTateChuYoko("2026")).toBe("2026");
  });

  test("&amp; のような逃がし済みの文字は壊さない", () => {
    expect(applyTateChuYoko("A &amp; B")).toBe("A &amp; B");
  });

  /**
   * `&#39;` のような数値実体参照は、逃がされると `&amp;#39;` になる。
   * この中の「39」は実体参照の一部なので、桁数（2桁）だけでは
   * 3文字以下の判定に引っかかって包まれてしまう。**直前が `#` の数字は
   * 対象から外す**ことで、実体参照を壊さない（設計書6.65.15）。
   */
  test("数値実体参照の中の数字は包まない（&#39; など）", () => {
    const escaped = escapeXml("それは&#39;引用&#39;です");
    expect(escaped).toContain("&amp;#39;");
    expect(applyTateChuYoko(escaped)).not.toContain('<span class="tcy">39');
  });

  test("横書きでは包まない", () => {
    expect(escapeDisplayText("12", false)).toBe("12");
  });

  test("縦書きでは escapeDisplayText が escape と tcy を両方通す", () => {
    expect(escapeDisplayText("A & 12", true)).toBe(
      'A &amp; <span class="tcy">12</span>'
    );
  });

  test("本文の中の数字が縦書きの話でだけ tcy になる", () => {
    const vertical = fragment("西暦12年、戦が始まった", { vertical: true });
    const horizontal = fragment("西暦12年、戦が始まった", {
      vertical: false,
    });
    expect(vertical).toContain('<span class="tcy">12</span>');
    expect(horizontal).not.toContain('<span class="tcy">');
    expect(horizontal).toContain("西暦12年");
  });

  test("見出しの数字も、縦書きのときだけ tcy になる", () => {
    const vertical = fragment("本文", {
      heading: "第1話　出会い",
      vertical: true,
    });
    const horizontal = fragment("本文", {
      heading: "第1話　出会い",
      vertical: false,
    });
    expect(vertical).toContain(
      '<h2 class="chapter-heading">第<span class="tcy">1</span>話　出会い</h2>'
    );
    expect(horizontal).toContain(
      '<h2 class="chapter-heading">第1話　出会い</h2>'
    );
  });

  test("解説文の数字も、縦書きのときだけ tcy になる", () => {
    const html = buildChapterPlacement(
      { heading: "第一話", body: "あ", notation: "curly" },
      {
        collapseBlankLines: true,
        vertical: true,
        illustrations: [
          { afterParagraph: 1, href: "illust-1.png", caption: "その1枚" },
        ],
      }
    ).html;
    expect(html).toContain(
      '<figcaption>その<span class="tcy">1</span>枚</figcaption>'
    );
    // alt は属性値なので span を差し込まない
    expect(html).toContain('alt="その1枚"');
  });
});

/**
 * XMLに書けない制御文字（設計書6.65.4）。
 *
 * XML 1.0 は U+0009・U+000A・U+000D 以外のC0制御文字を**文書のどこにも
 * 置けない**と定めている（実体参照にしても駄目）。変換ソフトが混ぜた
 * フォームフィード1文字で本ごと開けなくなるので、**逃がしの入口で落とす**。
 *
 * **生の制御文字はソースへ置かない**（CLAUDE.mdの約束。gitやgrepがバイナリ
 * 扱いする）。ここでは文字番号から作る——エスケープの書き方を間違えて
 * 生の1バイトが紛れ込む事故そのものを避けられる。
 */
describe("制御文字を落とす", () => {
  /** フォームフィード。変換ソフトが混ぜる代表格 */
  const formFeed = String.fromCharCode(0x0c);
  const nul = String.fromCharCode(0x00);
  const backspace = String.fromCharCode(0x08);
  const unitSeparator = String.fromCharCode(0x1f);

  /** XMLに書けない制御文字が残っていないか */
  function hasForbidden(text: string): boolean {
    return [...text].some((char) => {
      const code = char.charCodeAt(0);
      return code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d;
    });
  }

  test("フォームフィードやNULは、逃がしの入口で消える", () => {
    expect(escapeXml(`あ${formFeed}い`)).toBe("あい");
    expect(escapeXml(`あ${nul}い${backspace}う${unitSeparator}え`)).toBe(
      "あいうえ"
    );
  });

  test("置換ではなく除去する（見えない字を別の字に化けさせない）", () => {
    expect(escapeXml(`あ${formFeed}い`)).toHaveLength(2);
  });

  test("タブ・改行・復帰は残す（XMLで書いてよい3つ）", () => {
    expect(escapeXml("あ\tい\nう\rえ")).toBe("あ\tい\nう\rえ");
  });

  test("逃がしそのものは、いままでどおり効く", () => {
    expect(escapeXml('A & B <tag> "引用"')).toBe(
      "A &amp; B &lt;tag&gt; &quot;引用&quot;"
    );
  });

  test("本文にも見出しにも効く（入口が1つだから）", () => {
    const html = fragment(`あ${formFeed}い`, {
      heading: `第一話${nul}　出会い`,
    });

    expect(html).toContain("<p>あい</p>");
    expect(html).toContain("第一話　出会い");
    expect(hasForbidden(html)).toBe(false);
  });

  test("解説文と画像の場所にも効く", () => {
    const html = buildChapterPlacement(
      { heading: "第一話", body: "あ", notation: "curly" },
      {
        collapseBlankLines: true,
        illustrations: [
          {
            afterParagraph: 1,
            href: `illust${formFeed}1.png`,
            caption: `出会い${formFeed}の場面`,
          },
        ],
      }
    ).html;

    expect(html).toContain('src="illust1.png"');
    expect(html).toContain("<figcaption>出会いの場面</figcaption>");
    expect(hasForbidden(html)).toBe(false);
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

  /**
   * 改ページの直前の空行（設計書6.65.10）。
   *
   * **改ページそのものが場面の区切り**なので、空きの段落は要らない。
   * 残すと、前の面の末尾に空白だけの行が積まれる（読者からは「本文が
   * 終わったのに白紙が続く」ように見える）。
   */
  test("改ページの位置では、直前の空行を出さない", () => {
    const result = placed("あ\n\n\n\nい", {
      pageBreaks: [1],
      collapseBlankLines: false,
    });

    expect(result.html).not.toContain('class="blank"');
    expect(result.html).toContain('<p class="page-break">い</p>');
  });

  test("詰める設定に関わらず、空行は残らない", () => {
    for (const collapseBlankLines of [true, false]) {
      const html = placed("あ\n\n\n\n\nい", {
        pageBreaks: [1],
        collapseBlankLines,
      }).html;
      expect(html).not.toContain('class="blank"');
    }
  });

  test("改ページの無いところの空行は、いままでどおり残る", () => {
    // 直したのは「改ページの位置」だけである
    const html = placed("あ\n\n\nい\n\n\nう", {
      pageBreaks: [2],
      collapseBlankLines: false,
    }).html;

    // 1段落目と2段落目のあいだの空きは残り、改ページの前の空きだけが消える
    expect([...html.matchAll(/<p class="blank">/g)]).toHaveLength(2);
    expect(html).toContain('<p class="page-break">う</p>');
  });

  test("プレビューの印も、空行を挟まず段落の直後に出る", () => {
    const html = placed("あ\n\n\nい", {
      pageBreaks: [1],
      collapseBlankLines: false,
      markPageBreaks: true,
    }).html;

    expect(html).toContain(
      '<p>あ</p>\n<div class="page-break-mark"><span>ここで改ページ</span></div>\n<p class="page-break">い</p>'
    );
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

/**
 * 画像が見つからない挿絵（設計書6.65.10）。
 *
 * **画面でも書き出しでも「本に入らない」ことは同じ**なので、言い方を
 * 1か所に置く。位置の超過（末尾には入る）と違い、こちらは1枚まるごと
 * 入らない。
 */
describe("読めない挿絵の言い方", () => {
  test("どのパスが読めないのかを出す", () => {
    const note = describeMissingIllustrationImage("素材/挿絵1.png");

    expect(note).toContain("素材/挿絵1.png");
    expect(note).toContain("本に入りません");
  });
});

/**
 * 競合で本から外れた話に置かれていた指定（設計書6.65.10）。
 *
 * 競合マーカーのある話は本に入らない。**その話に付けた挿絵・改ページも
 * 一緒に消える**ので、消えたことを言う（黙って捨てない）。
 */
describe("競合で外れた話の指定", () => {
  test("挿絵と改ページの件数を、話の名前と一緒に伝える", () => {
    const note = describeDroppedPlacements("第三話　再会", {
      illustrations: 2,
      pageBreaks: 1,
    });

    expect(note).toContain("第三話　再会");
    expect(note).toContain("挿絵2件");
    expect(note).toContain("改ページ1件");
  });

  test("片方だけなら、片方だけを言う", () => {
    const note = describeDroppedPlacements("第三話", {
      illustrations: 0,
      pageBreaks: 3,
    });

    expect(note).toContain("改ページ3件");
    expect(note).not.toContain("挿絵");
  });

  test("指定が無ければ何も言わない（外れたことは別の文が伝える）", () => {
    expect(
      describeDroppedPlacements("第三話", { illustrations: 0, pageBreaks: 0 })
    ).toBeNull();
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
