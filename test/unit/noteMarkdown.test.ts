import { describe, expect, it } from "vitest";
import {
  NOTE_UNSUPPORTED,
  noteHeadingLevel,
  toNoteMarkdown,
} from "../../src/core/noteMarkdown";
import { toSiteNotation } from "../../src/core/ruby";

/**
 * note へ貼るための整え（設計書6.84）。
 *
 * **noteのエディタは、Markdownのプレーンテキストを貼るだけで解釈する。**
 * だから変換の役目は「別の記法へ直す」ことではなく、**noteが解釈できる
 * 形へ整え、解釈できないものの居場所を作者に知らせる**ことである。
 *
 * ここで確かめるのは3つ。
 *
 * 1. noteが解釈するもの（見出し・太字・リンク・コード・引用・リスト）が、
 *    貼れる形で出ること
 * 2. noteが**貼り付けでは受け取らないもの**（題名・画像・表）が、
 *    黙って消えず、位置と件数で分かること
 * 3. 埋め込み（URL1つだけの段落）が、埋め込みになる形で並ぶこと
 */

describe("見出し", () => {
  it("noteの見出しは2段なので、`#` は大見出し（`##`）へ丸める", () => {
    // 2行目以降の `#` は題名ではないので、本文の見出しとして残る
    const result = toNoteMarkdown("本文\n# 見出し");
    expect(result.body).toContain("## 見出し");
    expect(result.body).not.toContain("\n# 見出し");
  });

  it("`####` 以降は小見出し（`###`）へ丸める", () => {
    const result = toNoteMarkdown("本文\n#### 深い見出し\n##### もっと深い");
    expect(result.body).toContain("### 深い見出し");
    expect(result.body).toContain("### もっと深い");
  });

  it("段の丸め方は関数1つで決まる（写しを作らない）", () => {
    expect(noteHeadingLevel(1)).toBe(2);
    expect(noteHeadingLevel(2)).toBe(2);
    expect(noteHeadingLevel(3)).toBe(3);
    expect(noteHeadingLevel(6)).toBe(3);
  });
});

/**
 * **題名はコピペでは入らない**（noteの題名欄に手で入れる）。
 * 本文に残したままにすると、題名が二重に出る。
 */
describe("題名", () => {
  it("先頭の `# 題名` は本文から外して、題名として返す", () => {
    const result = toNoteMarkdown("# はじめての記事\n\n本文です。");
    expect(result.title).toBe("はじめての記事");
    expect(result.body).toBe("本文です。");
  });

  it("題名の中の記法は落として、そのまま題名欄へ入れられる形にする", () => {
    const result = toNoteMarkdown("# **{灯|あかり}**の記事\n\n本文");
    expect(result.title).toBe("灯（あかり）の記事");
  });

  it("先頭が `##` なら題名ではない（本文の見出しとして残す）", () => {
    const result = toNoteMarkdown("## 見出し\n\n本文");
    expect(result.title).toBeUndefined();
    expect(result.body).toContain("## 見出し");
  });
});

describe("引用", () => {
  /**
   * **noteの引用は、中に空行を置けない。** 空行でいったん引用が切れて、
   * 縦線が2本に分かれる。全角スペースの行で代用する。
   */
  it("引用の中の空行は、全角スペースの行にする", () => {
    const result = toNoteMarkdown("> 一行目\n>\n> 三行目");
    expect(result.body).toBe("> 一行目\n> 　\n> 三行目");
  });

  it("引用のあいだの空行も、引用の中として繋ぐ", () => {
    const result = toNoteMarkdown("> 一行目\n\n> 三行目");
    expect(result.body).toBe("> 一行目\n> 　\n> 三行目");
  });
});

describe("埋め込み（URLだけの段落）", () => {
  it("URLだけの行は、前後を空行で挟んで独立させる", () => {
    const result = toNoteMarkdown("前の文\nhttps://example.com/a\n後の文");
    expect(result.body).toBe(
      "前の文\n\nhttps://example.com/a\n\n後の文"
    );
    expect(result.embeds).toEqual(["https://example.com/a"]);
  });

  it("URLが続くときは、1つずつ空行で分ける", () => {
    const result = toNoteMarkdown(
      "https://example.com/a\nhttps://example.com/b"
    );
    expect(result.body).toBe(
      "https://example.com/a\n\nhttps://example.com/b"
    );
    expect(result.embeds).toHaveLength(2);
  });

  /** 文の中のURLは埋め込みにならない。**黙って落とさず、理由を出す** */
  it("文の中のURLは、そのままにして注意を出す", () => {
    const result = toNoteMarkdown("詳しくは https://example.com/a を見てください");
    expect(result.body).toContain("https://example.com/a");
    expect(result.embeds).toHaveLength(0);
    expect(result.warnings).toContain(NOTE_UNSUPPORTED.inlineUrl);
  });
});

describe("画像", () => {
  /**
   * **画像は貼り付けでは入らない**（noteへアップロードする）。
   * 消してしまうと、どこに入れるつもりだったのかが分からなくなるので、
   * 目印の行に置き換えて位置を残す。
   */
  it("画像は【画像：…】の行に置き換えて、位置を覚えておく", () => {
    const result = toNoteMarkdown("本文\n\n![猫](画像/cat.png)\n\n続き");
    expect(result.body).toContain("【画像：猫（cat.png）】");
    expect(result.body).not.toContain("![猫]");
    expect(result.images).toHaveLength(1);
    expect(result.images[0].alt).toBe("猫");
    expect(result.images[0].path).toBe("画像/cat.png");
    // 目印が何行目にあるか（作者がその場所へアップロードするため）
    expect(result.body.split("\n")[result.images[0].line - 1]).toContain(
      "【画像："
    );
  });

  it("説明の無い画像は、ファイル名だけの目印にする", () => {
    const result = toNoteMarkdown("![](images/a.png)");
    expect(result.body).toBe("【画像：a.png】");
  });

  it("文の中の画像も、目印にして数える", () => {
    const result = toNoteMarkdown("これ→![図](fig.png)←です");
    expect(result.body).toContain("【画像：図（fig.png）】");
    expect(result.images).toHaveLength(1);
  });
});

describe("コードブロック", () => {
  it("言語名を残したまま、そのまま通す", () => {
    const result = toNoteMarkdown("```js\nconst a = 1;\n```");
    expect(result.body).toBe("```js\nconst a = 1;\n```");
  });

  /**
   * **中身の変換をしない。** コードの中の `{a|b}` はルビではないし、
   * 行頭の `//` はシーンメモではない。落とすとコードが壊れる
   */
  it("中身は変換しない（ルビにも、シーンメモにもしない）", () => {
    const result = toNoteMarkdown("```js\n// 説明\nconst a = {x|y};\n```");
    expect(result.body).toContain("// 説明");
    expect(result.body).toContain("{x|y}");
  });

  it("中に ``` を含むときは、4つのバッククォートで囲む", () => {
    const result = toNoteMarkdown("````md\n```js\nconst a = 1;\n```\n````");
    expect(result.body.split("\n")[0]).toBe("````md");
    expect(result.body.split("\n").at(-1)).toBe("````");
    expect(result.body).toContain("```js");
  });

  it("`~~~` の囲みは、noteが読むバッククォートへ揃える", () => {
    const result = toNoteMarkdown("~~~python\nprint(1)\n~~~");
    expect(result.body).toBe("```python\nprint(1)\n```");
  });
});

describe("そのまま通すもの", () => {
  it("太字・取り消し線・リンク・区切り線・リストは書き換えない", () => {
    const source = [
      "**太字**と~~取り消し~~と[リンク](https://example.com/a)",
      "",
      "---",
      "",
      "- ひとつ",
      "  - 入れ子",
      "1. 番号",
    ].join("\n");
    // リンクの行は「文の中のURL」ではないので、注意も出さない
    const result = toNoteMarkdown(source);
    expect(result.body).toBe(source);
    expect(result.warnings).not.toContain(NOTE_UNSUPPORTED.inlineUrl);
  });

  it("段落の空行はそのまま残す（noteは空行が段落の切れ目）", () => {
    expect(toNoteMarkdown("一段落目\n\n二段落目").body).toBe(
      "一段落目\n\n二段落目"
    );
  });
});

describe("noteに無いもの", () => {
  it("表には注意を出す（文字がそのまま並ぶ）", () => {
    const result = toNoteMarkdown("| 名前 | 役 |\n| --- | --- |");
    expect(result.warnings).toContain(NOTE_UNSUPPORTED.table);
    // 消しはしない。作者が自分で貼り直せるように残す
    expect(result.body).toContain("| 名前 | 役 |");
  });

  it("斜体は印が外れて、注意が出る", () => {
    const result = toNoteMarkdown("これは*斜体*です");
    expect(result.body).toBe("これは斜体です");
    expect(result.warnings).toContain(NOTE_UNSUPPORTED.italic);
  });

  it("傍点は印が外れて、注意が出る", () => {
    const result = toNoteMarkdown("{{ここ}}が大事");
    expect(result.body).toBe("ここが大事");
    expect(result.warnings).toContain(NOTE_UNSUPPORTED.emphasis);
  });
});

describe("投稿用のコピーと同じ落とし方をする", () => {
  /** ルビの落とし方は `core/ruby.ts` の `paren` から引く（写しを作らない） */
  it("ルビは括弧書きになる", () => {
    const result = toNoteMarkdown("{灯|あかり}が点る");
    expect(result.body).toBe(toSiteNotation("{灯|あかり}が点る", "paren"));
    expect(result.body).toBe("灯（あかり）が点る");
  });

  /** シーンメモは作者の付箋で、公開するものではない（設計書6.40.2） */
  it("シーンメモの行は落とす", () => {
    const result = toNoteMarkdown("// あとで直す\n本文です");
    expect(result.body).toBe("本文です");
  });
});
