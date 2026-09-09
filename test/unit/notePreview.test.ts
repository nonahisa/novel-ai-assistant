import { describe, expect, it } from "vitest";
import {
  NOTE_UNSUPPORTED,
  renderNotePreview,
} from "../../src/core/notePreview";
import {
  NOTE_UNSUPPORTED as UNSUPPORTED_SOURCE,
  toNoteMarkdown,
} from "../../src/core/noteMarkdown";
import { toSiteNotation } from "../../src/core/ruby";

/**
 * 「noteに貼ったときの見た目」の描画（設計書6.69）。
 *
 * **ここで確かめるのは2つ。**
 *
 * 1. noteが持っている記法が、noteの形で出ること
 * 2. noteが持っていない記法に、必ず注意が付くこと（貼ってから崩れるのを防ぐ）
 */
describe("note風プレビュー", () => {
  /**
   * **noteの見出しは2段しかない**（大見出し＝`##`・小見出し＝`###`）。
   * 貼るときも同じ段へ丸めるので（`toNoteMarkdown`）、プレビューでも
   * `#` と `##` は同じ大きさで見せる——ここだけ3段に見せると、
   * 貼ってから「同じになった」と驚くことになる。
   */
  it("大見出しと小見出しを出し分ける（noteの2段に丸めて）", () => {
    const html = renderNotePreview("# 大きな見出し\n## 大見出し\n### 小さな見出し");
    expect(html).toContain("大きな見出し");
    expect(html).toContain("小さな見出し");
    // 大見出しは、この面でいちばん大きい `note-h1`（`#` と `##` は同じ段）
    expect([...html.matchAll(/note-h1/g)]).toHaveLength(2);
    // 小見出しは1つ下の段
    expect([...html.matchAll(/note-h2/g)]).toHaveLength(1);
  });

  it("`####` 以降も小見出しに丸める", () => {
    expect(renderNotePreview("#### 深い見出し")).toContain("note-h2");
  });

  it("太字を出す", () => {
    expect(renderNotePreview("これは**太字**です")).toContain(
      "<strong>太字</strong>"
    );
  });

  it("引用は1つのかたまりにまとめる", () => {
    const html = renderNotePreview("> 一行目\n> 二行目\n地の文");
    expect(html).toContain("note-quote");
    // 続く引用行は、引用符を2つ並べずに1つの中へ入れる
    expect([...html.matchAll(/note-quote/g)]).toHaveLength(1);
    expect(html).toContain("一行目<br>二行目");
  });

  it("区切り線を出す", () => {
    expect(renderNotePreview("前\n---\n後")).toContain("note-hr");
  });

  it("箇条書きと番号リストを出す", () => {
    const bullets = renderNotePreview("- ひとつ\n- ふたつ");
    expect(bullets).toContain("<ul");
    expect([...bullets.matchAll(/<li/g)]).toHaveLength(2);

    const numbers = renderNotePreview("1. ひとつ\n2. ふたつ");
    expect(numbers).toContain("<ol");
    expect([...numbers.matchAll(/<li/g)]).toHaveLength(2);
  });

  /**
   * リンクは `<a>` で出す（noteでリンクになることを字面で分からせる）。
   * **飛び先は持たせない**ので押しても開かない——プレビューは見るための面で、
   * 外のページを開く場所ではない。
   */
  it("リンクは<a>で出すが、飛び先は持たせない", () => {
    const html = renderNotePreview("[まえがき](https://example.com/a)");
    expect(html).toContain("note-link");
    expect(html).toContain("まえがき");
    expect(html).toContain("<a class=\"note-link\">");
    expect(html).not.toContain("href");
    expect(html).not.toContain("https://example.com/a");
  });

  /**
   * **ルビは括弧書き**（設計書6.68.3）。投稿キットのnote変換（`ruby.ts` の
   * `paren`）と同じ規則を使う。写しではないことを、変換関数の結果と
   * 突き合わせて確かめる。
   */
  it("ルビは括弧書きで出る（投稿キットと同じ規則）", () => {
    const html = renderNotePreview("{灯|あかり}が点る");
    expect(html).toContain("灯（あかり）が点る");
    expect(html).toContain(toSiteNotation("{灯|あかり}", "paren"));
    // 記法の記号がそのまま残らない
    expect(html).not.toContain("{灯");
  });

  it("読み仮名の無いルビは、親文字だけになる", () => {
    expect(renderNotePreview("{灯|}が点る")).toContain("灯が点る");
  });

  it("本文のHTMLは、そのまま効かせない", () => {
    const html = renderNotePreview("<script>alert(1)</script>");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  /** シーンメモは作者の付箋であって、noteへ貼るものではない（設計書6.40.2） */
  it("シーンメモの行は出さない", () => {
    const html = renderNotePreview("// あとで直す\n本文です");
    expect(html).not.toContain("あとで直す");
    expect(html).toContain("本文です");
  });
});

/**
 * noteに無い記法の印（設計書6.69）。
 *
 * **貼ってから崩れるのを防ぐ**のが目的なので、見逃しがいちばん困る。
 */
describe("noteに無い記法の印", () => {
  it("斜体には注意が付き、印そのものは外れる", () => {
    const html = renderNotePreview("これは*斜体*です");
    expect(html).toContain(NOTE_UNSUPPORTED.italic);
    expect(html).toContain("note-warn");
    // 印は外れて、字だけが残る
    expect(html).toContain("これは斜体です");
    expect(html).not.toContain("<em>");
  });

  it("表の行には注意が付く", () => {
    const html = renderNotePreview("| 名前 | 役 |\n| --- | --- |");
    expect(html).toContain(NOTE_UNSUPPORTED.table);
  });

  it("傍点には注意が付き、印は外れて字が残る", () => {
    const html = renderNotePreview("{{ここ}}が大事");
    expect(html).toContain(NOTE_UNSUPPORTED.emphasis);
    expect(html).toContain("ここが大事");
    expect(html).not.toContain("{{");
  });

  /** 太字（`**`）を斜体と読み違えない。誤検出は「うるさい」の原因になる */
  it("太字だけの行に、斜体の注意を出さない", () => {
    const html = renderNotePreview("**太字**だけの行");
    expect(html).not.toContain(NOTE_UNSUPPORTED.italic);
  });

  /** 箇条書きの `*` を斜体と読み違えない */
  it("箇条書きの行に、斜体の注意を出さない", () => {
    const html = renderNotePreview("* ひとつ\n* ふたつ");
    expect(html).not.toContain(NOTE_UNSUPPORTED.italic);
  });

  /** noteで出るものに、いちいち注意を出さない（書くのを邪魔しない） */
  it("ふつうの本文には、何も印を付けない", () => {
    const html = renderNotePreview("# 見出し\n本文です\n\n> 引用\n- 箇条書き");
    expect(html).not.toContain("note-warn");
  });
});

/**
 * 貼るときの整え（`toNoteMarkdown`）と**同じ読み方**であること
 * （設計書6.84）。読み方を2か所に持つと、プレビューでは正しく見えるのに
 * 貼ると崩れる、という食い違いが起きる。
 */
describe("貼ったときの形と、見た目を揃える", () => {
  /** 文言の写しを作らない（片方だけ直る日を作らない） */
  it("注意の文言は、貼るときの整えと同じものを使う", () => {
    expect(NOTE_UNSUPPORTED).toBe(UNSUPPORTED_SOURCE);
  });

  it("コードブロックは<pre>で出す（中身は変換しない）", () => {
    const source = "```js\n// 説明\nconst a = {x|y};\n```";
    const html = renderNotePreview(source);
    expect(html).toContain("<pre class=\"note-code\">");
    // ルビにもシーンメモにもしない（貼るときと同じ）
    expect(html).toContain("// 説明");
    expect(html).toContain("{x|y}");
    expect(toNoteMarkdown(source).body).toContain("{x|y}");
  });

  it("画像は【画像：…】の枠にして、入らないことの印を付ける", () => {
    const source = "![猫](画像/cat.png)";
    const html = renderNotePreview(source);
    expect(html).toContain("note-image");
    expect(html).toContain("【画像：猫（cat.png）】");
    expect(html).toContain(NOTE_UNSUPPORTED.image);
    // 貼る側も同じ目印になる
    expect(toNoteMarkdown(source).body).toContain("【画像：猫（cat.png）】");
  });

  /** **これは「できない」の印ではない。** 埋め込みになると分かる形で出す */
  it("URLだけの行は、埋め込みカードになると出す", () => {
    const source = "https://example.com/a";
    const html = renderNotePreview(source);
    expect(html).toContain("note-embed");
    expect(html).toContain("埋め込みカードになります");
    expect(html).toContain("https://example.com/a");
    // 印（※）は付けない。困りごとではない
    expect(html).not.toContain("note-warn");
    expect(toNoteMarkdown(source).embeds).toEqual(["https://example.com/a"]);
  });

  it("文の中のURLには、埋め込みにならない旨の印を付ける", () => {
    const html = renderNotePreview("詳しくは https://example.com/a を見て");
    expect(html).toContain(NOTE_UNSUPPORTED.inlineUrl);
  });

  it("引用の中の空行は、全角スペースの行として見せる（貼るときと同じ）", () => {
    const source = "> 一行目\n>\n> 三行目";
    expect(renderNotePreview(source)).toContain("一行目<br>　<br>三行目");
    expect(toNoteMarkdown(source).body).toBe("> 一行目\n> 　\n> 三行目");
  });

  /** コードの中の `//` は作者の付箋ではない（落とすとコードが壊れる） */
  it("シーンメモを落とすのは、コードの外だけ", () => {
    const html = renderNotePreview("// 付箋\n```js\n// 説明\n```");
    expect(html).not.toContain("付箋");
    expect(html).toContain("// 説明");
  });
});
