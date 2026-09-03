import {
  escapeHtml,
  tokenizeLine,
  type NotationMode,
} from "./manuscriptRender";
import { stripMemoLines } from "./sceneMemo";

/**
 * 話1つぶんの XHTML を組む（設計書6.65.4の第1段。挿絵とページ分割は6.65.10）。
 *
 * ## HTMLではなくXML
 *
 * EPUBの中身は**XHTML＝XML**である。ブラウザのHTMLパーサは閉じ忘れも
 * 裸の `&` も勝手に直してくれるが、**リーダーのXMLパーサは本ごと開くのを
 * やめる**。だからここは、
 *
 *   - 空要素を自分で閉じる（`<br />`）
 *   - 本文も見出しも属性値も、必ず `escapeXml` を通す
 *
 * の2つを守る。
 *
 * ## ルビと傍点は `ruby.ts` の `rubyToHtml` を使っていない
 *
 * **`rubyToHtml` は記法の外側を素通しする**（プレビュー用で、呼ぶ側が
 * 逃がし済みであることを前提にしていない）。本文に `A & B` と書いてあれば
 * `&` がそのまま出て、XMLとして開けない本になる。かといって先に逃がすと、
 * ルビの中身が二重に逃げる（`&amp;` → `&amp;amp;`）。
 *
 * そこでPDF出力（`printHtml.ts`）と同じ手を採る——記法の切り分け
 * （`manuscriptRender.ts` の `tokenizeLine`）を借りて、**平文・ルビ・傍点の
 * どれも `escapeXml` を通してから**組み立てる。記法の定義は増やさない。
 * `.md`（`{漢字|かんじ}`）と `.txt`（`｜漢字《かんじ》`）の両方を扱えるのも、
 * この経路の利点である。
 *
 * ここは vscode に触らないので単体テストできる。ZIPへ詰めるのは
 * `epubPackage.ts`、ファイルの書き出しは `features/exportEpub.ts` が行う。
 */

/**
 * XMLの中で使ってはいけない文字を逃がす。
 *
 * **定義を増やさない**ので、記号の逃がしは `manuscriptRender.ts` のものを
 * そのまま使う。`'` は逃がさないが、XMLの本文でも二重引用符で囲んだ属性値
 * でも生のままで正しい（属性は必ず `"` で囲む）。
 *
 * ## 制御文字は落とす
 *
 * XML 1.0 は U+0009（タブ）・U+000A（改行）・U+000D（復帰）**以外**のC0
 * 制御文字を、文書のどこにも置けないと定めている——実体参照（`&#12;`）に
 * しても駄目である。ワープロや変換ソフトが混ぜたフォームフィード**1文字で
 * 本ごと開けなくなる**。
 *
 * **逃がしの入口で落とす**ので、本文・見出し・題名・人名・解説文・属性値の
 * どれにも効く（この関数を通らない道を作らないこと）。置換ではなく除去に
 * するのは、見えない字を「?」のような見える字へ化けさせないためである。
 */
export function escapeXml(value: string): string {
  return escapeHtml(value.replace(FORBIDDEN_CONTROL_CHARS, ""));
}

/**
 * XMLに書けないC0制御文字（U+0000〜0008・000B・000C・000E〜001F）。
 *
 * **文字そのものをソースへ書かない。** 生の制御文字を置くと git や grep が
 * ファイルをバイナリ扱いする（CLAUDE.mdの約束）ので、**文字番号から
 * 組み立てる**。
 */
function buildForbiddenControlChars(): RegExp {
  const chars: string[] = [];
  for (let code = 0x00; code <= 0x1f; code++) {
    // タブ・改行・復帰の3つだけは、XMLに書いてよい
    if (code === 0x09 || code === 0x0a || code === 0x0d) continue;
    chars.push(String.fromCharCode(code));
  }
  // どれも正規表現の特別な字ではないので、そのまま文字の並びにしてよい
  return new RegExp(`[${chars.join("")}]`, "g");
}

const FORBIDDEN_CONTROL_CHARS = buildForbiddenControlChars();

/**
 * 半角の縦中横（設計書6.65.15の2）。
 *
 * 縦書きの本で、半角の数字・「!」「?」が1〜3文字だけ連続していたら
 * `<span class="tcy">` で包む。CSS側（`epubPackage.ts` の `buildEpubCss`）
 * が `text-combine-upright: all` を当て、縦の行の中で横向きに寝かせず
 * 1文字ぶんの幅へ収める。**4文字以上は従来どおり横倒しのまま**——3文字を
 * 超えると1文字ぶんに収まらず、かえって読みにくくなる。
 *
 * **`escapeXml` のあとの、エスケープ済みの文字列に対して行う。** 逃がす前の
 * 生の文字列に対してだと、`&`（`&amp;`になる文字そのもの）を巻き込んで
 * 壊れたタグを作りかねない。
 *
 * 数値実体参照（`&#8230;` のような、逃がした `&amp;` の直後に `#` と数字が
 * 続く形）の中の数字は包まない。**直前が `&` か `#` の数字run**は対象から
 * 外す——包むと、実体参照の意味を持つ数字の並びが縦中横のspanで割れて
 * リーダーによっては元の記号として読めなくなる。
 */
export function applyTateChuYoko(escaped: string): string {
  return escaped.replace(
    /[0-9!?]+/g,
    (run: string, offset: number, whole: string) => {
      if (run.length > 3) return run;
      const before = offset > 0 ? whole[offset - 1] : "";
      if (before === "&" || before === "#") return run;
      return `<span class="tcy">${run}</span>`;
    }
  );
}

/**
 * 逃がし済みの文字列を、縦書きのときだけ縦中横まで通す。
 *
 * **テキストノードだけに使う。** `href`・`alt` のような属性値へ通すと
 * `<span>` がそのまま値の中の文字列として入り、属性が壊れる。
 */
export function escapeDisplayText(value: string, vertical: boolean): string {
  const escaped = escapeXml(value);
  return vertical ? applyTateChuYoko(escaped) : escaped;
}

export interface EpubChapterSource {
  /** 話の見出し。**呼び出し側が組む**（`episodeLabel.ts` の作り方に合わせる） */
  heading: string;
  body: string;
  /** その話の記法。`.md` は `curly`、`.txt` は `site`（`notationModeFor`） */
  notation: NotationMode;
}

/**
 * 挿絵1つの置き場所（設計書6.65.10）。
 *
 * `href` は**呼び出し側が決める**——本ではZIPの中の機械名
 * （`illust-1.png`）、画面では `asWebviewUri` のURIになる。ここは
 * 「どこに置くか」だけを知っていればよい。
 */
export interface EpubIllustrationPlacement {
  /** 第M段落のあと（詰める前の段落番号。`countParagraphs` の数え方） */
  afterParagraph: number;
  href: string;
  /** 解説文。空なら `<figcaption>` を出さない */
  caption: string;
}

export interface EpubBodyOptions {
  /** 続いた空行を1つ減らすか（下の `renderBody` の説明を参照） */
  collapseBlankLines: boolean;
  /** 本文へ挟む挿絵。無ければ、いままでと同じ本文が出る */
  illustrations?: readonly EpubIllustrationPlacement[];
  /** 改ページの位置（第M段落のあと）。次の段落にクラスが付く */
  pageBreaks?: readonly number[];
  /**
   * 改ページの位置に、見える印を置くか（**プレビューのときだけ true**）。
   *
   * 画面は1枚の面なので実際には割れない。何も見えないと「指定が効いて
   * いない」と読めてしまうので、印だけ置く（設計書6.65.10）。
   */
  markPageBreaks?: boolean;
  /**
   * 縦書きか（設計書6.65.15）。**省略時は false**（横書きと同じ扱い）。
   *
   * 半角の数字・「!」「?」の縦中横（`applyTateChuYoko`）は縦書きのときだけ
   * 効く。横書きの本で寝かせると、かえって読みにくくなる。
   */
  vertical?: boolean;
}

/** 位置指定の種類。知らせの言い方をここで分ける */
export type EpubPlacementKind = "illustration" | "pageBreak";

/** 段落数を超えていた位置。**黙って捨てない**ための報せ（設計書6.65.10） */
export interface EpubPlacementOverflow {
  kind: EpubPlacementKind;
  /** 指定されていた段落番号（言い直さずそのまま返す） */
  afterParagraph: number;
}

export interface EpubChapterPlacement {
  html: string;
  /** その話の段落数（詰める前の数え方） */
  paragraphCount: number;
  overflow: EpubPlacementOverflow[];
}

export interface EpubChapterOptions extends EpubBodyOptions {
  /** その話のXHTMLから見たCSSの場所 */
  cssHref: string;
  /** 縦書きか。`<body>` の目印だけを変え、体裁はCSSが決める */
  vertical: boolean;
  /** `<html xml:lang>`。既定は日本語 */
  language?: string;
}

/** 話1つぶんの断片（`<section>` ごと）。文書の枠は付かない */
export function buildChapterFragment(
  chapter: EpubChapterSource,
  options: EpubBodyOptions
): string {
  return buildChapterPlacement(chapter, options).html;
}

/**
 * 断片と、置けなかった指定（設計書6.65.10）。
 *
 * **超過は例外にしない。** 原稿を書き足したり削ったりすれば位置はずれる。
 * そこで本が出なくなるより、末尾へ置いて「ずれている」と伝えるほうがよい
 * ——ただし黙って捨てもしない。呼び出し側（書き出し・エディター画面）が
 * `overflow` を受け取って作者へ見せる。
 */
export function buildChapterPlacement(
  chapter: EpubChapterSource,
  options: EpubBodyOptions
): EpubChapterPlacement {
  const vertical = options.vertical ?? false;
  const heading = chapter.heading.trim();
  const body = renderBody(chapter.body, chapter.notation, options);
  return {
    html: [
      '<section class="chapter">',
      ...(heading
        ? [
            `<h2 class="chapter-heading">${escapeDisplayText(
              heading,
              vertical
            )}</h2>`,
          ]
        : []),
      ...body.lines,
      "</section>",
    ].join("\n"),
    paragraphCount: body.paragraphCount,
    overflow: body.overflow,
  };
}

/**
 * 位置が本文より後ろだったときの言い方（設計書6.65.10）。
 *
 * **書き出しと画面で同じ文にする。** 別々に書くと、片方だけ直したときに
 * 「同じ状態なのに言うことが違う」ことになる。
 */
export function describePlacementOverflow(
  heading: string,
  overflow: EpubPlacementOverflow
): string {
  const what = overflow.kind === "illustration" ? "挿絵" : "改ページ";
  const head = `${heading.trim() || "この話"}の${what}の位置（第${
    overflow.afterParagraph
  }段落）が本文より後ろです。`;
  // 挿絵は末尾へ入るが、改ページは末尾に置いても割る先が無い。
  // **結果が違うので、言い方も分ける**
  return overflow.kind === "illustration"
    ? `${head}末尾に置きました。`
    : `${head}末尾なので、改ページは入りません。`;
}

/**
 * 画像が見つからない挿絵の言い方（設計書6.65.10）。
 *
 * **画面でも書き出しでも起きることは同じ**（その挿絵は本に入らない）なので、
 * 言い方を1か所に置く。位置の超過（末尾には入る）と違い、こちらは1枚
 * まるごと入らないので、そう言い切る。
 */
export function describeMissingIllustrationImage(imagePath: string): string {
  return (
    `挿絵の画像「${imagePath}」が見つかりません。` +
    "この挿絵は本に入りません。"
  );
}

/**
 * 競合で本から外れた話に置かれていた指定の言い方（設計書6.65.10）。
 *
 * 未解決の競合を含む話は本から外れる。**その話に付けた挿絵・改ページも
 * 一緒に消える**のに、外れたことしか伝えていなかった（挿絵が入らない理由が
 * 作者に分からない）。指定が無ければ null を返す——言うことが無いのに
 * 「0件も入っていません」と伝えても、読む手間が増えるだけである。
 */
export function describeDroppedPlacements(
  heading: string,
  counts: { illustrations: number; pageBreaks: number }
): string | null {
  const parts: string[] = [];
  if (counts.illustrations > 0) parts.push(`挿絵${counts.illustrations}件`);
  if (counts.pageBreaks > 0) parts.push(`改ページ${counts.pageBreaks}件`);
  if (parts.length === 0) return null;

  return (
    `競合の印がある${heading.trim() || "この話"}は本から外れたため、` +
    `${parts.join("・")}も入っていません。`
  );
}

/**
 * その話に属する指定だけを選ぶ（設計書6.65.10）。
 *
 * **突き合わせは相対パスの一致だけ。** 話を改題・移動すると、指定は
 * どの話にも選ばれなくなる——つまり**本には入らない**。入らなかった
 * ことは `missingEpisodeNotices` が伝える（黙って消さない）。
 *
 * 書き出しと画面が同じ規則を使うために、ここに1つだけ置く。
 */
export function placementsIn<T extends { episodePath: string }>(
  items: readonly T[],
  episodePath: string
): T[] {
  return items.filter((item) => item.episodePath === episodePath);
}

/**
 * 指し先の話が見つからない指定への知らせ（設計書6.65.10）。
 *
 * **改題・移動で必ず起きる。** 位置の超過と違って末尾へ置くこともできない
 * （入る先の話そのものが無い）ので、入らなかったことをそのまま伝える。
 *
 * **文にはパスを入れる。** 「見つかりません」だけでは何を直せばよいのか
 * 分からないが、`本文/第3話.txt` と出れば作者は「あれを改題したからだ」と
 * 辿れる。
 *
 * 同じ話への指定が何件あっても**言うのは1度**である（同じ文が3つ並んでも、
 * 作者に伝わるものは増えない）。
 */
export function missingEpisodeNotices(
  knownEpisodePaths: Iterable<string>,
  placements: {
    illustrations: readonly { episodePath: string }[];
    pageBreaks: readonly { episodePath: string }[];
  }
): string[] {
  const known = new Set(knownEpisodePaths);
  const notes: string[] = [];
  const said = new Set<string>();

  const check = (kind: EpubPlacementKind, episodePath: string): void => {
    if (known.has(episodePath)) return;
    const key = `${kind}|${episodePath}`;
    if (said.has(key)) return;
    said.add(key);
    notes.push(describeMissingEpisode(episodePath, kind));
  };

  for (const item of placements.illustrations) {
    check("illustration", item.episodePath);
  }
  for (const item of placements.pageBreaks) check("pageBreak", item.episodePath);
  return notes;
}

/** 見つからない話の言い方。**書き出しと画面で同じ文にする** */
export function describeMissingEpisode(
  episodePath: string,
  kind: EpubPlacementKind
): string {
  const what = kind === "illustration" ? "挿絵" : "改ページ";
  return (
    `${what}の指定した話（${episodePath}）が見つかりません。` +
    `この${what}は入れませんでした（改題・移動をしていないか確かめてください）。`
  );
}

/** 話1つぶんのXHTML文書。EPUBの中では、これが1つで1つの改ページになる */
export function buildChapterXhtml(
  chapter: EpubChapterSource,
  options: EpubChapterOptions
): string {
  return buildXhtmlDocument({
    // 目次から飛んだときにタブや履歴へ出るので、話の見出しを入れる
    title: chapter.heading.trim(),
    cssHref: options.cssHref,
    vertical: options.vertical,
    language: options.language,
    body: buildChapterFragment(chapter, options),
  });
}

export interface EpubDocumentInput {
  title: string;
  cssHref: string;
  vertical: boolean;
  language?: string;
  /** `<body>` の中身。呼び出し側が逃がし済みであること */
  body: string;
}

/**
 * XHTML文書の枠。表紙・目次・奥付・本文で共用する。
 *
 * **`xmlns:epub` を必ず宣言する。** 目次（`nav.xhtml`）が `epub:type` を
 * 使うので、宣言が無いとXMLとして開けない。1か所で書いておけば、
 * 面を増やすたびに忘れることがない。
 */
export function buildXhtmlDocument(input: EpubDocumentInput): string {
  const language = input.language ?? "ja";
  const bodyClass = input.vertical ? "vertical" : "horizontal";
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<!DOCTYPE html>",
    '<html xmlns="http://www.w3.org/1999/xhtml"' +
      ' xmlns:epub="http://www.idpf.org/2007/ops"' +
      ` xml:lang="${escapeXml(language)}" lang="${escapeXml(language)}">`,
    "<head>",
    '<meta charset="utf-8" />',
    `<title>${escapeXml(input.title || "無題")}</title>`,
    `<link rel="stylesheet" type="text/css" href="${escapeXml(
      input.cssHref
    )}" />`,
    "</head>",
    `<body class="${bodyClass}">`,
    input.body,
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

/**
 * 本文を「段落」へ割る（設計書6.65.10の数え方）。
 *
 * **空行で区切った塊が1段落**である。挿絵とページ分割の位置指定は、この
 * 番号（1始まり）で書かれる。
 *
 * ## なぜ「詰める前」で数えるのか
 *
 * `collapseBlankLines` は書き出し時の変換であって、原稿の見た目ではない。
 * 詰めたあとの `<p>` を数えると、**設定を切り替えたとたんに挿絵が別の
 * 場面へ移る**。作者が画面で見ている原稿の塊で数えれば、そのずれは起きない。
 *
 * シーンメモの行は本へ入らない（`stripMemoLines`）ので、**数にも入れない**。
 * ここと本文の組み立てで数え方が違うと、指定した段落と入る場所がずれる。
 */
export function splitParagraphs(body: string): string[] {
  const paragraphs: string[] = [];
  let current: string[] = [];

  for (const line of normalizedLines(body)) {
    if (line.trim() === "") {
      if (current.length > 0) paragraphs.push(current.join("\n"));
      current = [];
      continue;
    }
    current.push(line);
  }
  if (current.length > 0) paragraphs.push(current.join("\n"));

  return paragraphs;
}

/** その話の段落数。位置が本文より後ろかを見るのに使う */
export function countParagraphs(body: string): number {
  return splitParagraphs(body).length;
}

/** シーンメモを落とし、改行コードを揃えた行 */
function normalizedLines(body: string): string[] {
  // **シーンメモは本へ入れない**（設計書6.40.2）。作者の付箋であって
  // 読者へ渡す文章ではない。行ごと落とす——空行にすると、そこに
  // 段落の空きが生まれて場面が切れたように読める
  return stripMemoLines(body).replace(/\r\n?/g, "\n").split("\n");
}

/**
 * 本文を段落へ割る。
 *
 * **1行が1つの `<p>`** である（小説の本文は行の途中で折り返さない）。
 * ただし挿絵・改ページの位置を数える「段落」は上の `splitParagraphs` で、
 * **空行で区切った塊**である（続いた行は1段落）。
 *
 * ## 空行の詰め方
 *
 * 設計書6.65.2の「改行が2つ並んでいたら1つに」を、そのまま一般化する
 * ——**続いた空行は1つ減る**。
 *
 * | 元 | `collapseBlankLines: true` |
 * |---|---|
 * | 空行1つ（改行2連続） | 0（消える） |
 * | 空行2つ（改行3連続） | 1 |
 * | 空行3つ | 2 |
 *
 * Webの作法である「段落ごとに1行空ける」がちょうど消え、作者が意図して
 * 広く空けた場面転換は空きとして残る。**全部消すと場面の切り替わりが
 * 消え、そのまま残すと本にしたとき隙間だらけになる**ので、その間を採った。
 *
 * 本文の前後の空行は、詰める設定に関わらず落とす。話の頭に空きが入ると、
 * 見出しから本文までの間が話ごとに不揃いになる。
 *
 * **改ページの位置では、直前の空行を出さない**（設計書6.65.10）。改ページ
 * そのものが場面の区切りなので空きの用が無く、残すと前の面の末尾に空白の
 * 行だけが積まれる（読者からは「本文が終わったのに白紙が続く」と見える）。
 */
function renderBody(
  body: string,
  notation: NotationMode,
  options: EpubBodyOptions
): { lines: string[]; paragraphCount: number; overflow: EpubPlacementOverflow[] } {
  const vertical = options.vertical ?? false;
  const lines = normalizedLines(body);
  // 位置は1以上の整数（`models/book.ts` が保証する）。それでも念のため
  // 揃えておく——0や小数が届いても、挿絵を黙って落とさないため
  const illustrations = (options.illustrations ?? []).map((item) => ({
    ...item,
    afterParagraph: positionOf(item.afterParagraph),
  }));
  const pageBreaks = (options.pageBreaks ?? []).map(positionOf);

  const out: string[] = [];
  let blanks = 0;
  let paragraph = 0;
  /** いま段落（空行で区切った塊）の中にいるか */
  let inParagraph = false;
  /** 次に出てくる段落の頭へ、改ページのクラスを付けるか */
  let pendingBreak = false;

  /** 段落の切れ目。ここで「第M段落のあと」の指定を消化する */
  const closeParagraph = (): void => {
    for (const item of illustrations) {
      if (item.afterParagraph === paragraph) {
        out.push(figureFragment(item, vertical));
      }
    }
    if (pageBreaks.includes(paragraph)) {
      if (options.markPageBreaks) out.push(PAGE_BREAK_MARK);
      pendingBreak = true;
    }
  };

  for (const line of lines) {
    if (line.trim() === "") {
      if (inParagraph) closeParagraph();
      inParagraph = false;
      blanks++;
      continue;
    }

    const starts = !inParagraph;
    if (starts) {
      paragraph++;
      inParagraph = true;
    }
    // 先頭の空行（out が空）は捨てる。**改ページの直前の空行も出さない**
    // ——改ページが場面の区切りなので、前の面の末尾に空きは要らない
    if (out.length > 0 && !pendingBreak) {
      const keep = options.collapseBlankLines ? Math.max(0, blanks - 1) : blanks;
      for (let i = 0; i < keep; i++) out.push(BLANK_PARAGRAPH);
    }
    blanks = 0;

    // 改ページは**次の段落の頭**に付く。空きの段落へ付けると、割れた先が
    // 空行から始まる（設計書6.65.10）
    const marked = starts && pendingBreak;
    if (marked) pendingBreak = false;
    out.push(
      `<p${marked ? ` class="${PAGE_BREAK_CLASS}"` : ""}>${renderInline(
        line,
        notation,
        vertical
      )}</p>`
    );
  }
  if (inParagraph) closeParagraph();

  // **本文より後ろの指定は、末尾へ置いて報せる**（設計書6.65.10）。
  // 原稿を削れば位置はずれる。そこで本が出なくなるより、ずれたことが
  // 分かるほうがよい——ただし黙って捨てない
  const overflow: EpubPlacementOverflow[] = [];
  for (const item of illustrations) {
    if (item.afterParagraph <= paragraph) continue;
    out.push(figureFragment(item, vertical));
    overflow.push({
      kind: "illustration",
      afterParagraph: item.afterParagraph,
    });
  }
  for (const at of pageBreaks) {
    // 末尾のあとには段落が無いので、改ページそのものは入らない
    if (at > paragraph) overflow.push({ kind: "pageBreak", afterParagraph: at });
  }

  // 末尾に残った空行は捨てる（最後の頁に空の段落を並べない）
  return { lines: out, paragraphCount: paragraph, overflow };
}

/** 届いた位置を1以上の整数へ。**丸めても挿絵は落とさない** */
function positionOf(value: number): number {
  return Math.max(1, Math.round(value));
}

/**
 * 挿絵1枚（設計書6.65.10）。
 *
 * **解説文は画像に重ねず、`<figcaption>` として直後に添える。** EPUBの
 * リフロー画面では絶対配置の重ね書きがリーダーごとに崩れる（Kindleは特に）。
 * 解説文が無ければ `figcaption` そのものを出さない——空の要素は
 * 「説明が無い」ではなく「空の説明がある」という主張になる。
 */
function figureFragment(
  item: EpubIllustrationPlacement,
  vertical: boolean
): string {
  const caption = item.caption.trim();
  return [
    '<figure class="illustration">',
    // 代替文は解説文があればそれを使う。無ければ「挿絵」——空の alt は
    // 「飾りなので読み上げなくてよい」の意味になってしまう。
    // **属性値なので縦中横は通さない**（span を挟むと属性が壊れる）
    `<img src="${escapeXml(item.href)}" alt="${escapeXml(
      caption || "挿絵"
    )}" />`,
    ...(caption
      ? [`<figcaption>${escapeDisplayText(caption, vertical)}</figcaption>`]
      : []),
    "</figure>",
  ].join("\n");
}

/** 改ページのクラス。体裁（`break-before`）は `epubPackage.ts` のCSSが持つ */
const PAGE_BREAK_CLASS = "page-break";

/**
 * プレビューにだけ置く、改ページの印。
 *
 * 画面は1枚の面なので実際には割れない。**本には入らない**（`markPageBreaks`
 * を立てたときだけ出る）。
 */
const PAGE_BREAK_MARK =
  '<div class="page-break-mark"><span>ここで改ページ</span></div>';

/**
 * 空きの段落。
 *
 * **中身の無い `<p></p>` にしない。** リーダーによっては高さ0に潰れて、
 * 場面の切り替わりが消える。`<br />` を1つ入れておけば1行ぶん空く。
 */
const BLANK_PARAGRAPH = '<p class="blank"><br /></p>';

/**
 * 1行を、ルビ・傍点・平文へ組む。
 *
 * **どの経路も `escapeXml` を通る。** ここを1つでも抜かすと、本文に
 * 書いた記号がタグとして読まれ、XMLとして開けない本になる。
 *
 * **縦書きのときは、続けて縦中横も通す**（`escapeDisplayText`。設計書
 * 6.65.15）。ルビの読み・傍点の中身も対象にする——数字を含む語に傍点を
 * 打つ書き方もあるため、経路を分けない。
 */
function renderInline(
  line: string,
  notation: NotationMode,
  vertical: boolean
): string {
  return tokenizeLine(line, notation)
    .map((token) => {
      if (token.kind === "ruby") {
        return `<ruby>${escapeDisplayText(
          token.base,
          vertical
        )}<rt>${escapeDisplayText(token.reading, vertical)}</rt></ruby>`;
      }
      if (token.kind === "emphasis") {
        return `<span class="emphasis">${escapeDisplayText(
          token.text,
          vertical
        )}</span>`;
      }
      return escapeDisplayText(token.text, vertical);
    })
    .join("");
}
