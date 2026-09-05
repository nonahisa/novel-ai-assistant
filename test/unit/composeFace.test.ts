import { describe, expect, it } from "vitest";
import { buildManuscriptEditorHtml } from "../../src/views/manuscriptEditorHtml";
import {
  NOTATION_PATTERN,
  NOTATION_RULES,
  SITE_NOTATION_PATTERN,
} from "../../src/core/manuscriptRender";
import {
  MEMO_LINE_PATTERN,
  MEMO_TAG_CLASS_MAP,
  memoTagClass,
  parseMemos,
} from "../../src/core/sceneMemo";

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
 * 写すと、**片方だけが直る日が必ず来る**）。そこで、配られるHTMLから
 * 印（`compose:start` 〜 `compose:end`）の間を切り出し、`new Function` で
 * 動かす——**試しているのは、そのまま画面へ渡る本物**である。
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

/** 記法のモード（.md は curly、.txt は site。設計書6.12） */
type Mode = "curly" | "site";

interface ComposeApi {
  composeParts(line: string, mode?: Mode): ComposePart[];
  composePartsToNotation(parts: ComposePart[]): string;
  composeNormalizeText(value: string): string;
  composeNormalizeNewlines(value: string): string;
  composeBuildLine(line: string, doc: unknown, mode?: Mode): FakeNode;
  composeBuildFragment(value: string, doc: unknown, mode?: Mode): FakeNode;
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
  pickMenuTerm(
    clickOffset: number | null,
    selection: { start: number; end: number } | null,
    spans: MenuSpan[]
  ): MenuSpan | null;
  /** シーンメモ（設計書6.40.3） */
  memoIsLine(line: string): boolean;
  memoPartsOf(line: string): { tag: string; text: string };
  memoClassFor(line: string): string;
}

/** 用語の位置（`collectTermSpans` が渡してくるもののうち、判定が見る分だけ） */
interface MenuSpan {
  start: number;
  end: number;
  id: string;
}

const api = new Function(
  source +
    "\nreturn { composeParts, composePartsToNotation, composeNormalizeText," +
    " composeNormalizeNewlines, composeBuildLine, composeBuildFragment," +
    " composeAtoms, composeDomToNotation, composeOffsetToPoint," +
    " composePointToOffset, composeSelectionHasChunk, pickMenuTerm," +
    " memoIsLine, memoPartsOf, memoClassFor };"
)() as ComposeApi;

/** 記法から組み立てたDOM（偽） */
function build(value: string, mode?: Mode): FakeNode {
  return api.composeBuildFragment(value, fakeDoc, mode);
}

/** 記法→DOM→記法 */
function round(value: string, mode?: Mode): string {
  return api.composeDomToNotation(build(value, mode));
}

describe("切り出し", () => {
  it("印で挟んであり、切り出せる", () => {
    expect(source).toContain("function composeParts(");
    expect(source).toContain("function composeDomToNotation(");
  });

  /**
   * **記法の定義は core/manuscriptRender.ts の1つだけ。** 画面側へは
   * その文字列がそのまま埋め込まれる（写しを置くと片方だけが直る）。
   *
   * **モードのぶんだけ見張る。** `.txt`（投稿サイトの記法）を足したとき、
   * 片方の埋め込みを忘れると、その原稿だけ記法が生のまま出る。
   */
  it("記法の定義は、読む面と同じものが埋め込まれている", () => {
    expect(source).toContain(JSON.stringify(NOTATION_PATTERN));
    expect(source).toContain(JSON.stringify(SITE_NOTATION_PATTERN));
    // 捕獲の番号まで含めて、丸ごと同じものが渡っている
    expect(source).toContain(JSON.stringify(NOTATION_RULES));
  });

  /**
   * シーンメモの記法も、**定義は core/sceneMemo.ts の1つだけ**である
   * （設計書6.40）。画面側に写しを置くと、拡張機能側と画面側で
   * 「どれがメモか」が食い違う日が来る。
   */
  it("シーンメモの記法とタグの表も、写しではなく埋め込まれている", () => {
    expect(source).toContain(JSON.stringify(MEMO_LINE_PATTERN));
    expect(source).toContain(JSON.stringify(MEMO_TAG_CLASS_MAP));
  });
});

/**
 * **この作品でいちばん重い決まりは「作者の原稿を壊さない」である。**
 * 組んで書く面は、打つたびに DOM から本文を作り直して文書へ返す。
 * 往復が一致しなければ、打っただけで本文が書き換わる。
 */
/**
 * ダッシュに使われる2つの文字。
 *
 * **見た目でも編集画面でも見分けが付かない**ので、符号から作る
 * （直に書くと、試験が何を試しているのか誰にも分からなくなる）。
 */
/** 欧文のダッシュ（U+2014 EM DASH） */
const DASH_EM = String.fromCodePoint(0x2014);
/** 和文のダッシュ（U+2015 HORIZONTAL BAR） */
const DASH_BAR = String.fromCodePoint(0x2015);

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
    /*
      ダッシュも1文字ずつのかたまりになる（作者の実機報告、2026-08-29）。
      **入っていた字をそのまま戻すこと**が肝心で、ここで字を揃えてしまうと
      **打っただけで本文が書き換わる。** 欧文（U+2014）と和文（U+2015）が
      混ざった並びを必ず含める——作者の原稿で実際に混ざっていた形である。
    */
    DASH_EM,
    DASH_BAR,
    DASH_BAR + DASH_BAR,
    DASH_EM + DASH_BAR,
    DASH_BAR + DASH_EM,
    "あ" + DASH_BAR + "い",
    "主従の悪だくみが始まった" + DASH_EM + DASH_BAR,
    DASH_BAR + "{彼女|かのじょ}は、",
    DASH_BAR + "\n" + DASH_EM,
    "…" + DASH_BAR + "…",
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

/**
 * `.txt` の原稿（投稿サイトの記法。設計書6.12）。
 *
 * **`.txt` は投稿サイトから持ってきた形をそのまま保つ**決まりで、この面から
 * ルビを振ることはできない（拡張機能側が断る）。それでも**打つたびに本文を
 * 作り直す**のはこの面の作りそのものなので、往復が一致しなければ、
 * ルビを振らなくても**本文が書き換わる**。curly と同じだけ並べて確かめる。
 *
 * **`fromSiteNotation`（波括弧の記法への変換）は、この経路では絶対に
 * 呼ばない。** 変換した文字列を data-src に入れると、直列化した時点で
 * 原稿が別の記法へ書き換わる。
 */
describe("投稿サイトの記法でも、記法→DOM→記法 が完全に一致する", () => {
  const cases = [
    "",
    "あ",
    "\n",
    "あ\nい",
    // 縦線ありのルビ
    "｜漢字《かんじ》",
    "あ｜漢字《かんじ》い",
    "｜漢字《かんじ》あ",
    "あ｜漢字《かんじ》",
    "｜漢字《かんじ》｜名前《なまえ》",
    // 半角の縦線も通る（どのサイトも両方を受ける）
    "半角|漢字《かんじ》",
    // 縦線なしのルビ（漢字の直後だけ）
    "漢字《かんじ》",
    "あ漢字《かんじ》い",
    "漢字《かんじ》名前《なまえ》",
    "漢字《かんじ》｜名前《なまえ》",
    // 傍点（カクヨム・ネオページ）
    "《《強調》》",
    "あ《《強調》》い",
    "《《強調》》《《再度》》",
    "｜漢字《かんじ》と《《強調》》",
    "《《強調》》と漢字《かんじ》",
    // **漢字の直後の傍点。** ルビとして読むと親文字「彼」・読み「《強調」に化ける
    "彼《《強調》》",
    "｜彼《《強調》》",
    // 読み仮名が空。**記法のまま平文で残す**（書きかけを消さない）
    "｜漢字《》",
    "漢字《》",
    "｜漢字《 》",
    // 記法に見えるが、規則に当たらないもの
    "《》",
    "｜《》",
    "《序章》がはじまる",
    "｜",
    "《",
    "》《",
    "あ》》",
    // 閉じ忘れ
    "｜漢字《かん",
    "《《あ》",
    "《《あ",
    "漢字《かんじ",
    // 傍点の中の《》らしきもの
    "《《強調》》》",
    "《《《強調》》",
    // なろう・アルファポリスの、ルビで代用する傍点（ルビとして組まれる）
    "｜強調《・・》",
    // 空白・全角空白・タブ
    "　あ",
    "あ  い",
    "あ\tい",
    // 三点リーダとの混在（素の span になる経路）
    "…｜漢字《かんじ》…",
    "そう……と彼女《かのじょ》は言った",
    "《《ただ》》……",
    // 実データに近い形（カクヨム）
    "「｜灯《あかり》」と、《《はっきり》》言った。\n\n　だが返事は無い。",
    "第一話\n\n　｜白瀬《しらせ》｜澪《みお》は《《ただ》》立っていた。\n",
    "　その日、彼女《かのじょ》は｜図書塔《としょとう》へ向かった。\n" +
      "　《《誰も》》知らない道を、｜灯《あかり》だけが知っていた。",
  ];

  it("すべての場合で、1文字も変わらない", () => {
    for (const value of cases) {
      expect(round(value, "site"), JSON.stringify(value)).toBe(value);
    }
  });

  it("行の数が変わらない", () => {
    for (const value of cases) {
      expect(round(value, "site").split("\n")).toHaveLength(
        value.split("\n").length
      );
    }
  });

  /**
   * **モードは混ぜない**（設計書6.12）。`.txt` でルビを振ることはできない
   * ので、`.txt` の中の波括弧を記法として畳むと、**外せない印**になる。
   */
  it("モードを取り違えない", () => {
    // .txt の中の波括弧は平文（かたまりを1つも作らない）
    const site = api.composeAtoms(build("{漢字|かんじ}と{{強調}}", "site"));
    expect(site.filter((atom) => atom.kind === "chunk")).toEqual([]);
    expect(round("{漢字|かんじ}と{{強調}}", "site")).toBe(
      "{漢字|かんじ}と{{強調}}"
    );

    // .md の中の《》は平文
    const curly = api.composeAtoms(build("｜漢字《かんじ》と《《強調》》"));
    expect(curly.filter((atom) => atom.kind === "chunk")).toEqual([]);
    expect(round("｜漢字《かんじ》と《《強調》》")).toBe(
      "｜漢字《かんじ》と《《強調》》"
    );
  });

  /** 知らないモードでも、本文を壊さない側（今までの記法）へ倒す */
  it("モードを渡さなければ、いままでの記法で組む", () => {
    expect(round("{漢字|かんじ}")).toBe("{漢字|かんじ}");
    expect(api.composeParts("{漢字|かんじ}")[0].kind).toBe("ruby");
  });
});

describe("投稿サイトの記法の部品とDOM", () => {
  /** **かたまりが持つのは、記法そのもの**（縦線を含む） */
  it("縦線ありのルビは、縦線ごと1つのかたまりになる", () => {
    const parts = api.composeParts("あ｜漢字《かんじ》", "site");
    expect(parts).toHaveLength(2);
    expect(parts[1]).toEqual({
      kind: "ruby",
      src: "｜漢字《かんじ》",
      base: "漢字",
      reading: "かんじ",
    });
  });

  it("縦線なしのルビも、同じ形の部品になる", () => {
    expect(api.composeParts("漢字《かんじ》", "site")[0]).toEqual({
      kind: "ruby",
      src: "漢字《かんじ》",
      base: "漢字",
      reading: "かんじ",
    });
  });

  it("傍点は中の文字だけを持つ", () => {
    expect(api.composeParts("《《強調》》", "site")[0]).toEqual({
      kind: "emphasis",
      src: "《《強調》》",
      base: "強調",
      reading: "",
    });
  });

  it("読みの無いルビは平文（記法のまま）", () => {
    expect(api.composeParts("｜漢字《》", "site")).toEqual([
      { kind: "text", src: "｜漢字《》", base: "｜漢字《》", reading: "" },
    ]);
  });

  it("部品を並べ直すと元の行になる", () => {
    for (const line of [
      "あ｜漢字《かんじ》い《《強調》》う",
      "漢字《》のこり",
      "ただの文",
      "",
    ]) {
      expect(api.composePartsToNotation(api.composeParts(line, "site"))).toBe(
        line
      );
    }
  });

  /** 出す形は `.md` と同じ（同じ本文が面によって違って見えないこと） */
  it("ルビ・傍点は編集不可のかたまりで、記法そのものを持つ", () => {
    const line = build("あ｜漢字《かんじ》い《《強調》》", "site").childNodes[0];
    const ruby = line.childNodes[1];
    expect(ruby.nodeName).toBe("RUBY");
    expect(ruby.getAttribute?.("contenteditable")).toBe("false");
    // **元の文字列そのまま**（波括弧の記法へ変換したものを入れない）
    expect(ruby.getAttribute?.("data-src")).toBe("｜漢字《かんじ》");
    expect(ruby.childNodes[0].nodeValue).toBe("漢字");
    expect(ruby.childNodes[1].childNodes[0].nodeValue).toBe("かんじ");

    const emphasis = line.childNodes[3];
    expect(emphasis.nodeName).toBe("SPAN");
    expect(emphasis.getAttribute?.("class")).toBe("emphasis");
    expect(emphasis.getAttribute?.("data-src")).toBe("《《強調》》");
    expect(emphasis.childNodes[0].nodeValue).toBe("強調");
  });

  /** かたまりは**記法の文字数ぶん**を占める（縦線もカーソルの通り道になる） */
  it("かたまりは、記法の文字数ぶんを占める", () => {
    const atoms = api.composeAtoms(build("あ｜漢字《かんじ》い", "site"));
    const chunks = atoms.filter((atom) => atom.kind === "chunk");
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toBe("｜漢字《かんじ》");
    expect(chunks[0].start).toBe(1);
    expect(chunks[0].end).toBe(1 + "｜漢字《かんじ》".length);
  });

  /** 三点リーダの扱いは、記法によらず同じ */
  it("三点リーダは、どちらの記法でも素の span", () => {
    const line = build("あ……い", "site").childNodes[0];
    expect(line.childNodes).toHaveLength(4);
    expect(line.childNodes[1].getAttribute?.("class")).toBe("ellipsis");
    expect(line.childNodes[1].getAttribute?.("data-src")).toBeNull();
  });

  /**
   * **位置の往復。** カーソルの置き直しと用語の色付けがここに乗っている。
   */
  it("すべての位置で、記法→DOM→記法 が同じ位置に戻る", () => {
    for (const sample of [
      "あ｜漢字《かんじ》い",
      "漢字《かんじ》",
      "《《強調》》\n漢字《かんじ》",
      "あ……｜漢字《かんじ》",
    ]) {
      const atoms = api.composeAtoms(build(sample, "site"));
      for (let offset = 0; offset <= sample.length; offset++) {
        const point = api.composeOffsetToPoint(atoms, offset);
        expect(point, sample + " の " + offset).not.toBeNull();
        const back = api.composePointToOffset(atoms, point!.node, point!.offset);
        const chunk = atoms.find(
          (atom) =>
            atom.kind === "chunk" && offset > atom.start && offset < atom.end
        );
        expect(back, sample + " の " + offset).toBe(
          chunk ? chunk.end : offset
        );
      }
    }
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
   * ダッシュ（作者の実機報告、2026-08-29「主従の悪だくみが始まった――」の
   * 2本のあいだに隙間が見える）。
   *
   * 隙間の正体は**書体の取り違え**で、この行は欧文の U+2014 と和文の
   * U+2015 が1本ずつだった。欧文のダッシュは字送りより線が短いので、
   * 並べてもつながらない。CSSで和文の明朝へ固定するために印を付ける。
   *
   * **入っていた字をそのまま入れること。** ここで字を揃えると、
   * **面を開いただけで本文が書き換わる**——字を揃えるのは作法チェックの
   * 提案を作者が承認したときだけである。
   */
  it("ダッシュは、字をそのままにした素の span", () => {
    const line = build("あ" + DASH_EM + DASH_BAR + "い").childNodes[0];
    expect(line.childNodes).toHaveLength(4);

    // 入っていた順に、入っていた字のまま
    for (const [index, char] of [
      [1, DASH_EM],
      [2, DASH_BAR],
    ] as const) {
      const dash = line.childNodes[index];
      expect(dash.nodeName).toBe("SPAN");
      expect(dash.getAttribute?.("class")).toBe("dash");
      // かたまりの印は付けない（三点リーダと同じ。付けると隙間が出る）
      expect(dash.getAttribute?.("contenteditable")).toBeNull();
      expect(dash.getAttribute?.("data-src")).toBeNull();
      expect(dash.childNodes[0].nodeValue).toBe(char);
    }
  });

  it("ダッシュも平文として数える（かたまりは1つも作らない）", () => {
    const atoms = api.composeAtoms(build("あ" + DASH_EM + DASH_BAR + "い"));
    expect(atoms.filter((atom) => atom.kind === "chunk")).toEqual([]);
    expect(
      atoms.map((atom) => [atom.kind, atom.text, atom.start, atom.end])
    ).toEqual([
      ["text", "あ", 0, 1],
      ["text", DASH_EM, 1, 2],
      ["text", DASH_BAR, 2, 3],
      ["text", "い", 3, 4],
    ]);
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

  /**
   * **切り替えのボタンは外した**（作者の指示、2026-08-29。組んで書くが標準）。
   * 面そのものと、覚えた状態から開く道（composeWanted）は残っている。
   */
  it("組んで書く面があり、開いた時点で入る", () => {
    expect(html).toContain('<div id="compose"');
    expect(html).not.toContain('id="composeMode"');
    expect(code).toContain("composeWanted");
    expect(code).toContain("composeEnter()");
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
   * 三点リーダの見た目は、**0.24.1で作者が読む面で確かめた形**である。
   * 読む面そのものは0.25.2で消したが、確かめた値はここに残っている。
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
   * **作者が確かめた値そのものを、ここで押さえる。**
   *
   * 0.25.2まではもう1つ「読む」面（`#read .ellipsis`）があり、この2つの
   * ブロックが1文字も違わないことを比べていた——作者が確かめて「これで
   * よい」と言ったのは読む面の形だったので、片方だけ直すと同じ本文が面に
   * よって違って見えたからである。読む面を消して比べる相手が無くなったので、
   * **値を直に書いて押さえる**。とくに欧文フォールバックの字形（下寄りの
   * 三点リーダ）へ落ちないよう、和文の明朝を指定する行は落とせない
   * （実機の報告、2026-08-29）。
   */
  it("三点リーダのCSSに、作者が確かめた指定がそろっている", () => {
    /** そのセレクタの { } の中身（前後の空白は落とす） */
    function block(selector: string): string {
      const head = html.indexOf(selector + " {");
      expect(head, selector + " が無い").toBeGreaterThanOrEqual(0);
      const open = html.indexOf("{", head);
      const close = html.indexOf("}", open);
      return html.slice(open + 1, close).trim();
    }

    const flat = block("#compose .ellipsis");
    expect(flat).toContain("vertical-align: middle");
    // 選んだ書体が「…」を持たないと欧文へ落ち、下寄りの字形で沈んで見える
    expect(flat).toContain('"Yu Mincho"');

    const vertical = block("body.vertical #compose .ellipsis");
    expect(vertical).toContain("writing-mode: horizontal-tb");
    expect(vertical).toContain("transform: rotate(90deg)");
    // 1em角に固定しないと、「……」の間に隙間があく
    expect(vertical).toContain("width: 1em");
    expect(vertical).toContain("height: 1em");
  });

  /**
   * ダッシュの書体（作者の実機報告、2026-08-29）。
   *
   * 欧文のダッシュは字送りより線が短いので、和文書体を持たない環境へ
   * 落ちると**線がつながらず隙間になる。** 和文の明朝へ固定して防ぐ。
   *
   * **回転と1em角は付けない**（三点リーダとはここが違う）。和文書体は
   * ダッシュの縦用の字形を持っているので、縦書きでは何もしなくても
   * 正しく立つ。回すと、かえって字が切れる。
   */
  it("ダッシュは和文の明朝に固定し、縦書きでは回さない", () => {
    function block(selector: string): string {
      const head = html.indexOf(selector + " {");
      expect(head, selector + " が無い").toBeGreaterThanOrEqual(0);
      const open = html.indexOf("{", head);
      const close = html.indexOf("}", open);
      return html.slice(open + 1, close).trim();
    }

    expect(block("#compose .dash")).toContain('"Yu Mincho"');
    // 縦書き向けの規則そのものを置かない
    expect(html).not.toContain("body.vertical #compose .dash");
  });

  /**
   * 素の span にした代わりの手当て（0.24.13）。
   *
   * span の中で打つと、回した書式が打った字へ伝染する。打つ直前に
   * カーソルを span の外へ逃がす。**変換中（IME）は触らない**——変換の
   * 途中で選択を動かすと、日本語入力の側が持つ位置とずれて変換が壊れる。
   */
  it("三点リーダ・ダッシュの中で打つ前に、カーソルを外へ出す", () => {
    expect(code).toContain("function composeEscapeEllipsis(");
    expect(code).toContain("function composeEllipsisAncestor(");

    /*
      **ダッシュの印にも効かせる**（0.25.2）。三点リーダと同じ素の span で
      出しているので、中で打つと掛けた書体を受け継ぐ問題も同じである。
      印を1種類しか見ていないと、ダッシュの中で打った字だけが化ける。
    */
    const ancestor = code.slice(
      code.indexOf("function composeEllipsisAncestor(")
    );
    expect(ancestor.slice(0, 600)).toContain(
      'name === "ellipsis" || name === "dash"'
    );

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

  /**
   * 実験が転んでも、いままでの書き方が無傷で残ること。
   *
   * **ボタンは無くなったが、落ちる道は残す**（作者の指示、2026-08-29）。
   * 届いた本文を組み直せないと分かったら、この面から「書く」面へ落とす。
   * 落ちた先の textarea では、これまでどおり普通に打てる。
   */
  it("組み直せない本文が届いたら、打つ面へ落ちる", () => {
    expect(code).toContain("function composeLeave(");
    const apply = code.slice(code.indexOf("function composeApplyText("));
    expect(apply.slice(0, 700)).toContain("composeLeave();");
  });
});

/**
 * 右クリックが指す用語（作者の実機報告、2026-08-29）。
 *
 * 「用語の上で右クリックしても設定資料パネルが切り替わらない」——記録には
 * **同じ人物が6回続けて**送られていた。
 *
 * 犯人は**残っている選択**である。誤字脱字パネルから本文へ飛ぶと
 * （revealLine）、その行がまるごと選ばれたままになる。以前の判定は
 * 「選択が空でなければ、選択に重なる最初の用語」だったので、その行に
 * 人物が1人いると、**以後どこを押してもその人物**になった。
 *
 * 判定は `pickMenuTerm` に切り出してある——実機でしか動かない部分
 * （座標→本文の位置）を引数で受け取るので、ここから直に動かせる。
 */
describe("右クリックが指す用語", () => {
  /** 「あ<コリンナ>うえ<図書塔>き」のような並び */
  const spans = [
    { start: 2, end: 6, id: "char_002" },
    { start: 10, end: 13, id: "loc_001" },
  ];

  it("選択の中を押したら、選んだものを引く", () => {
    // 「選んでから右クリック」は、これまでどおり効く
    const found = api.pickMenuTerm(4, { start: 2, end: 6 }, spans);
    expect(found?.id).toBe("char_002");
  });

  /**
   * **これが直った不具合そのものである。**
   * 行をまるごと選んだ状態（ジャンプの直後）で、選択の外を押したとき。
   */
  it("選択があっても、その外を押したら押した位置のものを引く", () => {
    // 0〜8 が選ばれている（その中に char_002 がいる）が、押したのは 11
    const found = api.pickMenuTerm(11, { start: 0, end: 8 }, spans);
    expect(found?.id).toBe("loc_001");
  });

  it("選択の外で、用語の無いところを押したら何も指さない", () => {
    expect(api.pickMenuTerm(9, { start: 0, end: 8 }, spans)).toBeNull();
  });

  /**
   * 縦書きで座標を本文の位置に直せない環境があるらしい（実機の報告）。
   * 右クリックはカーソルを押したところへ動かすので、**選択が縮退して
   * いれば、その start が押した位置**である。
   */
  it("押した位置が分からなければ、カーソルの位置で引く", () => {
    const found = api.pickMenuTerm(null, { start: 11, end: 11 }, spans);
    expect(found?.id).toBe("loc_001");
  });

  it("押した位置も選択も取れなければ、何も指さない", () => {
    expect(api.pickMenuTerm(null, null, spans)).toBeNull();
    // 範囲のある選択は「押した位置」の代わりにならない（どこを押したか不明）
    expect(api.pickMenuTerm(null, { start: 2, end: 6 }, spans)).toBeNull();
  });

  /** 用語の直後で右クリックして隣の資料が開くと分かりにくい */
  it("用語の終わりちょうどは含めない", () => {
    expect(api.pickMenuTerm(6, null, spans)).toBeNull();
    // 始まりちょうどは含める
    expect(api.pickMenuTerm(2, null, spans)?.id).toBe("char_002");
  });

  /**
   * 選択の中に用語が無いなら、押した位置で引き直す。
   * **選んだだけで、押したところの資料が引けなくなるのは困る。**
   */
  it("選択の中に用語が無ければ、押した位置で引き直す", () => {
    // 6〜9 を選んだ状態で、選択の端（用語のある 10〜13 の手前）ではなく
    // 選択の中の 8 を押した。選択には用語が無いので、押した位置で引く
    expect(api.pickMenuTerm(8, { start: 6, end: 9 }, spans)).toBeNull();
    // 選択の中を押していて、そこに用語があれば引ける
    expect(api.pickMenuTerm(11, { start: 9, end: 13 }, spans)?.id).toBe(
      "loc_001"
    );
  });
});

/**
 * 位置を本文へ直せなかったことを記録する（縦書きの切り分け。実機の報告）。
 *
 * **正常なら1行も出ない。** 出るなら、その環境では座標→本文の位置の変換が
 * 効いていないということで、そこから先の当たり判定は全部あてにならない。
 */
describe("右クリックの位置が取れなかったときの記録", () => {
  const code = html.slice(html.indexOf("<script"));

  it("品書きを開く1回につき1行だけ、縦横とともに残す", () => {
    const at = code.slice(code.indexOf("function composeTermAt("));
    expect(at.slice(0, 900)).toContain("if (clickOffset === null) {");
    expect(at.slice(0, 900)).toContain(
      "右クリックの位置を本文の位置に直せませんでした"
    );
    // 縦書きかどうかが分からないと、切り分けにならない
    expect(at.slice(0, 900)).toContain("(vertical !== false)");
    // 判定そのものは切り出した関数に任せる（ここで二重に持たない）
    expect(at.slice(0, 900)).toContain(
      "pickMenuTerm(clickOffset, composeMenuAt, termSpans)"
    );
  });
});

/**
 * シーンメモの付箋（設計書6.40.3）。
 *
 * **いちばん大事なのは、往復が変わらないこと**である。付箋は見た目だけを
 * 変えるもので、DOM→記法の直列化には一切関わらない。ここが崩れると、
 * メモを1つ書いただけで本文が壊れる。
 */
describe("シーンメモの付箋", () => {
  it("メモの行があっても、記法→DOM→記法 は完全に一致する", () => {
    const text = [
      "　彼女は港を見下ろしていた。",
      "// TODO ここに潮の匂いの{描写|びょうしゃ}を足す",
      "／／ 伏線 銀の時計→第12話で回収",
      "　風が吹いた。",
    ].join("\n");
    expect(round(text)).toBe(text);
  });

  it("メモの行の段落に、付箋のクラスとタグのクラスが付く", () => {
    const root = build("あ\n// TODO ここ\n／／ 伏線 そこ\n// 推敲 あれ");
    expect(root.childNodes[0].getAttribute?.("class")).toBe("line");
    expect(root.childNodes[1].getAttribute?.("class")).toBe(
      "line memo memo-todo"
    );
    expect(root.childNodes[2].getAttribute?.("class")).toBe(
      "line memo memo-foreshadow"
    );
    // 読み替え表に無いタグは、灰色（クラスは memo だけ）
    expect(root.childNodes[3].getAttribute?.("class")).toBe("line memo");
  });

  /**
   * **かたまりにしない**（設計書6.40.3）。中身は普通に打てて、
   * 行頭の印を消せばただの本文へ戻る。
   */
  it("メモの行は編集不可のかたまりにしない", () => {
    const line = build("// TODO ここ").childNodes[0];
    expect(line.getAttribute?.("contenteditable")).toBeNull();
    expect(line.getAttribute?.("data-src")).toBeNull();
    expect(line.childNodes[0].nodeValue).toBe("// TODO ここ");
  });

  it("印を消せば、ただの本文の行に戻る", () => {
    expect(build("TODO ここ").childNodes[0].getAttribute?.("class")).toBe(
      "line"
    );
  });

  /**
   * **タグの分け方が拡張機能側と食い違わない。** 画面のチップに出るタグと、
   * 横のパネルに並ぶタグが違うと、同じ行が別のものに見える。
   */
  it("タグの分け方は、core/sceneMemo.ts と同じ答えになる", () => {
    const lines = [
      "// TODO 潮の匂いを足す",
      "／／ 要確認 距離が合わない",
      "// 潮の匂いを足す",
      "// TODO",
      "// 伏線 銀の時計",
    ];
    for (const line of lines) {
      const expected = parseMemos(line)[0];
      expect(api.memoPartsOf(line)).toEqual({
        tag: expected.tag,
        text: expected.text,
      });
      // クラスの決め方も同じ（表に無いタグは memo だけ）
      const kindClass = memoTagClass(expected.tag);
      expect(api.memoClassFor(line)).toBe(
        kindClass === "memo-other" ? "memo" : `memo ${kindClass}`
      );
    }
  });

  it("行頭以外の // は付箋にしない", () => {
    expect(api.memoIsLine("　彼は https://example.com を開いた。")).toBe(false);
    expect(api.memoIsLine("　// 字下げのある行")).toBe(false);
  });

  /**
   * 打った瞬間に色を当て直す（設計書6.40.3）。
   *
   * **組み直し（composeApplyText）は、打った本文が返ってきたときには
   * 走らない**（往復が一致するので早く戻る）。当て直しが無いと、
   * 印を打っても色が付かないまま残る。
   */
  it("打たれたら、class だけを当て直す", () => {
    const code = html.slice(html.indexOf("<script"));
    const repaint = code.slice(code.indexOf("function composeRepaintMemos("));
    expect(repaint.slice(0, 500)).toContain("setAttribute(\"class\"");
    // ノードを足したり消したりしない（直列化がずれる）
    expect(repaint.slice(0, 500)).not.toContain("appendChild");
    expect(repaint.slice(0, 500)).not.toContain("removeChild");
    // 打たれたら呼ばれる
    const input = code.slice(code.indexOf('compose.addEventListener("input"'));
    expect(input.slice(0, 500)).toContain("composeRepaintMemos();");
  });
});

/**
 * 脚本の行の組み方（設計書6.70）。
 *
 * **判定は core/scriptLines.ts の1か所**にあり、画面側へはその規則が
 * そのまま埋め込まれる（写しを置くと、画面と紙で組み方が食い違う）。
 * 印は class だけで、DOMの形は変えない——組んで書く面でノードを増やすと、
 * 直列化（DOM→記法）が1文字ずれて**本文が壊れる**。
 */
describe("脚本の行（組んで書く面）", () => {
  /** 脚本の作品として組んだ画面 */
  const scriptHtml = buildManuscriptEditorHtml(
    "NONCE123",
    "vscode-resource:",
    "script"
  );
  const scriptCode = scriptHtml.slice(scriptHtml.indexOf("<script"));
  const scriptSource = scriptCode.slice(
    scriptCode.indexOf("/* compose:start */"),
    scriptCode.indexOf("/* compose:end */")
  );
  const scriptApi = new Function(
    scriptSource +
      "\nreturn { composeBuildLine, composeBuildFragment," +
      " composeDomToNotation, composeLineClass };"
  )() as {
    composeBuildLine(line: string, doc: unknown, mode?: Mode): FakeNode;
    composeBuildFragment(value: string, doc: unknown, mode?: Mode): FakeNode;
    composeDomToNotation(root: FakeNode): string;
    composeLineClass(line: string): string;
  };

  function classOf(line: string): string {
    const node = scriptApi.composeBuildLine(line, fakeDoc);
    return (node.attributes ?? {}).class ?? "";
  }

  it("柱・ト書き・セリフに、それぞれの印が付く", () => {
    expect(classOf("○駅前・夜")).toBe("line script-hashira");
    expect(classOf("　太郎、ドアを開ける。")).toBe("line script-togaki");
    expect(classOf("太郎「行こう」")).toBe("line script-serifu");
  });

  it("どれにも当たらない行には、印を付けない", () => {
    expect(classOf("太郎は駅へ向かった。")).toBe("line");
    expect(classOf("")).toBe("line");
  });

  /** 付箋（シーンメモ）と重なっても、両方の印が残る */
  it("付箋の印と一緒に付く", () => {
    expect(classOf("//「銀の時計」を出す")).toBe("line memo script-serifu");
  });

  /** **印を付けても、本文は1文字も変わらない**（往復が一致する） */
  it("記法→DOM→記法 は、脚本でも一致する", () => {
    const body = ["○駅前・夜", "", "　{太郎|たろう}、ドアを開ける。", "太郎「行こう」"].join(
      "\n"
    );
    expect(
      scriptApi.composeDomToNotation(
        scriptApi.composeBuildFragment(body, fakeDoc)
      )
    ).toBe(body);
  });

  /**
   * 打った瞬間に当て直す（付箋と同じ道に乗せる）。行の種別は打つほど
   * 変わる（`○` を足した瞬間に柱になる）ので、組み立てのときだけでは足りない。
   */
  it("打たれたら、種別の印も当て直す", () => {
    const repaint = scriptCode.slice(
      scriptCode.indexOf("function composeRepaintMemos(")
    );
    expect(repaint.slice(0, 600)).toContain("composeLineClass(");
  });

  /** 脚本でない作品の画面は、これまでと変わらない */
  it("脚本以外では、印が付かない", () => {
    const node = api.composeBuildLine("○駅前・夜", fakeDoc);
    expect((node.attributes ?? {}).class ?? "").toBe("line");
  });

  it("脚本以外の画面は、タイプを渡さないときと1バイトも変わらない", () => {
    expect(
      buildManuscriptEditorHtml("NONCE123", "vscode-resource:", "long")
    ).toBe(html);
  });
});
