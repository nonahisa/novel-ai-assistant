import { describe, expect, it } from "vitest";
import {
  renderLine,
  renderManuscript,
  tokenizeLine,
} from "../../src/core/manuscriptRender";
import { TermIndex, type TermEntry } from "../../src/core/termIndex";

/**
 * 原稿エディタの表示（設計書6.25）。
 *
 * **本文とHTMLの対応がずれたら、作者は自分の原稿を読めない。**
 * ここが壊れると、画面に出ているものと保存されているものが違うことになる。
 */

function index(entries: Array<Partial<TermEntry> & { text: string }>) {
  return new TermIndex(
    entries.map((entry) => ({
      kind: "character",
      id: "char_001",
      canonicalName: entry.text,
      ...entry,
    })) as TermEntry[]
  );
}

describe("記法を切り出す", () => {
  it("ルビを親文字と読み仮名に割る", () => {
    expect(tokenizeLine("彼は{灯|あかり}と呼ばれた")).toEqual([
      { kind: "plain", text: "彼は" },
      { kind: "ruby", base: "灯", reading: "あかり" },
      { kind: "plain", text: "と呼ばれた" },
    ]);
  });

  /** 傍点はルビの規則にも当たる。先に見ないと `{強調}` に化ける */
  it("傍点をルビと取り違えない", () => {
    expect(tokenizeLine("それは{{絶対}}に違う")).toEqual([
      { kind: "plain", text: "それは" },
      { kind: "emphasis", text: "絶対" },
      { kind: "plain", text: "に違う" },
    ]);
  });

  /** 書きかけの `{漢字|}` で本文を消さない */
  it("読み仮名が空なら、親文字を平文として残す", () => {
    expect(tokenizeLine("{灯|}が灯る")).toEqual([
      { kind: "plain", text: "灯" },
      { kind: "plain", text: "が灯る" },
    ]);
  });

  it("記法が無ければ、まるごと平文", () => {
    expect(tokenizeLine("ただの一行")).toEqual([
      { kind: "plain", text: "ただの一行" },
    ]);
  });
});

describe("1行を組み立てる", () => {
  it("ルビを <ruby> にする", () => {
    expect(renderLine("{灯|あかり}")).toBe(
      "<ruby>灯<rt>あかり</rt></ruby>"
    );
  });

  it("傍点を <em> にする", () => {
    expect(renderLine("{{絶対}}")).toBe('<em class="emph">絶対</em>');
  });

  /** HTMLを書かれても、そのまま流さない */
  it("本文中のHTMLを escape する", () => {
    expect(renderLine("<script>alert(1)</script>")).toBe(
      "&lt;script&gt;alert(1)&lt;/script&gt;"
    );
  });

  it("読み仮名の中のHTMLも escape する", () => {
    expect(renderLine("{名|<b>}")).toContain("<rt>&lt;b&gt;</rt>");
  });

  it("空行は高さを保つ", () => {
    expect(renderLine("")).toBe("<br>");
  });

  it("用語に色分けの印を付ける", () => {
    const html = renderLine("灯が笑った", index([{ text: "灯" }]));
    expect(html).toContain('class="term term-character"');
    expect(html).toContain('data-term-id="char_001"');
    expect(html).toContain(">灯</span>");
    expect(html).toContain("が笑った");
  });

  /** ルビが振ってある名前だけ色が付かないと、別人に見える */
  it("ルビの親文字にも用語の色を当てる", () => {
    const html = renderLine("{灯|あかり}", index([{ text: "灯" }]));
    expect(html).toContain("<ruby>");
    expect(html).toContain('class="term term-character"');
    expect(html).toContain("<rt>あかり</rt>");
  });

  /** 記法の記号をまたいだ一致を作らない */
  it("ルビの記号をまたいで用語を拾わない", () => {
    const html = renderLine("{灯|あかり}火", index([{ text: "灯火" }]));
    expect(html).not.toContain("term-character");
  });

  it("索引が空でも本文は出る", () => {
    expect(renderLine("灯が笑った", index([]))).toBe("灯が笑った");
  });

  it("種別ごとに違う印を付ける", () => {
    const html = renderLine(
      "図書塔",
      index([{ text: "図書塔", kind: "location", id: "loc_001" }])
    );
    expect(html).toContain("term-location");
  });
});

describe("本文まるごと", () => {
  /** 改行が意味を持つので、空行までを1段落へ畳まない */
  it("1行を1段落にする", () => {
    const html = renderManuscript("一行目\n二行目");
    expect(html).toContain('<p class="line" data-line="0">一行目</p>');
    expect(html).toContain('<p class="line" data-line="1">二行目</p>');
  });

  it("CRLFでも行がずれない", () => {
    const html = renderManuscript("一行目\r\n二行目");
    expect(html).toContain('data-line="1">二行目</p>');
    expect(html).not.toContain("\r");
  });

  it("空行も1段落として残る", () => {
    const html = renderManuscript("一行目\n\n三行目");
    expect(html).toContain('<p class="line" data-line="1"><br></p>');
    expect(html).toContain('data-line="2">三行目</p>');
  });

  it("行数が本文と一致する", () => {
    const text = "あ\nい\nう\nえ\nお";
    const count = [...renderManuscript(text).matchAll(/data-line=/g)].length;
    expect(count).toBe(5);
  });
});
