import { unzipSync } from "fflate";

/**
 * Word（.docx）の本文を Markdown にする（設計書6.85）。
 *
 * 作者の要望（2026-09-06）：「ワードファイルの作品をMDに一括変更できる
 * ようにしてください。ルビは保存してください」。
 *
 * ## ルビと傍点だけは、必ず持ち帰る
 *
 * Word で書いた小説から Markdown へ移るとき、いちばん惜しいのが
 * **振り仮名**である。文字だけ写して出し直せば、ルビは全部振り直しになる。
 * そこで `w:ruby` を `{漢字|かんじ}`、`w:em w:val="dot"` を `{{強調}}` へ
 * 移す——どちらもこの拡張機能の記法そのもので（`core/ruby.ts`）、
 * 投稿サイト向けの変換もプレビューもそのまま効く。
 *
 * 太字・斜体・色・下線は落とす。**小説の本文では意味を持たない**うえ、
 * Markdown の `**` へ移すと本文に記号が増える。
 *
 * ## ZIP は fflate、XML は自前の走査
 *
 * ブラウザ版でも動かす必要がある（設計書5.8）ので `node:` に触れない。
 * ZIP は純JSの fflate（`epubPackage.ts` と同じ）。XML は **`DOMParser` が
 * Node に無い**ため自前で走査する。
 *
 * **汎用のXMLパーサにはしない。** 見るのは
 * `w:p` / `w:r` / `w:t` / `w:br` / `w:tab` / `w:ruby`（`w:rt`＝読み・
 * `w:rubyBase`＝親文字）／`w:rPr` の `w:em`／`w:pPr` の `w:pStyle`／表と
 * 画像だけである。汎用にすると、Word の何百とある要素のどれを無視して
 * よいのかが誰にも分からなくなる。
 *
 * ## 本文の文字は書き換えない
 *
 * 本文に `{` `}` `|` が入っていると、こちらが足す記法の印と紛れる。
 * **それでも全角へ寄せたりはしない**——変換で本文を変えたら、それは
 * もう作者の原稿ではない。紛れる恐れがあることを `skipped` で1回だけ
 * 伝えて、直すかどうかは作者に委ねる。
 *
 * VS Code API に依存しない（単体テストできる）。
 */

/** 読む中身。ここに無ければ Word の文書ではない */
const DOCUMENT_PART = "word/document.xml";

/**
 * 書式の対応表。**日本語版 Word の見出しを拾うために要る。**
 *
 * 見出しかどうかは `w:pStyle` の値（styleId）で決まるが、その値は
 * `Heading1` のような分かる名前とはかぎらない——日本語版 Word で
 * 作った文書では `a3` や `1` のような機械名になる。人が読む名前
 * （`w:name` の「heading 1」）はこちらにしか書いていない。
 */
const STYLES_PART = "word/styles.xml";

/** 変換の結果 */
export interface DocxConversion {
  /** Markdown 本文。段落が1行で、末尾に改行が1つ付く */
  markdown: string;
  /** `{親文字|よみ}` にしたルビの件数 */
  rubyCount: number;
  /** `{{強調}}` にした傍点の件数（続いた run はまとめて1件） */
  emphasisCount: number;
  /** 落としたもの・気をつけてほしいことを、作者に読める言葉で */
  skipped: string[];
}

/**
 * .docx のバイト列を Markdown へ。
 *
 * 読めないものは**例外で断る**（空の .md を作らない）。呼び出し側は
 * ファイル1件ぶんの理由として並べる。
 */
export function docxToMarkdown(bytes: Uint8Array): DocxConversion {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes, {
      // 本文と書式表のほかは読まない。画像まで展開すると、何十MBもの
      // 文書を1件変換するだけで手元の記憶が埋まる
      filter: (file) =>
        file.name === DOCUMENT_PART || file.name === STYLES_PART,
    });
  } catch {
    throw new Error(
      "Word の文書（.docx）として開けませんでした。壊れているか、.docx ではない可能性があります。"
    );
  }

  const document = files[DOCUMENT_PART];
  if (!document) {
    throw new Error(
      "Word の文書ではありません（中に word/document.xml がありません）。" +
        "古い .doc は、Word で .docx として保存し直してください。"
    );
  }

  const decoder = new TextDecoder();
  const styles = files[STYLES_PART];
  const builder = new DocumentBuilder(
    styles ? headingStyleIds(decoder.decode(styles)) : new Map()
  );
  scanXml(decoder.decode(document), builder);
  const conversion = builder.finish();

  /*
    **1文字も取れなかったら断る。** 0字の .md を作って「変換しました」と
    伝えると、作者はそれを信じて元の .docx を片づけてしまう。
    いちばん多い原因はテキストボックス（本文ではなく図形の中の文字）で、
    見た目には文章が並んでいるのに `w:p` の中には何も無い。
  */
  if (!conversion.markdown.trim()) {
    throw new Error(
      "本文の文字が取れませんでした。テキストボックスの中の文字は取り込めません。"
    );
  }
  return conversion;
}

/**
 * 書式表から「見出しの styleId」を引けるようにする。
 *
 * `<w:style w:styleId="a3"><w:name w:val="heading 1"/>…</w:style>` の形から
 * `a3 → 1` を作る。**人が読む名前（`w:name`）で見分ける**——styleId は
 * Word の言語や生い立ちで変わるが、`w:name` は仕様で決まっているので
 * 日本語版で作った文書でも「heading 1」のままである。
 */
export function headingStyleIds(stylesXml: string): Map<string, number> {
  const found = new Map<string, number>();
  /** styleId → 継いでいる書式の styleId（`w:basedOn`） */
  const basedOn = new Map<string, string>();
  let styleId: string | null = null;

  scanXml(stylesXml, {
    open(name, attributes) {
      if (name === "w:style") {
        styleId = attributes["w:styleId"] ?? null;
        return;
      }
      if (!styleId) return;
      // `w:name` は `w:style` の直下にしか無い。ここを見ずに拾うと、
      // 番号書式など別の入れ物の名前まで見出しにしてしまう
      if (name === "w:name") {
        const level = headingLevelOfName(attributes["w:val"] ?? "");
        if (level > 0) found.set(styleId, level);
        return;
      }
      if (name === "w:basedOn") {
        const base = attributes["w:val"];
        if (base) basedOn.set(styleId, base);
      }
    },
    close(name) {
      if (name === "w:style") styleId = null;
    },
    text() {
      // 書式表に本文は無い
    },
  });

  /*
    **継ぎ元を1段だけたどる。** 作者が「My Chapter」のような自前の書式を
    作っても、`Heading1` を継いでいるなら見出しである。

    何段もたどらないのは、深く継いだ書式ほど「見出しから作ったが、
    見た目も役目も別物」になっている見込みが高いため。1段なら
    「見出しに名前を付け直した」という、いちばん多い使い方に当たる。
  */
  for (const [id, base] of basedOn) {
    if (found.has(id)) continue;
    const level = found.get(base) ?? headingLevelOfName(base);
    if (level > 0) found.set(id, level);
  }

  return found;
}

/** 「heading 1」〜「heading 9」なら深さ、そうでなければ 0 */
function headingLevelOfName(value: string): number {
  // 空白の有無・大文字小文字は文書によって揺れる（「Heading1」も見た）
  const matched = /^heading([1-9])$/.exec(value.toLowerCase().replace(/\s+/g, ""));
  return matched ? Number(matched[1]) : 0;
}

/* ────────────────── XML の走査 ────────────────── */

/** 走査が呼び返す先。要素の出入りと文字だけを受け取る */
interface XmlSink {
  open(name: string, attributes: Readonly<Record<string, string>>): void;
  close(name: string): void;
  text(text: string): void;
}

/**
 * XML を頭から舐めて、札と文字を順に渡す。
 *
 * **正しさの検査はしない。** Word が書いた XML を読むだけなので、
 * 閉じ忘れや根の数を咎める意味がない（咎めたところで作者は直せない）。
 * 読めたところまでを本文として返すほうが役に立つ。
 */
function scanXml(source: string, sink: XmlSink): void {
  let index = 0;

  while (index < source.length) {
    const next = source.indexOf("<", index);
    if (next < 0) {
      sink.text(decodeEntities(source.slice(index)));
      return;
    }
    if (next > index) sink.text(decodeEntities(source.slice(index, next)));

    if (source.startsWith("<!--", next)) {
      const end = source.indexOf("-->", next + 4);
      index = end < 0 ? source.length : end + 3;
      continue;
    }
    if (source.startsWith("<![CDATA[", next)) {
      const end = source.indexOf("]]>", next + 9);
      // CDATA の中は実体参照を解かない（そういう約束の入れ物である）
      sink.text(source.slice(next + 9, end < 0 ? source.length : end));
      index = end < 0 ? source.length : end + 3;
      continue;
    }
    if (source.startsWith("<?", next)) {
      const end = source.indexOf("?>", next + 2);
      index = end < 0 ? source.length : end + 2;
      continue;
    }
    if (source.startsWith("<!", next)) {
      const end = source.indexOf(">", next + 1);
      index = end < 0 ? source.length : end + 1;
      continue;
    }
    if (source.startsWith("</", next)) {
      const end = source.indexOf(">", next + 2);
      if (end < 0) return;
      sink.close(source.slice(next + 2, end).trim());
      index = end + 1;
      continue;
    }

    const tag = parseOpenTag(source, next);
    if (!tag) {
      // 本文にそのまま「<」が居た。文字として扱う
      sink.text("<");
      index = next + 1;
      continue;
    }
    sink.open(tag.name, tag.attributes);
    // 空要素（`<w:br/>`）も、出入りの数を合わせるために閉じを流す
    if (tag.selfClosing) sink.close(tag.name);
    index = tag.end;
  }
}

interface OpenTag {
  name: string;
  attributes: Record<string, string>;
  selfClosing: boolean;
  /** この札の次の文字の位置 */
  end: number;
}

const TAG_NAME = /^[A-Za-z_:][\w.:-]*$/;

function parseOpenTag(source: string, start: number): OpenTag | null {
  let index = start + 1;
  const nameStart = index;
  while (index < source.length && !isTagBreak(source[index])) index += 1;
  const name = source.slice(nameStart, index);
  if (!TAG_NAME.test(name)) return null;

  const attributes: Record<string, string> = {};
  while (index < source.length) {
    while (index < source.length && isSpace(source[index])) index += 1;
    if (source.startsWith("/>", index)) {
      return { name, attributes, selfClosing: true, end: index + 2 };
    }
    if (source[index] === ">") {
      return { name, attributes, selfClosing: false, end: index + 1 };
    }

    const attributeStart = index;
    while (index < source.length && !isAttributeBreak(source[index])) {
      index += 1;
    }
    const attributeName = source.slice(attributeStart, index);
    if (!attributeName) {
      // `=` も `/` も名前も無い字。**必ず1つ進める**（進めないと止まらない）
      index += 1;
      continue;
    }

    while (index < source.length && isSpace(source[index])) index += 1;
    if (source[index] !== "=") {
      attributes[attributeName] = "";
      continue;
    }
    index += 1;
    while (index < source.length && isSpace(source[index])) index += 1;

    const quote = source[index];
    if (quote === '"' || quote === "'") {
      const end = source.indexOf(quote, index + 1);
      if (end < 0) return null;
      attributes[attributeName] = decodeEntities(source.slice(index + 1, end));
      index = end + 1;
      continue;
    }
    const valueStart = index;
    while (index < source.length && !isTagBreak(source[index])) index += 1;
    attributes[attributeName] = decodeEntities(source.slice(valueStart, index));
  }
  return null;
}

function isSpace(character: string): boolean {
  return (
    character === " " ||
    character === "\t" ||
    character === "\n" ||
    character === "\r"
  );
}

function isTagBreak(character: string): boolean {
  return isSpace(character) || character === "/" || character === ">";
}

function isAttributeBreak(character: string): boolean {
  return isTagBreak(character) || character === "=";
}

/** 名前で決まっている実体参照。XML はこの5つだけを自前で持つ */
const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

/**
 * 実体参照を文字へ戻す。
 *
 * **知らない名前はそのまま残す。** 消すと本文が減り、当て推量で置き換えると
 * 別の字になる。原稿を扱うときは「分からなければ触らない」が安全である。
 */
function decodeEntities(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(
    /&(#[Xx][0-9A-Fa-f]+|#\d+|[A-Za-z][A-Za-z0-9]*);/g,
    (whole, body: string) => {
      if (body.startsWith("#")) {
        const code = body.startsWith("#x") || body.startsWith("#X")
          ? Number.parseInt(body.slice(2), 16)
          : Number.parseInt(body.slice(1), 10);
        if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return whole;
        // サロゲートの片割れは単体では文字にならない
        if (code >= 0xd800 && code <= 0xdfff) return whole;
        return String.fromCodePoint(code);
      }
      return NAMED_ENTITIES[body] ?? whole;
    }
  );
}

/* ────────────────── 本文の組み立て ────────────────── */

/**
 * XML の空白だけを前後から落とす。
 *
 * **`String.prototype.trim()` は使えない。** JS の `trim()` は全角空白
 * （U+3000）や U+00A0 まで落とすが、Word はそれらを「XMLの空白」とは
 * 見なさないので、全角空白だけの `w:t` に `xml:space="preserve"` を
 * 付けない。`trim()` で済ませると、**日本語の小説の全段落から字下げが
 * 消える**（全角空白だけの run はまるごと消える）。
 *
 * 落としてよいのは、XML を読みやすく折り返した名残——半角空白・タブ・
 * 改行だけである。
 */
function trimXmlSpace(text: string): string {
  return text.replace(/^[ \t\r\n]+/, "").replace(/[ \t\r\n]+$/, "");
}

/** 段落の中の一片。傍点かどうかだけを分けて持つ */
interface Piece {
  text: string;
  emphasized: boolean;
}

/** ルビを組み立てている最中の入れ物 */
interface RubyBuffer {
  base: string;
  reading: string;
  /** いまどちらを読んでいるか */
  part: "base" | "reading" | null;
}

/** 表1つぶん。セル→行の順に畳んでいく */
interface TableBuffer {
  rows: string[];
  cells: string[];
  cellLines: string[];
}

/** 表のセルの区切り。**行を1行の文字にほどく**ときに挟む */
const CELL_SEPARATOR = "　";

/** `w:tab` の代わり。全角空白1つ（字下げに使われることが多い） */
const TAB_TEXT = "　";

/**
 * Markdown の `#` にする、いちばん深い見出し。
 *
 * これより深い見出し（`heading 4` 以降）は地の文にする——小説の原稿で
 * `####` が並んでも読み手の助けにならないうえ、**落とさずに文字は残す**
 * ので原稿は減らない。何段落そうしたかは `skipped` で伝える。
 */
const DEEPEST_HEADING = 3;

/**
 * 中身を持ち込まない要素（画像・図形）。
 *
 * **中の文字ごと落とす。** 図形（`w:drawing`）の中にはテキストボックスが
 * あり得て、そこの説明文を本文へ混ぜると地の文の途中へ割り込む。
 */
const DROPPED_ELEMENTS = new Set(["w:drawing", "w:pict", "w:object"]);

/**
 * 黙って落とす要素（**画像として数えない**）。
 *
 * Word は図形を `<mc:AlternateContent>` で包み、新しい形（`mc:Choice` の
 * 中の `w:drawing`）と古い形（`mc:Fallback` の中の `w:pict`）を**両方**
 * 書く。中だけを見ていると1枚の絵が「画像 2件」になるので、**古いほうの
 * 箱だけを落とす**。
 *
 * **箱（`mc:AlternateContent`）ごと落としてはいけない。** `mc:Choice` に
 * 入るのは図形だけではなく、新しい版の Word で書いた**本文**もここへ
 * 入る。箱ごと落とすと、その本文が丸ごと消える。
 */
const IGNORED_ELEMENTS = new Set(["mc:Fallback"]);

/** 走査を受けて Markdown を組み立てる */
class DocumentBuilder implements XmlSink {
  private readonly stack: string[] = [];
  private readonly lines: string[] = [];
  private readonly tables: TableBuffer[] = [];

  /** 落とす要素に入ったときの深さ。抜けたら null に戻す */
  private droppedDepth: number | null = null;

  /** いま組み立てている段落。段落の外なら null */
  private pieces: Piece[] | null = null;
  private headingLevel = 0;

  /** いまの run に傍点が付いているか */
  private emphasized = false;
  private ruby: RubyBuffer | null = null;

  /** `w:t` の中身を溜める場所。外なら null */
  private capture: { text: string; preserve: boolean } | null = null;

  private rubyCount = 0;
  private emphasisCount = 0;
  private images = 0;
  private tableCount = 0;
  private footnotes = 0;
  private comments = 0;
  /** `#` にせず地の文にした、深い見出し（`heading 4` 以降）の段落数 */
  private deepHeadings = 0;
  /** 本文に `{` `}` `|` が居たか（記法の印と紛れる） */
  private notationClash = false;

  /**
   * @param headingStyles `word/styles.xml` から引いた styleId → 見出しの深さ。
   *   空でもよい（そのときは `Heading1` のような名前だけが頼りになる）
   */
  constructor(private readonly headingStyles: ReadonlyMap<string, number>) {}

  open(name: string, attributes: Readonly<Record<string, string>>): void {
    const parent = this.stack[this.stack.length - 1];
    const grandParent = this.stack[this.stack.length - 2];
    this.stack.push(name);
    if (this.droppedDepth !== null) return;

    if (DROPPED_ELEMENTS.has(name)) {
      this.images += 1;
      this.droppedDepth = this.stack.length;
      return;
    }
    if (IGNORED_ELEMENTS.has(name)) {
      this.droppedDepth = this.stack.length;
      return;
    }

    switch (name) {
      case "w:p":
        this.pieces = [];
        this.headingLevel = 0;
        break;
      case "w:pStyle":
        if (parent === "w:pPr") {
          const styleId = attributes["w:val"] ?? "";
          // **書式表を先に引く。** styleId は文書ごとに違う機械名でありうる
          // ので、名前（`Heading1`）で当たるほうは最後の頼りにする
          this.headingLevel =
            this.headingStyles.get(styleId) ?? headingLevelOfName(styleId);
        }
        break;
      case "w:r":
        this.emphasized = false;
        break;
      case "w:em":
        // **`w:rPr` が run の直下にあるときだけ。** `w:pPr` の中の
        // `w:rPr` は段落記号の書式で、本文の文字ではない
        if (parent === "w:rPr" && grandParent === "w:r") {
          /*
            **圏点は「none 以外」を全部ひろう**（本体の裁定、2026-09-06）。

            Word の圏点は dot（・）・comma（、）・circle（○）・underDot
            （下側の・）の4つがあり、日本語の原稿では「、」もよく使われる。
            種類ごとの印は `{{ }}` ひとつしか無いので、どれも傍点として
            持ち帰る——形は選び直せるが、**落ちた傍点は取り戻せない。**

            `w:val` が無いときは仕様上の既定が none なので、傍点にしない。
          */
          this.emphasized = (attributes["w:val"] ?? "none") !== "none";
        }
        break;
      case "w:t":
        this.capture = {
          text: "",
          preserve: attributes["xml:space"] === "preserve",
        };
        break;
      case "w:br":
        // **改ページは何も足さない。** 紙の都合であって、原稿の改行では
        // ない（章の変わり目に入れた改ページが空行になると、段落の切れ目
        // が1つ増える）
        if (attributes["w:type"] === "page") break;
        this.append("\n", false);
        break;
      case "w:cr":
        // `w:cr` は `w:br` と同じ改行。片方だけ見ていると改行が落ちる
        this.append("\n", false);
        break;
      case "w:tab":
        this.append(TAB_TEXT, false);
        break;
      case "w:ruby":
        this.ruby = { base: "", reading: "", part: null };
        break;
      case "w:rt":
        if (this.ruby) this.ruby.part = "reading";
        break;
      case "w:rubyBase":
        if (this.ruby) this.ruby.part = "base";
        break;
      case "w:tbl":
        this.tableCount += 1;
        this.tables.push({ rows: [], cells: [], cellLines: [] });
        break;
      case "w:tc":
        this.currentTable()?.cellLines.splice(0);
        break;
      case "w:footnoteReference":
      case "w:endnoteReference":
        this.footnotes += 1;
        break;
      case "w:commentReference":
        this.comments += 1;
        break;
      default:
        break;
    }
  }

  close(name: string): void {
    this.stack.pop();
    if (this.droppedDepth !== null) {
      if (this.stack.length < this.droppedDepth) this.droppedDepth = null;
      return;
    }

    switch (name) {
      case "w:t":
        this.flushCapture();
        break;
      case "w:r":
        this.emphasized = false;
        break;
      case "w:rt":
      case "w:rubyBase":
        if (this.ruby) this.ruby.part = null;
        break;
      case "w:ruby":
        this.flushRuby();
        break;
      case "w:p":
        this.flushParagraph();
        break;
      case "w:tc": {
        const table = this.currentTable();
        if (table) {
          // **セルの中の改行も区切りへ畳む。** 表は1行の文字にほどく
          // ので、`w:br` の改行をそのまま残すと表の1行が途中で割れて、
          // 次の行の頭が本文の途中のように見える
          table.cells.push(
            table.cellLines.join(CELL_SEPARATOR).replace(/\n/g, CELL_SEPARATOR)
          );
          table.cellLines.splice(0);
        }
        break;
      }
      case "w:tr": {
        const table = this.currentTable();
        if (table) {
          table.rows.push(table.cells.join(CELL_SEPARATOR));
          table.cells.splice(0);
        }
        break;
      }
      case "w:tbl": {
        const table = this.tables.pop();
        // 畳んだ行は、外側（入れ子ならその親のセル）へ流す
        if (table) for (const row of table.rows) this.emit(row);
        break;
      }
      default:
        break;
    }
  }

  text(text: string): void {
    if (this.droppedDepth !== null || !this.capture) return;
    this.capture.text += text;
  }

  finish(): DocxConversion {
    // 走査の途中で終わっても、書きかけの段落は落とさない
    if (this.pieces) this.flushParagraph();

    const lines = [...this.lines];
    /*
      末尾の空段落は落とす。Word の文書はたいてい空の段落で終わる。

      **中身が改行だけの段落も空とみなす**（`<w:p><w:br/></w:p>` で
      終わる文書がある）。「空文字かどうか」だけで見ていると、この行が
      残って末尾に空行が2つ並ぶ。全角空白だけの段落は**残す**——作者が
      置いた字であって、飾りの空白ではない
    */
    while (lines.length > 0 && !trimXmlSpace(lines[lines.length - 1])) {
      lines.pop();
    }

    const skipped: string[] = [];
    if (this.images > 0) {
      skipped.push(`画像 ${this.images}件（.md には入りません）`);
    }
    if (this.tableCount > 0) {
      skipped.push(`表 ${this.tableCount}件（行ごとの文字にほどきました）`);
    }
    if (this.footnotes > 0) {
      skipped.push(`脚注 ${this.footnotes}件（.md には入りません）`);
    }
    if (this.comments > 0) {
      skipped.push(`コメント ${this.comments}件（.md には入りません）`);
    }
    if (this.deepHeadings > 0) {
      skipped.push(`見出し4以下は地の文にしました ${this.deepHeadings}段落`);
    }
    if (this.notationClash) {
      skipped.push(
        "本文に { } | があるため記法と紛れる可能性があります（本文はそのままにしてあります）"
      );
    }

    return {
      markdown: lines.length > 0 ? `${lines.join("\n")}\n` : "",
      rubyCount: this.rubyCount,
      emphasisCount: this.emphasisCount,
      skipped,
    };
  }

  private currentTable(): TableBuffer | undefined {
    return this.tables[this.tables.length - 1];
  }

  /**
   * `w:t` の中身を、行き先へ流す。
   *
   * **印（`xml:space="preserve"`）が無ければ前後の空白を落とす**——
   * OOXML の決まりで、印のない `w:t` の前後の空白は飾りである
   * （XMLを読みやすく折り返した名残が本文へ混ざる）。
   */
  private flushCapture(): void {
    const capture = this.capture;
    this.capture = null;
    if (!capture) return;
    const text = capture.preserve ? capture.text : trimXmlSpace(capture.text);
    if (!text) return;

    // 記法の印と紛れる字は、**本文の文字のときだけ**数える
    // （こちらが足す `{` `|` `}` は当然ぶつからない）
    if (/[{}|]/.test(text)) this.notationClash = true;

    if (this.ruby && this.ruby.part === "reading") {
      this.ruby.reading += text;
      return;
    }
    if (this.ruby && this.ruby.part === "base") {
      this.ruby.base += text;
      return;
    }
    this.append(text, this.emphasized);
  }

  /** ルビを1つ、この拡張機能の記法へ */
  private flushRuby(): void {
    const ruby = this.ruby;
    this.ruby = null;
    if (!ruby || !ruby.base) return;
    if (!ruby.reading) {
      // 読みが無いなら、ただの文字。**親文字は落とさない**
      this.append(ruby.base, false);
      return;
    }
    this.rubyCount += 1;
    // ルビの印は傍点で包まない（`{{...}}` の中に `{...|...}` を入れない）
    this.append(`{${ruby.base}|${ruby.reading}}`, false);
  }

  private append(text: string, emphasized: boolean): void {
    if (!this.pieces || !text) return;
    this.pieces.push({ text, emphasized });
  }

  /** 段落1つを1行にして、行の置き場（本文か表のセル）へ */
  private flushParagraph(): void {
    const pieces = this.pieces;
    this.pieces = null;
    const level = this.headingLevel;
    this.headingLevel = 0;
    if (!pieces) return;

    const text = this.render(pieces);
    if (level > 0 && text) {
      if (level > DEEPEST_HEADING) {
        // **文字は落とさず、地の文にする。** 数えておいて、あとで
        // 「そうした」と伝える（黙って格を下げたことにしない）
        this.deepHeadings += 1;
        this.emit(text);
        return;
      }
      this.emit(`${"#".repeat(level)} ${text}`);
      return;
    }
    this.emit(text);
  }

  /**
   * 一片を1行の文字へ。
   *
   * **続いた傍点はまとめる。** Word は書式が同じでも run を割ることが
   * あり（校閲の印・言語の指定などで切れる）、そのまま出すと
   * `{{大}}{{事}}` になって、投稿サイトでは傍点が2つの塊に見える。
   */
  private render(pieces: readonly Piece[]): string {
    let out = "";
    let index = 0;
    while (index < pieces.length) {
      if (!pieces[index].emphasized) {
        out += pieces[index].text;
        index += 1;
        continue;
      }
      let group = "";
      while (index < pieces.length && pieces[index].emphasized) {
        group += pieces[index].text;
        index += 1;
      }
      if (!group) continue;
      this.emphasisCount += 1;
      out += `{{${group}}}`;
    }
    return out;
  }

  /** 1行を置く。表の中なら、そのセルへ溜める */
  private emit(line: string): void {
    const table = this.currentTable();
    if (table) table.cellLines.push(line);
    else this.lines.push(line);
  }
}
