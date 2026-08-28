import { describe, expect, it } from "vitest";
import { buildManuscriptEditorHtml } from "../../src/views/manuscriptEditorHtml";
import { NOTATION_PATTERN } from "../../src/core/manuscriptRender";

/**
 * 組んで書く（実験）の面（設計書6.34）。
 *
 * この面でいちばん危ないのは **DOM→記法の直列化**である。1文字でもずれた
 * まま打つと、**壊れた本文が文書へ入る**。そこで、
 *
 * 1. `記法→DOM→記法` が元と**完全に一致する**こと（往復）
 * 2. contenteditable が作る揺れ（&nbsp;・入れ物の違い・詰め物の br）を
 *    正しく畳むこと
 * 3. 位置の対応（記法のオフセット ↔ DOMの位置）が往復すること
 *
 * を、**実際に画面へ渡る関数そのもの**で確かめる。
 *
 * ## 画面のJSを、画面の外から動かす
 *
 * 画面のJSは webview のテンプレート文字列の中にしか無い（`src/core` へ
 * 写すと、**片方だけが直る日が必ず来る**）。`manuscriptSplitFollow.test.ts`
 * と同じく、配られるHTMLから印の間を切り出して `new Function` で動かす。
 *
 * DOMの実装はこの環境に無いので、**組み立てに使う document を差し替える**
 * （画面側の関数は `doc` を引数で受け取るように書いてある）。
 */

const html = buildManuscriptEditorHtml("NONCE123", "vscode-resource:");
const code = html.slice(html.indexOf("<script"));

const source = code.slice(
  code.indexOf("/* compose:start */"),
  code.indexOf("/* compose:end */")
);

/* ── 偽の document ─────────────────────────────── */

interface FakeNode {
  nodeType: number;
  nodeName: string;
  nodeValue?: string;
  childNodes: FakeNode[];
  attributes?: Record<string, string>;
  getAttribute?(name: string): string | null;
  setAttribute?(name: string, value: string): void;
  appendChild?(child: FakeNode): FakeNode;
}

function element(
  name: string,
  children: FakeNode[] = [],
  attributes: Record<string, string> = {}
): FakeNode {
  const node: FakeNode = {
    nodeType: 1,
    // 本物の HTML 文書では大文字で返る。同じにしておく
    nodeName: name.toUpperCase(),
    childNodes: children.slice(),
    attributes: { ...attributes },
    getAttribute(key: string) {
      const found = node.attributes as Record<string, string>;
      return Object.prototype.hasOwnProperty.call(found, key)
        ? found[key]
        : null;
    },
    setAttribute(key: string, value: string) {
      (node.attributes as Record<string, string>)[key] = value;
    },
    appendChild(child: FakeNode) {
      node.childNodes.push(child);
      return child;
    },
  };
  return node;
}

function text(value: string): FakeNode {
  return { nodeType: 3, nodeName: "#text", nodeValue: value, childNodes: [] };
}

function fragment(children: FakeNode[] = []): FakeNode {
  const node: FakeNode = {
    nodeType: 11,
    nodeName: "#document-fragment",
    childNodes: children.slice(),
    appendChild(child: FakeNode) {
      node.childNodes.push(child);
      return child;
    },
  };
  return node;
}

const fakeDoc = {
  createElement: (name: string) => element(name),
  createTextNode: (value: string) => text(value),
  createDocumentFragment: () => fragment(),
};

/* ── 切り出した本物の関数 ───────────────────── */

interface ComposeAtom {
  kind: "text" | "chunk" | "break";
  node: FakeNode;
  parent: FakeNode;
  index: number;
  text: string;
  start: number;
  end: number;
}

interface ComposePart {
  kind: "text" | "ruby" | "emphasis";
  src: string;
  base: string;
  reading: string;
}

interface ComposeApi {
  composeParts(line: string): ComposePart[];
  composePartsToNotation(parts: ComposePart[]): string;
  composeNormalizeText(value: string): string;
  composeNormalizeNewlines(value: string): string;
  composeBuildLine(line: string, doc: unknown): FakeNode;
  composeBuildFragment(value: string, doc: unknown): FakeNode;
  composeAtoms(root: FakeNode): ComposeAtom[];
  composeDomToNotation(root: FakeNode): string;
  composeOffsetToPoint(
    atoms: ComposeAtom[],
    offset: number
  ): { node: FakeNode; offset: number } | null;
  composePointToOffset(
    atoms: ComposeAtom[],
    node: FakeNode,
    offset: number
  ): number;
  composeSelectionHasChunk(
    atoms: ComposeAtom[],
    start: number,
    end: number
  ): boolean;
}

const api = new Function(
  source +
    "\nreturn { composeParts, composePartsToNotation, composeNormalizeText," +
    " composeNormalizeNewlines, composeBuildLine, composeBuildFragment," +
    " composeAtoms, composeDomToNotation, composeOffsetToPoint," +
    " composePointToOffset, composeSelectionHasChunk };"
)() as ComposeApi;

/** 記法から組み立てたDOM（偽） */
function build(value: string): FakeNode {
  return api.composeBuildFragment(value, fakeDoc);
}

/** 記法→DOM→記法 */
function round(value: string): string {
  return api.composeDomToNotation(build(value));
}

describe("切り出し", () => {
  it("印で挟んであり、切り出せる", () => {
    expect(source).toContain("function composeParts(");
    expect(source).toContain("function composeDomToNotation(");
  });

  /**
   * **記法の定義は core/manuscriptRender.ts の1つだけ。** 画面側へは
   * その文字列がそのまま埋め込まれる（写しを置くと片方だけが直る）。
   */
  it("記法の定義は、読む面と同じものが埋め込まれている", () => {
    expect(source).toContain(JSON.stringify(NOTATION_PATTERN));
  });
});

/**
 * **この作品でいちばん重い決まりは「作者の原稿を壊さない」である。**
 * 組んで書く面は、打つたびに DOM から本文を作り直して文書へ返す。
 * 往復が一致しなければ、打っただけで本文が書き換わる。
 */
describe("記法→DOM→記法 が完全に一致する", () => {
  const cases = [
    "",
    "あ",
    "あいうえお",
    "\n",
    "\n\n",
    "あ\nい",
    "あ\n\nい",
    "\nあ",
    "あ\n",
    "あ\n\n\nい",
    "{漢字|かんじ}",
    "あ{漢字|かんじ}い",
    "{漢字|かんじ}あ",
    "あ{漢字|かんじ}",
    "{漢字|かんじ}{名前|なまえ}",
    "{{強調}}",
    "あ{{強調}}い",
    "{{強調}}{{再度}}",
    "{漢字|かんじ}と{{強調}}",
    "{{強調}}と{漢字|かんじ}",
    // 読み仮名が空。**記法のまま平文で残す**（書きかけを消さない）
    "{漢字|}",
    "あ{漢字|}い",
    "{漢字| }",
    // 記法に見えるが、規則に当たらないもの
    "{a|",
    "|}",
    "}{",
    "{a|b|c}",
    "{{a}",
    "{ }",
    "{}",
    "{{}}",
    "波{括弧|かっこ}は{",
    // 傍点はルビの規則にも当たる。先に見ていないと化ける
    "{{a|b}}",
    // 空白・全角空白・タブ
    "　あ",
    "あ  い",
    "あ\tい",
    "あ 　\nい",
    // 実データに近い形
    "「{灯|あかり}」と、{{はっきり}}言った。\n\n　だが返事は無い。",
    "第一話\n\n　{白瀬|しらせ}{澪|みお}は{{ただ}}立っていた。\n",
    "…………",
    "──{彼女|かのじょ}は、",
    /*
      三点リーダは「…」1文字ずつのかたまりになる（作者の依頼、2026-08-28）。
      **かたまりにした以上、往復が崩れれば本文が壊れる。** 前後・連続・
      ルビとの並び・行頭行末を並べる
    */
    "…",
    "……",
    "あ…",
    "…あ",
    "あ…い",
    "あ……い",
    "…\n…",
    "…{漢字|かんじ}…",
    "{{強調}}…",
    "「そう……」と{彼女|かのじょ}は言った。\n\n　……返事は無い。",
  ];

  it("すべての場合で、1文字も変わらない", () => {
    for (const value of cases) {
      expect(round(value), JSON.stringify(value)).toBe(value);
    }
  });

  /** 行の数（＝改行の数）も変わらない */
  it("行の数が変わらない", () => {
    for (const value of cases) {
      expect(round(value).split("\n")).toHaveLength(value.split("\n").length);
    }
  });

  /**
   * **U+00A0（&nbsp;）が入っている原稿は、往復が一致しない。**
   * ここは安全弁が「入らない」と判断するところである（黙って直さない）。
   */
  it("扱えない文字（U+00A0）は、一致しないと分かる", () => {
    expect(round("あ い")).not.toBe("あ い");
    expect(round("あ い")).toBe("あ い");
  });
});

describe("部品への割り方", () => {
  it("部品を並べ直すと元の行になる", () => {
    const lines = [
      "あ{漢字|かんじ}い{{強調}}う",
      "{漢字|}のこり",
      "ただの文",
      "",
    ];
    for (const line of lines) {
      expect(api.composePartsToNotation(api.composeParts(line))).toBe(line);
    }
  });

  it("ルビは親文字と読みに分かれる", () => {
    const parts = api.composeParts("あ{漢字|かんじ}");
    expect(parts).toHaveLength(2);
    expect(parts[1]).toEqual({
      kind: "ruby",
      src: "{漢字|かんじ}",
      base: "漢字",
      reading: "かんじ",
    });
  });

  it("傍点は中の文字だけを持つ", () => {
    const parts = api.composeParts("{{強調}}");
    expect(parts[0].kind).toBe("emphasis");
    expect(parts[0].base).toBe("強調");
    expect(parts[0].src).toBe("{{強調}}");
  });

  /** 読みが空のルビは、まだ書きかけ。**記法のまま平文で残す** */
  it("読みの無いルビは平文（記法のまま）", () => {
    const parts = api.composeParts("{漢字|}");
    expect(parts).toEqual([
      { kind: "text", src: "{漢字|}", base: "{漢字|}", reading: "" },
    ]);
  });

  it("平文は1つにまとめる（テキストノードを増やさない）", () => {
    const parts = api.composeParts("あ{漢字|}い");
    expect(parts).toHaveLength(1);
    expect(parts[0].src).toBe("あ{漢字|}い");
  });
});

describe("組み立てたDOMの形", () => {
  it("行は p.line、空行には詰め物の br が入る", () => {
    const root = build("あ\n");
    expect(root.childNodes).toHaveLength(2);
    const first = root.childNodes[0];
    expect(first.nodeName).toBe("P");
    expect(first.getAttribute?.("class")).toBe("line");
    const second = root.childNodes[1];
    expect(second.childNodes[0].nodeName).toBe("BR");
  });

  /** **かたまりの中は編集できない**（設計書6.34.2） */
  it("ルビ・傍点は編集不可のかたまりで、記法そのものを持つ", () => {
    const root = build("あ{漢字|かんじ}い{{強調}}");
    const line = root.childNodes[0];
    const ruby = line.childNodes[1];
    expect(ruby.nodeName).toBe("RUBY");
    expect(ruby.getAttribute?.("contenteditable")).toBe("false");
    expect(ruby.getAttribute?.("data-src")).toBe("{漢字|かんじ}");
    expect(ruby.childNodes[0].nodeValue).toBe("漢字");
    expect(ruby.childNodes[1].nodeName).toBe("RT");
    expect(ruby.childNodes[1].childNodes[0].nodeValue).toBe("かんじ");

    const emphasis = line.childNodes[3];
    expect(emphasis.nodeName).toBe("SPAN");
    expect(emphasis.getAttribute?.("class")).toBe("emphasis");
    expect(emphasis.getAttribute?.("contenteditable")).toBe("false");
    expect(emphasis.getAttribute?.("data-src")).toBe("{{強調}}");
  });

  /**
   * 三点リーダ（作者の依頼、2026-08-28「三点リーダは行中央にしてください」）。
   *
   * **読む面とまったく同じ素の span にする**（作者の実機報告、2026-08-28
   * 「組んで書くの三点リーダーはまだ変です。間を開けないでください」）。
   * 0.24.12 は `contenteditable="false"` のかたまりにしており、CSSは
   * 読む面から写してあったのに**縦書きで「……」の間に隙間が出た**。
   * 編集できない要素は編集領域の中で1文字ぶんの箱として扱われないためで、
   * **CSSを揃えるだけでは足りず、DOMの作りまで同じにする必要がある。**
   */
  it("三点リーダは、読む面と同じ素の span（かたまりにしない）", () => {
    const root = build("あ……い");
    const line = root.childNodes[0];
    expect(line.childNodes).toHaveLength(4);
    for (const index of [1, 2]) {
      const dots = line.childNodes[index];
      expect(dots.nodeName).toBe("SPAN");
      expect(dots.getAttribute?.("class")).toBe("ellipsis");
      // かたまりの印は付けない。付けると編集領域の中で箱として扱われる
      expect(dots.getAttribute?.("contenteditable")).toBeNull();
      expect(dots.getAttribute?.("data-src")).toBeNull();
      expect(dots.childNodes[0].nodeValue).toBe("…");
    }
  });

  /**
   * かたまりではなくなったので、**位置の一覧では平文と同じ扱いに戻る。**
   * 直列化は「知らない要素は中の文字を拾う」経路で「…」に戻す。
   */
  it("三点リーダは平文として数える（かたまりは1つも作らない）", () => {
    const atoms = api.composeAtoms(build("あ……い"));
    expect(atoms.filter((atom) => atom.kind === "chunk")).toEqual([]);
    expect(
      atoms.map((atom) => [atom.kind, atom.text, atom.start, atom.end])
    ).toEqual([
      ["text", "あ", 0, 1],
      ["text", "…", 1, 2],
      ["text", "…", 2, 3],
      ["text", "い", 3, 4],
    ]);
  });

  it("かたまりは data-src をそのまま出す（中の字ではなく記法）", () => {
    // 中の字を書き換えても、記法（data-src）のほうが本文になる
    const line = element("p", [
      text("あ"),
      element("ruby", [text("別"), element("rt", [text("べつ")])], {
        "data-src": "{漢|かん}",
      }),
    ]);
    expect(api.composeDomToNotation(fragment([line]))).toBe("あ{漢|かん}");
  });
});

/**
 * contenteditable は、こちらが組んだ形を保ってくれない。
 * **入ってくる揺れを、原稿の文字へ戻す。**
 */
describe("contenteditable が作る揺れを畳む", () => {
  it("&nbsp;（U+00A0）は普通の空白に戻す", () => {
    const line = element("p", [text("あ い")]);
    expect(api.composeDomToNotation(fragment([line]))).toBe("あ い");
  });

  it("改行で入れ物が div になっても、行として読む", () => {
    const root = fragment([
      element("div", [text("あ")]),
      element("div", [text("い")]),
    ]);
    expect(api.composeDomToNotation(root)).toBe("あ\nい");
  });

  it("入れ物が混ざっていても読む（p と div）", () => {
    const root = fragment([
      element("p", [text("あ")], { class: "line" }),
      element("div", [text("い")]),
      element("p", [text("う")], { class: "line" }),
    ]);
    expect(api.composeDomToNotation(root)).toBe("あ\nい\nう");
  });

  /** 空の行の高さを保つための詰め物。数えると空行が増え続ける */
  it("入れ物の最後の br は詰め物として捨てる", () => {
    const root = fragment([element("p", [text("あ"), element("br")])]);
    expect(api.composeDomToNotation(root)).toBe("あ");
  });

  it("途中の br は行の切れ目として数える", () => {
    const root = fragment([
      element("p", [text("あ"), element("br"), text("い")]),
    ]);
    expect(api.composeDomToNotation(root)).toBe("あ\nい");
  });

  it("空の入れ物は空行になる", () => {
    const root = fragment([
      element("p", [element("br")]),
      element("p", [text("あ")]),
      element("p", []),
    ]);
    expect(api.composeDomToNotation(root)).toBe("\nあ\n");
  });

  it("入れ子の入れ物も、行の切れ目として読む", () => {
    const root = fragment([
      element("p", [text("あ"), element("div", [text("い")])]),
    ]);
    expect(api.composeDomToNotation(root)).toBe("あ\nい");
  });

  /** 貼り付けの取りこぼしなどで、飾りの要素が混ざったとき */
  it("知らない要素は、中の文字だけを拾う", () => {
    const root = fragment([
      element("p", [text("あ"), element("b", [text("い")]), text("う")]),
    ]);
    expect(api.composeDomToNotation(root)).toBe("あいう");
  });

  it("改行コードの違い（CR・CRLF）は LF に揃える", () => {
    const root = fragment([element("p", [text("あ\r\nい\rう")])]);
    expect(api.composeDomToNotation(root)).toBe("あ\nい\nう");
    expect(api.composeNormalizeNewlines("あ\r\nい")).toBe("あ\nい");
    expect(api.composeNormalizeText("あ い")).toBe("あ い");
  });

  it("中身が空なら、空の本文になる", () => {
    expect(api.composeDomToNotation(fragment([]))).toBe("");
  });
});

/**
 * 位置の対応。**カーソルの置き直しと、用語の色付けがここに乗る。**
 * ずれると、色が隣の字に付き、組み直すたびにカーソルが飛ぶ。
 */
describe("記法の位置とDOMの位置", () => {
  const value = "あ{漢字|かんじ}い\nう{{強調}}\n\nえ";

  it("かたまりは data-src の文字数ぶんを占める", () => {
    const atoms = api.composeAtoms(build(value));
    const chunks = atoms.filter((atom) => atom.kind === "chunk");
    expect(chunks).toHaveLength(2);
    expect(chunks[0].text).toBe("{漢字|かんじ}");
    expect(chunks[0].start).toBe(1);
    expect(chunks[0].end).toBe(1 + "{漢字|かんじ}".length);
  });

  it("かたまりの中へは入らず、境目へ寄せる", () => {
    const root = build("あ{漢字|かんじ}い");
    const atoms = api.composeAtoms(root);
    const line = root.childNodes[0];
    // かたまりの先頭 → かたまりの手前
    expect(api.composeOffsetToPoint(atoms, 1)).toEqual({
      node: line,
      offset: 1,
    });
    // かたまりの途中 → かたまりの後ろ（中は編集できない）
    expect(api.composeOffsetToPoint(atoms, 4)).toEqual({
      node: line,
      offset: 2,
    });
  });

  /**
   * **位置を往復できること。** カーソルを覚えて戻すのも、用語へ色を置くのも
   * この往復に乗っている。
   */
  it("すべての位置で、記法→DOM→記法 が同じ位置に戻る", () => {
    for (const sample of [
      "あいう",
      "あ{漢字|かんじ}い",
      "あ\nい",
      "あ\n\nい",
      value,
      "{{強調}}\n{漢字|かんじ}",
      // 三点リーダも1文字ぶんのかたまり。カーソルはこれを1文字として跨ぐ
      "あ……い",
      "…{漢字|かんじ}…",
      "あ…\n…い",
    ]) {
      const atoms = api.composeAtoms(build(sample));
      for (let offset = 0; offset <= sample.length; offset++) {
        const point = api.composeOffsetToPoint(atoms, offset);
        expect(point, sample + " の " + offset).not.toBeNull();
        const back = api.composePointToOffset(
          atoms,
          point!.node,
          point!.offset
        );
        // かたまりの中は境目へ寄る。それ以外は同じ位置に戻る
        const inChunk = atoms.some(
          (atom) =>
            atom.kind === "chunk" && offset > atom.start && offset < atom.end
        );
        if (inChunk) expect(back).toBe(offsetAfterChunk(atoms, offset));
        else expect(back, sample + " の " + offset).toBe(offset);
      }
    }
  });

  function offsetAfterChunk(atoms: ComposeAtom[], offset: number): number {
    const chunk = atoms.find(
      (atom) =>
        atom.kind === "chunk" && offset > atom.start && offset < atom.end
    );
    return chunk ? chunk.end : offset;
  }

  it("中身が空なら、置き先が無いと分かる", () => {
    expect(api.composeOffsetToPoint(api.composeAtoms(build("")), 0)).toBeNull();
    expect(api.composePointToOffset([], element("p"), 0)).toBe(0);
  });

  it("範囲にかたまりが重なっているかを見分ける", () => {
    const atoms = api.composeAtoms(build("あ{漢字|かんじ}い"));
    // 「{漢字|かんじ}」は記法のまま8文字ぶんを占める（1〜9）
    // 「あ」だけ
    expect(api.composeSelectionHasChunk(atoms, 0, 1)).toBe(false);
    // 「い」だけ
    expect(api.composeSelectionHasChunk(atoms, 9, 10)).toBe(false);
    // ルビにかかる
    expect(api.composeSelectionHasChunk(atoms, 0, 2)).toBe(true);
    expect(api.composeSelectionHasChunk(atoms, 2, 10)).toBe(true);
    // 端どうしは重ならない（かたまりの直後から選び始めたとき）
    expect(api.composeSelectionHasChunk(atoms, 1, 1)).toBe(false);
  });

  it("三点リーダは妨げにしない（かたまりではないので当たらない）", () => {
    // 「そう……」に傍点、のような使い方を塞がないため（0.24.12）。
    // 三点リーダは見た目のための印で、記法（ルビ・傍点）ではない
    const atoms = api.composeAtoms(build("そう……だ"));
    // 「…」（2〜4）を含む範囲でも false（振ってよい）
    expect(api.composeSelectionHasChunk(atoms, 0, 4)).toBe(false);
    expect(api.composeSelectionHasChunk(atoms, 2, 5)).toBe(false);
    // 行ぜんぶを選んでも通る
    expect(api.composeSelectionHasChunk(atoms, 0, 5)).toBe(false);
  });
});

/**
 * 見た目やDOMの振る舞いは、この環境（DOM実装なし）では動かせない。
 * **約束が画面のJSに入っているか**だけを見る。
 */
describe("画面の約束", () => {
  it("スクリプトは構文として読める", () => {
    const body = code.slice(
      code.indexOf(">") + 1,
      code.lastIndexOf("</script>")
    );
    expect(() => new Function(body)).not.toThrow();
  });

  it("組んで書く（実験）のボタンと面がある", () => {
    expect(html).toContain('id="composeMode"');
    expect(html).toContain("組んで書く（実験）");
    expect(html).toContain('<div id="compose"');
  });

  /**
   * **安全弁。** 往復が一致しないまま入ると、打った瞬間に本文が書き換わる。
   * 一致しないときは入らず、理由を出し、ログにも残す。
   */
  it("往復が一致しなければ、面に入らない", () => {
    expect(code).toContain("function composeBuildChecked(");
    expect(code).toContain(
      "if (composeDomToNotation(built) !== wanted) return null;"
    );
    const enter = code.slice(code.indexOf("function composeEnter("));
    expect(enter.slice(0, 900)).toContain("if (!built)");
    expect(enter.slice(0, 900)).toContain('type: "log"');
  });

  /** 外のHTMLがDOMへ入ると、直列化が壊れる */
  it("貼り付けは平文だけを入れる", () => {
    const paste = code.slice(code.indexOf('compose.addEventListener("paste"'));
    expect(paste.slice(0, 300)).toContain("event.preventDefault();");
    expect(paste.slice(0, 300)).toContain('getData("text/plain")');
    expect(code).toContain('compose.addEventListener("drop"');
  });

  /**
   * 見えている字をそのまま写すと、ルビは「親文字＋読み仮名」の並びになる。
   * それを貼り戻すと、読み仮名が本文へ混ざる。
   */
  it("写すときは記法で写す", () => {
    expect(code).toContain("function composeCopyNotation(");
    expect(code).toContain('compose.addEventListener("copy"');
    expect(code).toContain('compose.addEventListener("cut"');
    expect(code).toContain('data.setData("text/plain"');
  });

  /** 太字などは記法に無いものをDOMへ入れる */
  it("装飾のコマンドは通さない", () => {
    expect(code).toContain('compose.addEventListener("beforeinput"');
    expect(code).toContain('kind.indexOf("format") === 0');
  });

  /**
   * **用語の色付けは CSS Custom Highlight API**（設計書6.34.3）。
   * DOMを書き換えないので、色を付けてもカーソルも取り消し履歴も動かない。
   */
  it("用語の色は、DOMを書き換えずに置く", () => {
    expect(code).toContain("CSS.highlights.set(");
    expect(code).toContain("new Highlight(");
    expect(html).toContain("::highlight(novelai-term-character)");
    // 使えない環境では色が出ないだけ（入力は動く）
    expect(code).toContain("function composeHighlightsUsable(");
    expect(code).toContain('typeof Highlight !== "undefined"');
  });

  /** 位置がいまの本文のものだと確かめてから置く（ずれた色は出さない） */
  it("色は、いまの本文と一致するときだけ置く", () => {
    const apply = code.slice(code.indexOf("function composeApplyHighlights("));
    expect(apply.slice(0, 700)).toContain("termsForText");
  });

  it("色付けは1フレームに1回へまとめる", () => {
    expect(code).toContain("function composeScheduleHighlight(");
    expect(code).toContain("composeHighlightTimer");
  });

  /** 自分の書き換えが返ってきたら触らない（カーソルと取り消し履歴を守る） */
  it("自分が送った本文が返ってきただけなら、組み直さない", () => {
    const take = code.slice(code.indexOf("function composeTakeIncoming("));
    expect(take.slice(0, 500)).toContain("if (text === lastSent) return;");
    expect(take.slice(0, 500)).toContain("if (composing)");
  });

  it("変換中は本文を送らない", () => {
    expect(code).toContain('compose.addEventListener("compositionstart"');
    expect(code).toContain('compose.addEventListener("compositionend"');
    const input = code.slice(code.indexOf('compose.addEventListener("input"'));
    expect(input.slice(0, 300)).toContain("if (composing) return;");
  });

  /** 右クリック・ホバーは、位置から用語を引く（この面に用語の要素は無い） */
  it("右クリックとホバーが、位置から用語を引く", () => {
    expect(code).toContain("function composeOffsetAtPoint(");
    expect(code).toContain("document.caretRangeFromPoint");
    expect(code).toContain("document.caretPositionFromPoint");
    expect(code).toContain("function composeTermAt(");
    expect(code).toContain('vscode.postMessage({ type: "openTerm"');
  });

  /** チップの中身は読む面と分け合う（同じ見た目が別々に育たないように） */
  it("チップは読む面と同じものを出す", () => {
    expect(code).toContain("function fillTip(");
    expect(code).toContain("function placeTip(");
    expect(code).toContain("fillTip(span.name, span.kind, span.summary)");
  });

  /** ルビの上にルビを重ねると、記法が入れ子になって壊れる */
  it("かたまりの上には、ルビ・傍点を重ねない", () => {
    const ask = code.slice(code.indexOf("function composeAskNotation("));
    expect(ask.slice(0, 800)).toContain("composeSelectionHasChunk(");
    expect(ask.slice(0, 800)).toContain(
      "ルビや傍点の上には重ねられません"
    );
  });

  /**
   * 三点リーダの見た目は、読む面（0.24.1で作者が確かめた形）と同じにする。
   * **同じ本文が面によって違って見えるのは、それ自体が不具合である。**
   */
  it("三点リーダを行の中央に寄せる指定がある", () => {
    expect(html).toContain("#compose .ellipsis {");
    expect(html).toContain("body.vertical #compose .ellipsis {");
    // 縦書きは「横書きに固定してから90度回す」（フォントの字形に頼らない）
    const vertical = html.slice(
      html.indexOf("body.vertical #compose .ellipsis {")
    );
    expect(vertical.slice(0, 300)).toContain("writing-mode: horizontal-tb");
    expect(vertical.slice(0, 300)).toContain("transform: rotate(90deg)");
    // 1em角に固定しないと、「……」の間に隙間があく
    expect(vertical.slice(0, 300)).toContain("width: 1em");
    expect(vertical.slice(0, 300)).toContain("height: 1em");
  });

  /**
   * **読む面の指定と1文字も違わないこと。**
   *
   * 作者が確かめて「これでよい」と言ったのは読む面の形である。片方だけを
   * 直すと、同じ本文が面によって違って見える——それ自体が不具合なので、
   * 目で見比べるのではなく、両方のブロックを抜き出して比べる。
   */
  it("三点リーダのCSSは、読む面と組んで書く面で同じ", () => {
    /** そのセレクタの { } の中身（前後の空白は落とす） */
    function block(selector: string): string {
      const head = html.indexOf(selector + " {");
      expect(head, selector + " が無い").toBeGreaterThanOrEqual(0);
      const open = html.indexOf("{", head);
      const close = html.indexOf("}", open);
      return html.slice(open + 1, close).trim();
    }

    expect(block("#compose .ellipsis")).toBe(block("#read .ellipsis"));
    expect(block("body.vertical #compose .ellipsis")).toBe(
      block("body.vertical #read .ellipsis")
    );
    // 空の比較で通ってしまわないよう、中身があることも見る
    expect(block("#read .ellipsis").length).toBeGreaterThan(0);
    expect(block("body.vertical #read .ellipsis")).toContain(
      "transform: rotate(90deg)"
    );
  });

  /**
   * 素の span にした代わりの手当て（0.24.13）。
   *
   * span の中で打つと、回した書式が打った字へ伝染する。打つ直前に
   * カーソルを span の外へ逃がす。**変換中（IME）は触らない**——変換の
   * 途中で選択を動かすと、日本語入力の側が持つ位置とずれて変換が壊れる。
   */
  it("三点リーダの中で打つ前に、カーソルを外へ出す", () => {
    expect(code).toContain("function composeEscapeEllipsis(");
    expect(code).toContain("function composeEllipsisAncestor(");
    const escape = code.slice(code.indexOf("function composeEscapeEllipsis("));
    expect(escape.slice(0, 900)).toContain("if (composing) return;");
    expect(escape.slice(0, 900)).toContain(
      'if (kind === "insertCompositionText") return;'
    );
    expect(escape.slice(0, 900)).toContain("setStartBefore(span)");
    expect(escape.slice(0, 900)).toContain("setStartAfter(span)");
    // beforeinput から呼ぶ（打ち込みが起きる前でないと逃がせない）
    const before = code.slice(
      code.indexOf('compose.addEventListener("beforeinput"')
    );
    expect(before.slice(0, 400)).toContain("composeEscapeEllipsis(kind)");
  });

  it("面の状態を覚える", () => {
    expect(code).toContain("compose: composeOn || composeWanted");
  });

  /** 実験が転んでも、いままでの書き方が無傷で残ること */
  it("いつでも打つ面へ戻せる", () => {
    expect(code).toContain("function composeLeave(");
    expect(html).toContain("組んで書くのをやめる");
  });
});
