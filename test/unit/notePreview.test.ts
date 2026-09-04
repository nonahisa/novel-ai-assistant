import { describe, expect, it } from "vitest";
import {
  NOTE_UNSUPPORTED,
  renderNotePreview,
} from "../../src/core/notePreview";
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
  it("大見出しと小見出しを出し分ける", () => {
    const html = renderNotePreview("# 大きな見出し\n## 小さな見出し");
    expect(html).toContain("note-h1");
    expect(html).toContain("大きな見出し");
    expect(html).toContain("note-h2");
    expect(html).toContain("小さな見出し");
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

  /** リンクは下線だけ。**押しても開かない**（プレビューは見るためのもの） */
  it("リンクは下線だけで、飛び先を持たせない", () => {
    const html = renderNotePreview("[まえがき](https://example.com/a)");
    expect(html).toContain("note-link");
    expect(html).toContain("まえがき");
    expect(html).not.toContain("<a ");
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
