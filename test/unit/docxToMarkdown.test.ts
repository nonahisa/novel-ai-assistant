import { describe, expect, test } from "vitest";
import { zipSync } from "fflate";
import { docxToMarkdown } from "../../src/core/docxToMarkdown";

/**
 * Word（.docx）の本文を Markdown にする（設計書6.85）。
 *
 * **作り物の .docx を、その場で組んで読ませる。** 変換だけを別に組み直すと
 * 「ZIPを開いて XML を走査する」という、いちばん壊れやすいところを
 * 素通りしたテストになる。`[Content_Types].xml` は入れない——読むのは
 * `word/document.xml` だけなので、**それだけで読めること**も一緒に見る。
 */

const encoder = new TextEncoder();

/** 本文の XML から .docx のバイト列を組む */
function docx(documentXml: string): Uint8Array {
  return zipSync({ "word/document.xml": encoder.encode(documentXml) });
}

/** 書式表つきの .docx（日本語版 Word のように styleId が機械名のもの） */
function docxWithStyles(documentXml: string, stylesXml: string): Uint8Array {
  return zipSync({
    "word/document.xml": encoder.encode(documentXml),
    "word/styles.xml": encoder.encode(stylesXml),
  });
}

/** `<w:body>` の中身だけを渡して、文書1つぶんの XML にする */
function body(inner: string): string {
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    `<w:body>${inner}</w:body></w:document>`
  );
}

/** 文字だけの run */
function run(text: string): string {
  return `<w:r><w:t>${text}</w:t></w:r>`;
}

/** 傍点（`w:em w:val="dot"`）の付いた run */
function dotted(text: string): string {
  return `<w:r><w:rPr><w:em w:val="dot"/></w:rPr><w:t>${text}</w:t></w:r>`;
}

/** ルビ。読み（`w:rt`）が先、親文字（`w:rubyBase`）が後という Word の並び */
function ruby(base: string, reading: string): string {
  return (
    "<w:r><w:ruby><w:rubyPr><w:rubyAlign w:val=\"center\"/></w:rubyPr>" +
    `<w:rt>${run(reading)}</w:rt>` +
    `<w:rubyBase>${run(base)}</w:rubyBase>` +
    "</w:ruby></w:r>"
  );
}

/** 変換して Markdown だけを取り出す */
function markdownOf(inner: string): string {
  return docxToMarkdown(docx(body(inner))).markdown;
}

describe("ルビ（設計書6.85）", () => {
  test("ルビは {親文字|よみ} で保存する", () => {
    const result = docxToMarkdown(
      docx(body(`<w:p>${run("次の")}${ruby("漢字", "かんじ")}${run("です")}</w:p>`))
    );

    expect(result.markdown).toBe("次の{漢字|かんじ}です\n");
    expect(result.rubyCount).toBe(1);
  });

  test("読みが空のルビは、親文字だけを残す", () => {
    // **本文を落とさない。** 読みが無いだけで親文字まで消えては原稿が減る
    const result = docxToMarkdown(
      docx(body(`<w:p>${ruby("漢字", "")}</w:p>`))
    );

    expect(result.markdown).toBe("漢字\n");
    expect(result.rubyCount).toBe(0);
  });
});

describe("傍点（設計書6.85）", () => {
  test("傍点の run は {{文字}} になる", () => {
    const result = docxToMarkdown(
      docx(body(`<w:p>${run("これは")}${dotted("大事")}${run("です")}</w:p>`))
    );

    expect(result.markdown).toBe("これは{{大事}}です\n");
    expect(result.emphasisCount).toBe(1);
  });

  test("続いた傍点の run は1つにまとめる", () => {
    // Word は書式が同じでも run を割る（校閲・言語の印などで切れる）。
    // 割れたまま出すと {{大}}{{事}} になり、投稿サイトへ出したときに
    // 傍点が2つの塊に見える
    const result = docxToMarkdown(
      docx(body(`<w:p>${dotted("大")}${dotted("事")}${run("です")}</w:p>`))
    );

    expect(result.markdown).toBe("{{大事}}です\n");
    expect(result.emphasisCount).toBe(1);
  });

  test("圏点は dot 以外（comma・circle・underDot）も傍点として持ち帰る", () => {
    // 日本語の原稿では「、」の圏点もよく使われる。種類ごとの印は
    // {{ }} ひとつしか無いが、**落ちた傍点は取り戻せない**
    const inner =
      "<w:p>" +
      '<w:r><w:rPr><w:em w:val="comma"/></w:rPr><w:t>あ</w:t></w:r>' +
      '<w:r><w:rPr><w:em w:val="circle"/></w:rPr><w:t>い</w:t></w:r>' +
      "<w:r><w:t>と</w:t></w:r>" +
      '<w:r><w:rPr><w:em w:val="underDot"/></w:rPr><w:t>う</w:t></w:r>' +
      '<w:r><w:rPr><w:em w:val="none"/></w:rPr><w:t>え</w:t></w:r>' +
      "</w:p>";
    const result = docxToMarkdown(docx(body(inner)));

    expect(result.markdown).toBe("{{あい}}と{{う}}え\n");
    expect(result.emphasisCount).toBe(2);
  });

  test("段落の書式の w:rPr（w:pPr の中）は傍点にしない", () => {
    // `w:pPr` の中の `w:rPr` は**段落記号の書式**であって、本文ではない
    const result = docxToMarkdown(
      docx(
        body(
          `<w:p><w:pPr><w:rPr><w:em w:val="dot"/></w:rPr></w:pPr>${run("ふつう")}</w:p>`
        )
      )
    );

    expect(result.markdown).toBe("ふつう\n");
    expect(result.emphasisCount).toBe(0);
  });
});

describe("段落と見出し（設計書6.85）", () => {
  test("段落は1行。あいだに空行を入れない", () => {
    // 小説の原稿は段落ごとに改行する。空行を挟むと、こちらが
    // 書いていない「1行あけ」を原稿へ足すことになる
    expect(markdownOf(`<w:p>${run("あ")}</w:p><w:p>${run("い")}</w:p>`)).toBe(
      "あ\nい\n"
    );
  });

  test("空の段落は空行として残す", () => {
    expect(
      markdownOf(`<w:p>${run("あ")}</w:p><w:p/><w:p>${run("い")}</w:p>`)
    ).toBe("あ\n\nい\n");
  });

  test("見出しは # 〜 ### になる", () => {
    const inner =
      `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr>${run("第一章")}</w:p>` +
      `<w:p><w:pPr><w:pStyle w:val="Heading3"/></w:pPr>${run("小見出し")}</w:p>`;

    expect(markdownOf(inner)).toBe("# 第一章\n### 小見出し\n");
  });

  test("日本語版 Word の機械名の styleId でも、書式表から見出しを引く", () => {
    // 日本語版 Word の styleId は `a3` や `1` のような機械名になる。
    // 人が読む名前（w:name の「heading 1」）は書式表にしか書いていない
    const styles =
      '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      '<w:style w:type="paragraph" w:styleId="a3"><w:name w:val="heading 1"/></w:style>' +
      '<w:style w:type="paragraph" w:styleId="a5"><w:name w:val="heading 2"/></w:style>' +
      '<w:style w:type="paragraph" w:styleId="a7"><w:name w:val="Body Text"/></w:style>' +
      "</w:styles>";
    const inner =
      `<w:p><w:pPr><w:pStyle w:val="a3"/></w:pPr>${run("第一章")}</w:p>` +
      `<w:p><w:pPr><w:pStyle w:val="a5"/></w:pPr>${run("節")}</w:p>` +
      `<w:p><w:pPr><w:pStyle w:val="a7"/></w:pPr>${run("地の文")}</w:p>`;

    expect(docxToMarkdown(docxWithStyles(body(inner), styles)).markdown).toBe(
      "# 第一章\n## 節\n地の文\n"
    );
  });

  test("w:br は改行、w:tab は全角空白1つ", () => {
    expect(
      markdownOf(`<w:p>${run("上")}<w:br/>${run("下")}<w:tab/>${run("字下げ")}</w:p>`)
    ).toBe("上\n下　字下げ\n");
  });
});

describe("文字の取り出し（設計書6.85）", () => {
  test('xml:space="preserve" の空白はそのまま残す', () => {
    expect(
      markdownOf(
        `<w:p><w:r><w:t xml:space="preserve">　　あ </w:t></w:r>${run("い")}</w:p>`
      )
    ).toBe("　　あ い\n");
  });

  test("印の無い w:t の前後の空白は落とす（Word の決まり）", () => {
    expect(
      markdownOf(`<w:p><w:r><w:t>  あ  </w:t></w:r></w:p>`)
    ).toBe("あ\n");
  });

  test("XMLの実体参照を文字へ戻す", () => {
    expect(
      markdownOf(`<w:p>${run("&lt;&amp;&gt;&quot;&apos;&#x3042;&#12356;")}</w:p>`)
    ).toBe("<&>\"'あい\n");
  });

  test("フィールドコード（w:instrText）と削除跡（w:delText）は本文にしない", () => {
    const inner =
      "<w:p>" +
      run("あ") +
      '<w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r>' +
      "<w:del><w:r><w:delText>消した文</w:delText></w:r></w:del>" +
      run("い") +
      "</w:p>";

    expect(markdownOf(inner)).toBe("あい\n");
  });
});

describe("落とすもの（設計書6.85）", () => {
  test("画像は入らず、件数で伝える", () => {
    const result = docxToMarkdown(
      docx(
        body(
          `<w:p>${run("前")}<w:r><w:drawing><wp:inline><a:blip/></wp:inline></w:drawing></w:r>${run("後")}</w:p>`
        )
      )
    );

    expect(result.markdown).toBe("前後\n");
    expect(result.skipped.join("\n")).toContain("画像 1件");
  });

  test("画像の中のテキストボックスの文字も持ち込まない", () => {
    // 図形の中の文字を本文へ混ぜると、地の文の途中に説明文が割り込む
    const result = docxToMarkdown(
      docx(
        body(
          `<w:p>${run("本文")}<w:r><w:drawing><wps:txbx><w:txbxContent><w:p>${run(
            "図の中"
          )}</w:p></w:txbxContent></wps:txbx></w:drawing></w:r></w:p>`
        )
      )
    );

    expect(result.markdown).toBe("本文\n");
  });

  test("新旧2つの形で書かれた図形は、1件として数える", () => {
    // Word は図形を mc:AlternateContent で包み、新しい形（w:drawing）と
    // 古い形（w:pict）を両方書く。中だけを見ると1枚の絵が2件になる
    const inner =
      `<w:p>${run("本文")}<w:r><mc:AlternateContent>` +
      "<mc:Choice Requires=\"wps\"><w:drawing><wp:inline/></w:drawing></mc:Choice>" +
      "<mc:Fallback><w:pict><v:shape/></w:pict></mc:Fallback>" +
      "</mc:AlternateContent></w:r></w:p>";
    const result = docxToMarkdown(docx(body(inner)));

    expect(result.markdown).toBe("本文\n");
    expect(result.skipped.join("\n")).toContain("画像 1件");
  });

  test("表は行ごとの文字にほどき、件数で伝える", () => {
    const cell = (text: string): string =>
      `<w:tc><w:p>${run(text)}</w:p></w:tc>`;
    const table =
      "<w:tbl>" +
      `<w:tr>${cell("名前")}${cell("年齢")}</w:tr>` +
      `<w:tr>${cell("あかり")}${cell("17")}</w:tr>` +
      "</w:tbl>";

    const result = docxToMarkdown(docx(body(`${table}<w:p>${run("あと")}</w:p>`)));

    expect(result.markdown).toBe(
      "名前　年齢\nあかり　17\nあと\n"
    );
    expect(result.skipped.join("\n")).toContain("表 1件");
  });

  test("脚注とコメントは落として数える", () => {
    const inner =
      `<w:p>${run("本文")}<w:r><w:footnoteReference w:id="2"/></w:r>` +
      '<w:commentRangeStart w:id="0"/><w:r><w:commentReference w:id="0"/></w:r></w:p>';
    const result = docxToMarkdown(docx(body(inner)));

    expect(result.markdown).toBe("本文\n");
    expect(result.skipped.join("\n")).toContain("脚注 1件");
    expect(result.skipped.join("\n")).toContain("コメント 1件");
  });

  test("太字・斜体は落とし、数えもしない（本文の文字だけ残す）", () => {
    const inner =
      `<w:p><w:r><w:rPr><w:b/><w:i/><w:color w:val="FF0000"/></w:rPr><w:t>強い</w:t></w:r></w:p>`;
    const result = docxToMarkdown(docx(body(inner)));

    expect(result.markdown).toBe("強い\n");
    expect(result.skipped).toEqual([]);
  });
});

describe("記法との紛れ（設計書6.85）", () => {
  test("本文に { } | があれば、1回だけ知らせる（本文は変えない）", () => {
    const inner =
      `<w:p>${run("式は {a|b} と書く")}</w:p><w:p>${run("もう一度 {c}")}</w:p>`;
    const result = docxToMarkdown(docx(body(inner)));

    expect(result.markdown).toBe("式は {a|b} と書く\nもう一度 {c}\n");
    const notes = result.skipped.filter((note) => note.includes("{"));
    expect(notes).toHaveLength(1);
  });

  test("記法の印そのものは、紛れの知らせを出さない", () => {
    const result = docxToMarkdown(
      docx(body(`<w:p>${ruby("漢字", "かんじ")}${dotted("大事")}</w:p>`))
    );

    expect(result.skipped).toEqual([]);
  });
});

describe("読めないファイル（設計書6.85）", () => {
  test("word/document.xml が無ければ、Wordの文書ではないと断る", () => {
    const notWord = zipSync({ "mimetype": encoder.encode("text/plain") });

    expect(() => docxToMarkdown(notWord)).toThrow(/Word/);
  });

  test("ZIPですらないものは、理由が分かる言葉で断る", () => {
    expect(() => docxToMarkdown(encoder.encode("これはZIPではありません"))).toThrow(
      /Word/
    );
  });
});

describe("字下げと全角空白（設計書6.85）", () => {
  test("段落頭の全角空白（字下げ）は残す", () => {
    // Word は全角空白だけの w:t に xml:space="preserve" を付けない
    // （XMLの空白ではないため）。JS の trim() は U+3000 も落とすので、
    // そのまま使うと**日本語の小説の全段落から字下げが消える**
    expect(markdownOf(`<w:p>${run("　春が来た")}</w:p>`)).toBe("　春が来た\n");
  });

  test("文中の全角空白も残す（「あ　い」が「あい」にならない）", () => {
    expect(markdownOf(`<w:p>${run("あ　い")}</w:p>`)).toBe("あ　い\n");
  });

  test("全角空白だけの run も落とさない", () => {
    expect(markdownOf(`<w:p>${run("　")}${run("あ")}</w:p>`)).toBe("　あ\n");
  });

  test("XMLの空白（半角空白・改行）だけは、印が無ければ落とす", () => {
    // 折り返しの名残が本文へ混ざらないようにする（OOXML の決まり）
    expect(markdownOf(`<w:p><w:r><w:t>\n  あ  \n</w:t></w:r></w:p>`)).toBe("あ\n");
  });
});

describe("改行と改ページ（設計書6.85）", () => {
  test("w:cr も改行にする", () => {
    // w:br と w:cr は同じ「改行」。片方だけ見ていると改行が落ちる
    expect(markdownOf(`<w:p>${run("上")}<w:cr/>${run("下")}</w:p>`)).toBe(
      "上\n下\n"
    );
  });

  test('改ページ（w:br w:type="page"）は改行を足さない', () => {
    expect(
      markdownOf(`<w:p>${run("前")}<w:br w:type="page"/>${run("後")}</w:p>`)
    ).toBe("前後\n");
  });

  test("改行だけの段落で終わっても、末尾に空行を重ねない", () => {
    expect(markdownOf(`<w:p>${run("本文")}</w:p><w:p><w:br/></w:p>`)).toBe(
      "本文\n"
    );
  });
});

describe("入れ替えの箱（mc:AlternateContent。設計書6.85）", () => {
  test("mc:Choice の本文は残す（箱ごと落とすと本文が消える）", () => {
    const inner =
      `<w:p>${run("前")}<mc:AlternateContent>` +
      `<mc:Choice Requires="wps">${run("新しい形の本文")}</mc:Choice>` +
      `<mc:Fallback>${run("古い形の本文")}</mc:Fallback>` +
      `</mc:AlternateContent>${run("後")}</w:p>`;

    expect(markdownOf(inner)).toBe("前新しい形の本文後\n");
  });
});

describe("見出しの継承（設計書6.85）", () => {
  test("w:basedOn を1段たどって見出しにする", () => {
    // 作者が「My Chapter」のような自前の書式を作っても、Heading1 を
    // 継いでいれば見出しである
    const styles =
      '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      '<w:style w:type="paragraph" w:styleId="MyChapter">' +
      '<w:name w:val="My Chapter"/><w:basedOn w:val="Heading1"/></w:style>' +
      '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style>' +
      "</w:styles>";
    const inner = `<w:p><w:pPr><w:pStyle w:val="MyChapter"/></w:pPr>${run("第一章")}</w:p>`;

    expect(docxToMarkdown(docxWithStyles(body(inner), styles)).markdown).toBe(
      "# 第一章\n"
    );
  });

  test("見出しでない書式を継いでも、見出しにはしない", () => {
    const styles =
      '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      '<w:style w:type="paragraph" w:styleId="MyBody">' +
      '<w:name w:val="My Body"/><w:basedOn w:val="Normal"/></w:style>' +
      "</w:styles>";
    const inner = `<w:p><w:pPr><w:pStyle w:val="MyBody"/></w:pPr>${run("地の文")}</w:p>`;

    expect(docxToMarkdown(docxWithStyles(body(inner), styles)).markdown).toBe(
      "地の文\n"
    );
  });

  test("見出し4以下は地の文にして、そのことを伝える", () => {
    const inner =
      `<w:p><w:pPr><w:pStyle w:val="Heading4"/></w:pPr>${run("細かい見出し")}</w:p>` +
      `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr>${run("第一章")}</w:p>`;
    const result = docxToMarkdown(docx(body(inner)));

    expect(result.markdown).toBe("細かい見出し\n# 第一章\n");
    expect(result.skipped.join("\n")).toContain(
      "見出し4以下は地の文にしました 1段落"
    );
  });
});

describe("表の畳み方（設計書6.85）", () => {
  test("セルの中の改行は全角空白に畳む（表の1行が割れない）", () => {
    const table =
      "<w:tbl><w:tr>" +
      `<w:tc><w:p>${run("上")}<w:br/>${run("下")}</w:p></w:tc>` +
      `<w:tc><w:p>${run("右")}</w:p></w:tc>` +
      "</w:tr></w:tbl>";

    expect(markdownOf(table)).toBe("上　下　右\n");
  });
});

describe("本文が取れないとき（設計書6.85）", () => {
  test("本文の文字が1つも取れなければ、空の .md を作らずに断る", () => {
    // テキストボックスの中の文字しか無い文書。読めた気になって0字の
    // .md を作ると、作者は「変換しました」を信じて元を消しかねない
    const inner =
      `<w:p><w:r><w:drawing><wps:txbx><w:txbxContent><w:p>${run(
        "図の中"
      )}</w:p></w:txbxContent></wps:txbx></w:drawing></w:r></w:p>`;

    expect(() => docxToMarkdown(docx(body(inner)))).toThrow(
      /テキストボックス/
    );
  });
});
