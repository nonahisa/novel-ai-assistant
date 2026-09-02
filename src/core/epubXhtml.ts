import {
  escapeHtml,
  tokenizeLine,
  type NotationMode,
} from "./manuscriptRender";
import { stripMemoLines } from "./sceneMemo";

/**
 * 話1つぶんの XHTML を組む（設計書6.65.4の第1段）。
 *
 * ## HTMLではなくXML
 *
 * EPUBの中身は**XHTML＝XML**である。ブラウザのHTMLパーサは閉じ忘れも
 * 裸の `&` も勝手に直してくれるが、**リーダーのXMLパーサは本ごと開くのを
 * やめる**。だからここは、
 *
 *   - 空要素を自分で閉じる（`<br />`）
 *   - 本文も見出しも属性値も、必ず `escapeHtml` を通す
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
 * どれも `escapeHtml` を通してから**組み立てる。記法の定義は増やさない。
 * `.md`（`{漢字|かんじ}`）と `.txt`（`｜漢字《かんじ》`）の両方を扱えるのも、
 * この経路の利点である。
 *
 * ここは vscode に触らないので単体テストできる。ZIPへ詰めるのは
 * `epubPackage.ts`、ファイルの書き出しは `features/exportEpub.ts` が行う。
 */

/**
 * XMLの中で使ってはいけない文字を逃がす。
 *
 * **定義を増やさない**ので `manuscriptRender.ts` のものをそのまま使う。
 * `'` は逃がさないが、XMLの本文でも二重引用符で囲んだ属性値でも生のまま
 * で正しい（属性は必ず `"` で囲む）。
 */
export const escapeXml = escapeHtml;

export interface EpubChapterSource {
  /** 話の見出し。**呼び出し側が組む**（`episodeLabel.ts` の作り方に合わせる） */
  heading: string;
  body: string;
  /** その話の記法。`.md` は `curly`、`.txt` は `site`（`notationModeFor`） */
  notation: NotationMode;
}

export interface EpubBodyOptions {
  /** 続いた空行を1つ減らすか（下の `renderBody` の説明を参照） */
  collapseBlankLines: boolean;
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
  const heading = chapter.heading.trim();
  return [
    '<section class="chapter">',
    ...(heading
      ? [`<h2 class="chapter-heading">${escapeXml(heading)}</h2>`]
      : []),
    ...renderBody(chapter.body, chapter.notation, options.collapseBlankLines),
    "</section>",
  ].join("\n");
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
 * 本文を段落へ割る。
 *
 * **1行が1段落**である（小説の本文は行の途中で折り返さない）。
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
 */
function renderBody(
  body: string,
  notation: NotationMode,
  collapseBlankLines: boolean
): string[] {
  // **シーンメモは本へ入れない**（設計書6.40.2）。作者の付箋であって
  // 読者へ渡す文章ではない。行ごと落とす——空行にすると、そこに
  // 段落の空きが生まれて場面が切れたように読める
  const lines = stripMemoLines(body).replace(/\r\n?/g, "\n").split("\n");

  const out: string[] = [];
  let blanks = 0;

  for (const line of lines) {
    if (line.trim() === "") {
      blanks++;
      continue;
    }
    // 先頭の空行（out が空）は捨てる
    if (out.length > 0) {
      const keep = collapseBlankLines ? Math.max(0, blanks - 1) : blanks;
      for (let i = 0; i < keep; i++) out.push(BLANK_PARAGRAPH);
    }
    blanks = 0;
    out.push(`<p>${renderInline(line, notation)}</p>`);
  }

  // 末尾に残った空行は捨てる（最後の頁に空の段落を並べない）
  return out;
}

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
 */
function renderInline(line: string, notation: NotationMode): string {
  return tokenizeLine(line, notation)
    .map((token) => {
      if (token.kind === "ruby") {
        return `<ruby>${escapeXml(token.base)}<rt>${escapeXml(
          token.reading
        )}</rt></ruby>`;
      }
      if (token.kind === "emphasis") {
        return `<span class="emphasis">${escapeXml(token.text)}</span>`;
      }
      return escapeXml(token.text);
    })
    .join("");
}
