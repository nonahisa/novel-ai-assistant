import { describe, expect, it } from "vitest";
import {
  collectTermSpans,
  renderLine,
  renderManuscript,
  renderTermMarks,
  termSpanAt,
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

/**
 * 「書く」面の裏に敷く目印（作者の依頼、2026-08-27。設計書6.25.6）。
 *
 * **打つ面は textarea なので、中の一部だけを飾れない。** 同じ本文を裏に敷き、
 * 用語のところだけ背景を塗る。**裏と表で字送りが1文字でもずれると、
 * 色が別の字に付く。**
 */
describe("打つ面の目印", () => {
  it("用語のところだけを包む", () => {
    const html = renderTermMarks("灯は歩いた", index([{ text: "灯" }]));

    expect(html).toBe('<span class="mark mark-character">灯</span>は歩いた');
  });

  it("文字は1つも足さない・落とさない", () => {
    // **裏と表で字数が変われば、そこから先の色が全部ずれる**
    const text = "灯と澪が話した";
    const html = renderTermMarks(
      text,
      index([{ text: "灯" }, { text: "澪", id: "char_002" }])
    );

    expect(html.replace(/<[^>]+>/g, "")).toBe(text);
  });

  it("記号を逃がす", () => {
    // 逃がさないと、本文の < で画面が壊れる
    expect(renderTermMarks("<b>灯", index([{ text: "灯" }]))).toBe(
      '&lt;b&gt;<span class="mark mark-character">灯</span>'
    );
  });

  it("索引が無ければ、そのまま逃がすだけ", () => {
    expect(renderTermMarks("灯は歩いた", undefined)).toBe("灯は歩いた");
  });

  it("改行はそのまま残す", () => {
    // 裏地は pre-wrap で置くので、改行を落とすと行がずれる
    const newline = String.fromCharCode(10);
    const html = renderTermMarks("灯" + newline + "澪", index([{ text: "灯" }]));

    expect(html).toContain(newline);
  });
});

describe("用語の位置", () => {
  it("位置と名前を返す", () => {
    const spans = collectTermSpans("灯は歩いた", index([{ text: "灯" }]));

    expect(spans).toEqual([
      {
        start: 0,
        end: 1,
        id: "char_001",
        kind: "character",
        name: "灯",
        summary: "",
      },
    ]);
  });

  it("紹介があれば、チップ用に一緒に返す", () => {
    const spans = collectTermSpans(
      "灯は歩いた",
      index([{ text: "灯", summary: "夜市を歩く少女。" }])
    );
    expect(spans[0].summary).toBe("夜市を歩く少女。");
  });

  it("その文字位置にある用語を引ける", () => {
    // 打つ面には要素が無いので、カーソルの文字位置から引く
    const spans = collectTermSpans("あ灯い", index([{ text: "灯" }]));

    expect(termSpanAt(spans, 1)?.name).toBe("灯");
    expect(termSpanAt(spans, 0)).toBeUndefined();
  });

  it("用語の直後は含めない", () => {
    // 直後で右クリックして隣の資料が開くと分かりにくい
    const spans = collectTermSpans("灯は", index([{ text: "灯" }]));

    expect(termSpanAt(spans, 1)).toBeUndefined();
  });

  it("索引が無ければ空", () => {
    expect(collectTermSpans("灯", undefined)).toEqual([]);
  });
});

/**
 * 三点リーダの中央寄せ（作者の依頼、2026-08-28）。
 *
 * 位置はフォント任せで、欧文フォントに落ちると横書きで下に沈み、
 * 縦書きで横倒しのまま出る。読む面はHTMLなので印を付けてCSSで寄せる。
 * 書く面（textarea）は文字単位の調整ができないため対象外。
 */
describe("三点リーダの印", () => {
  it("「…」が1文字ずつ ellipsis の印で包まれる", () => {
    const html = renderLine("だが……そうか", undefined);
    expect(html).toBe(
      'だが<span class="ellipsis">…</span><span class="ellipsis">…</span>そうか'
    );
  });

  it("用語の色分けの中の「…」も包まれ、属性値は包まれない", () => {
    const html = renderLine("白…瀬は言った", index([{ text: "白…瀬" }]));
    expect(html).toContain('>白<span class="ellipsis">…</span>瀬</span>');
    expect(html).toContain('data-term-name="白…瀬"');
  });
});
