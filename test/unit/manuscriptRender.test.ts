import { describe, expect, it } from "vitest";
import {
  collectTermSpans,
  notationModeFor,
  renderLine,
  renderManuscript,
  renderTermMarks,
  termSpanAt,
  tokenizeLine,
  NOTATION_RULES,
  SITE_NOTATION_PATTERN,
} from "../../src/core/manuscriptRender";
import {
  countSiteNotation,
  SITE_EMPHASIS_SOURCE,
  SITE_RUBY_BARE_SOURCE,
  SITE_RUBY_BAR_SOURCE,
} from "../../src/core/ruby";
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

/**
 * 投稿サイトの記法（`.txt`。設計書6.12）。
 *
 * **`.txt` は投稿サイトから持ってきた形をそのまま保つ**決まりで、
 * ルビを振る操作は `.md` 限定である。**だからといって、記法が生のまま
 * 見えてよいわけではない**（作者の依頼、2026-08-29「テキストファイルも
 * ルビなどを再現して、同様に表示できるようにしてください」）。
 * 原稿には1文字も書かず、**表示のときだけ組む。**
 */
describe("投稿サイトの記法を切り出す（.txt）", () => {
  it("縦線ありのルビを割る", () => {
    expect(tokenizeLine("彼は｜灯《あかり》と呼ばれた", "site")).toEqual([
      { kind: "plain", text: "彼は" },
      { kind: "ruby", base: "灯", reading: "あかり" },
      { kind: "plain", text: "と呼ばれた" },
    ]);
  });

  it("半角の縦線でも割る（どのサイトも両方を受ける）", () => {
    expect(tokenizeLine("彼は|灯《あかり》だ", "site")).toEqual([
      { kind: "plain", text: "彼は" },
      { kind: "ruby", base: "灯", reading: "あかり" },
      { kind: "plain", text: "だ" },
    ]);
  });

  it("縦線を省いたルビ（漢字の直後）も割る", () => {
    expect(tokenizeLine("彼は灯《あかり》と呼ばれた", "site")).toEqual([
      { kind: "plain", text: "彼は" },
      { kind: "ruby", base: "灯", reading: "あかり" },
      { kind: "plain", text: "と呼ばれた" },
    ]);
  });

  it("カクヨム・ネオページの傍点を割る", () => {
    expect(tokenizeLine("それは《《絶対》》に違う", "site")).toEqual([
      { kind: "plain", text: "それは" },
      { kind: "emphasis", text: "絶対" },
      { kind: "plain", text: "に違う" },
    ]);
  });

  /**
   * **傍点を先に見ないと、縦線なしのルビに化ける。**
   * 「彼《《強調》》」を先にルビとして読むと、親文字「彼」・読み「《強調」に
   * なり、本文の見え方が変わる。
   */
  it("漢字の直後の傍点を、ルビと取り違えない", () => {
    expect(tokenizeLine("彼《《強調》》だ", "site")).toEqual([
      { kind: "plain", text: "彼" },
      { kind: "emphasis", text: "強調" },
      { kind: "plain", text: "だ" },
    ]);
  });

  it("読み仮名が空なら、親文字を平文として残す", () => {
    expect(tokenizeLine("｜灯《》が灯る", "site")).toEqual([
      { kind: "plain", text: "灯" },
      { kind: "plain", text: "が灯る" },
    ]);
  });

  /** 会話の中の二重山括弧を、記法として畳まない */
  it("漢字の直後でない《》は組まない", () => {
    expect(tokenizeLine("《序章》がはじまる", "site")).toEqual([
      { kind: "plain", text: "《序章》がはじまる" },
    ]);
  });

  it("閉じ忘れは、記法として扱わない", () => {
    expect(tokenizeLine("｜灯《あか", "site")).toEqual([
      { kind: "plain", text: "｜灯《あか" },
    ]);
    expect(tokenizeLine("《《あ》", "site")).toEqual([
      { kind: "plain", text: "《《あ》" },
    ]);
  });

  /**
   * **モードは混ぜない。** `.md` の中の《》も、`.txt` の中の波括弧も、
   * それぞれの決まりの外なので平文である。片方の面だけが両方を解釈すると、
   * 「振れないのに消える」記法が生まれる。
   */
  it("記法を取り違えない", () => {
    expect(tokenizeLine("{灯|あかり}", "site")).toEqual([
      { kind: "plain", text: "{灯|あかり}" },
    ]);
    expect(tokenizeLine("｜灯《あかり》", "curly")).toEqual([
      { kind: "plain", text: "｜灯《あかり》" },
    ]);
    expect(tokenizeLine("《《絶対》》", "curly")).toEqual([
      { kind: "plain", text: "《《絶対》》" },
    ]);
  });

  /** 既定は今までどおり（`.md` の記法） */
  it("モードを省くと、拡張機能の記法で読む", () => {
    expect(tokenizeLine("{灯|あかり}")).toEqual(
      tokenizeLine("{灯|あかり}", "curly")
    );
  });
});

/**
 * 記法の定義は `core/ruby.ts` の1つだけ（写しを置かない）。
 *
 * **写しを置くと、片方だけが直る日が必ず来る。** 取り込み
 * （`fromSiteNotation`）と表示で規則がずれると、**取り込めるのに
 * 表示されないルビ**が生まれる。
 */
describe("投稿サイトの規則は ruby.ts のものを使う", () => {
  it("3つの規則を、この順で並べたもの", () => {
    // 傍点 → 縦線あり → 縦線なし。順番そのものに意味がある
    expect(SITE_NOTATION_PATTERN).toBe(
      [
        SITE_EMPHASIS_SOURCE,
        SITE_RUBY_BAR_SOURCE,
        SITE_RUBY_BARE_SOURCE,
      ].join("|")
    );
    expect(NOTATION_RULES.site.pattern).toBe(SITE_NOTATION_PATTERN);
  });

  /** 捕獲の番号は、規則の並びから決まる（ずれると親文字と読みが入れ替わる） */
  it("捕獲の番号が規則と合っている", () => {
    expect(NOTATION_RULES.site.emphasis).toEqual([1]);
    expect(NOTATION_RULES.site.ruby).toEqual([
      [2, 3],
      [4, 5],
    ]);
    expect(NOTATION_RULES.curly.ruby).toEqual([[2, 3]]);
  });

  /**
   * **取り込みの数え方と、拾う件数が合うこと。**
   * `describeSiteNotation`（「ルビ12件と傍点3件」）が数えたものが、
   * そのまま画面に組まれる件数になる。
   */
  it("拾う件数が、取り込みの数え方と合う", () => {
    const lines = [
      "｜灯《あかり》が灯る",
      "彼女《かのじょ》は《《ただ》》立っていた",
      "《序章》のあと、｜白瀬《しらせ》と｜澪《みお》が出会う",
      "《《絶対》》に違う",
      "記法の無い行",
    ];
    for (const line of lines) {
      const tokens = tokenizeLine(line, "site");
      const counted = countSiteNotation(line);
      expect(
        tokens.filter((token) => token.kind === "ruby").length,
        line
      ).toBe(counted.ruby);
      expect(
        tokens.filter((token) => token.kind === "emphasis").length,
        line
      ).toBe(counted.emphasis);
    }
  });
});

/**
 * どちらの記法で組むかは、**ファイルの名前で決まる。**
 *
 * 判定は「ルビを振る」の可否（`features/manuscriptEditor.ts`）と同じに
 * してある——振れる面と組める面がずれると、振ったのに組まれない原稿が出る。
 */
describe("記法はファイルの種類で決める", () => {
  it(".md は拡張機能の記法、それ以外は投稿サイトの記法", () => {
    expect(notationModeFor("01_夜の駅.md")).toBe("curly");
    expect(notationModeFor("01_夜の駅.txt")).toBe("site");
    expect(notationModeFor("C:/works/銀の航路/01.MD")).toBe("curly");
    expect(notationModeFor("vscode-vfs://github/me/repo/works/01.txt")).toBe(
      "site"
    );
    // 見たことのない拡張子は、投稿サイトの形とみなす（.md だけが特別）
    expect(notationModeFor("メモ")).toBe("site");
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

  /** `.txt` でも、見た目は `.md` と同じになること（作者の依頼、2026-08-29） */
  it("投稿サイトの記法も、同じ <ruby>・圏点になる", () => {
    expect(renderLine("｜灯《あかり》", undefined, "site")).toBe(
      renderLine("{灯|あかり}", undefined, "curly")
    );
    expect(renderLine("灯《あかり》", undefined, "site")).toBe(
      "<ruby>灯<rt>あかり</rt></ruby>"
    );
    expect(renderLine("《《絶対》》", undefined, "site")).toBe(
      '<em class="emph">絶対</em>'
    );
  });

  it("投稿サイトの記法でも、親文字に用語の色が付く", () => {
    const html = renderLine("｜灯《あかり》", index([{ text: "灯" }]), "site");
    expect(html).toContain("<ruby>");
    expect(html).toContain('class="term term-character"');
    expect(html).toContain("<rt>あかり</rt>");
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

  it("記法のモードは、本文まるごとの経路にも通る", () => {
    const html = renderManuscript("｜灯《あかり》\n《《絶対》》", undefined, "site");
    expect(html).toContain('data-line="0"><ruby>灯<rt>あかり</rt></ruby></p>');
    expect(html).toContain('data-line="1"><em class="emph">絶対</em></p>');
    // 既定は今までどおり（記法のまま出る）
    expect(renderManuscript("｜灯《あかり》")).toContain("｜灯《あかり》");
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
