import {
  escapeHtml,
  tokenizeLine,
  type NotationMode,
} from "./manuscriptRender";
import { stripMemoLines } from "./sceneMemo";

/**
 * 印刷用に組版したHTMLを作る（PDF出力のもと）。
 *
 * ## なぜPDFを直接作らないのか
 *
 * **日本語の縦書き・ルビ・傍点・禁則を正しく組めるPDF生成ライブラリが、
 * 実質存在しない。** 自前で組めば、行頭の句読点が飛び出したり、ルビが
 * 親文字からずれたりしたまま、直す当てのない大工事になる。
 *
 * 一方、**ブラウザの組版エンジンはこれを全部やる**。縦書き
 * （`writing-mode: vertical-rl`）も、`<ruby>` も、圏点（`text-emphasis`）も、
 * 禁則処理も、日本語のために作り込まれている。そこで、
 *
 *   組版済みのHTMLを作る → ブラウザで開く → 作者が印刷（Ctrl+P）で
 *   「PDFに保存」を選ぶ
 *
 * という形にした。**組版の品質をブラウザに任せる**ぶん、こちらは
 * 「どう組むか」の指定だけを持てばよい。作者の手が1つ増えるが、
 * その代わりに文庫本らしい仕上がりが最初から出る。
 *
 * ## ここは vscode に触らない
 *
 * 組み立てだけを持つので単体テストできる。ファイルの書き出しと
 * ブラウザを開くところは `features/exportPdf.ts` が行う。
 *
 * ## 本文は「逃がしてから、記法を組む」
 *
 * 作者の本文に `<script>` や `&` が書かれていても、**必ず文字として
 * 印字される**ようにする。`ruby.ts` の `rubyToHtml` は記法の外側を
 * 素通しするため、ここでは使えない。代わりに、読む面（`manuscriptRender.ts`）
 * が持っている記法の切り分け（`tokenizeLine`）を借りて、平文・ルビ・傍点の
 * どれも `escapeHtml` を通してから組み立てる。**記法の定義を増やさない。**
 */

/** 紙の大きさと組み方の組み合わせ */
export type PrintPreset = "bunko-vertical" | "a5-vertical" | "a4-horizontal";

export interface PrintPresetInfo {
  id: PrintPreset;
  /** 選ぶ画面に出す名前 */
  label: string;
  /** どういうときに選ぶか、1行で */
  detail: string;
  /** `@page` の `size`（幅 高さ） */
  size: string;
  /** 縦書きか */
  vertical: boolean;
  /**
   * 本文の大きさ。
   *
   * **紙が小さいほど小さくする。** 文庫（105mm）でA4と同じ大きさの字を
   * 組むと、1行に10字ほどしか入らず、行替えだらけの紙になる。
   */
  fontSize: string;
}

/**
 * 選べる版。**紙の名前で並べる。**
 *
 * 「105mm × 148mm」だけでは、それが何なのか作者には分からない。
 * 逆に寸法を書かないと、印刷の設定と突き合わせられない。両方を出す。
 */
export const PRINT_PRESETS: readonly PrintPresetInfo[] = [
  {
    id: "bunko-vertical",
    label: "文庫サイズ・縦書き",
    detail: "105mm × 148mm（A6）。市販の文庫本に近い形です",
    size: "105mm 148mm",
    vertical: true,
    fontSize: "9pt",
  },
  {
    id: "a5-vertical",
    label: "A5・縦書き",
    detail: "148mm × 210mm。同人誌でよく使われる大きさです",
    size: "148mm 210mm",
    vertical: true,
    fontSize: "10pt",
  },
  {
    id: "a4-horizontal",
    label: "A4・横書き",
    detail: "210mm × 297mm。手元のプリンタで刷って読み返すのに向きます",
    size: "210mm 297mm",
    vertical: false,
    fontSize: "10.5pt",
  },
];

export function printPreset(id: PrintPreset): PrintPresetInfo {
  const found = PRINT_PRESETS.find((preset) => preset.id === id);
  if (!found) throw new Error(`知らない版です: ${id}`);
  return found;
}

export interface PrintEpisode {
  /** 話の見出し。「第1話　夜の駅」など。空なら見出しを出さない */
  heading: string;
  /** 本文。ルビ・傍点の記法はそのまま渡す（ここで組む） */
  body: string;
  /**
   * その話の記法（`core/manuscriptRender.ts` の `notationModeFor`）。
   *
   * **話ごとに持たせる。** 1つの作品に `.md` と `.txt` が混ざることがあり
   * （投稿サイトからDLした話と、こちらで書き足した話）、作品でひとまとめに
   * すると片方の記法が生のまま紙に出る。**省略できないようにしてある**
   * ——新しく呼ぶ人に、どちらなのかを必ず決めさせるため。
   */
  notation: NotationMode;
}

export interface PrintHtmlInput {
  workTitle: string;
  episodes: readonly PrintEpisode[];
  preset: PrintPreset;
}

/**
 * 印刷用のHTMLを1枚に組む。
 *
 * **外のものを一切読み込まない。** 書き出したファイルを別のPCへ写しても、
 * ネットに繋がっていなくても、同じ組み上がりで開ける。
 */
export function buildPrintHtml(input: PrintHtmlInput): string {
  const preset = printPreset(input.preset);
  // 題が空の作品はふつう無いが、`<title>` が空だとタブが場所の文字列になる
  const title = escapeHtml(input.workTitle.trim() || "無題");

  return [
    "<!DOCTYPE html>",
    '<html lang="ja">',
    "<head>",
    '<meta charset="utf-8">',
    `<title>${title}</title>`,
    "<style>",
    buildStyle(preset),
    "</style>",
    "</head>",
    "<body>",
    '<div class="sheet">',
    // 1ページ目は題だけの扉。ここで改ページして本文へ移る
    `<section class="cover"><h1 class="cover-title">${title}</h1></section>`,
    ...input.episodes.map(renderEpisode),
    "</div>",
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

/** 1話ぶん。**話ごとに改ページする**（本の体裁に合わせる） */
function renderEpisode(episode: PrintEpisode): string {
  const heading = escapeHtml(episode.heading.trim());
  return [
    '<section class="episode">',
    ...(heading ? [`<h2 class="episode-heading">${heading}</h2>`] : []),
    ...renderBody(episode.body, episode.notation),
    "</section>",
  ].join("\n");
}

/**
 * 本文を段落へ割る。
 *
 * **1行が1段落**である。小説の本文は行の途中で折り返さないので、
 * 改行はそのまま段落の切れ目になる。
 *
 * **空行は、段落と段落のあいだの空きにする。** 日本語の小説では段落の
 * あいだを空けないので（字下げで見分ける）、空行を捨ててしまうと
 * 場面の切り替わりが消える。空行のあとの段落にだけ空きを付ける。
 */
function renderBody(body: string, notation: NotationMode): string[] {
  const paragraphs: string[] = [];
  let afterBlank = false;

  // **シーンメモは紙に出さない**（設計書6.40.2）。作者の付箋であって
  // 読者へ渡す文章ではない。**行ごと落とす**——空行にすると、そこで
  // 段落の空きが入って場面が切れたように読める
  for (const line of stripMemoLines(body).replace(/\r\n?/g, "\n").split("\n")) {
    if (line.trim() === "") {
      afterBlank = true;
      continue;
    }
    // 先頭の空きは、扉との境目で既に付いている
    const gap = afterBlank && paragraphs.length > 0 ? ' class="gap"' : "";
    paragraphs.push(`<p${gap}>${renderInline(line, notation)}</p>`);
    afterBlank = false;
  }
  return paragraphs;
}

/**
 * 1行を、ルビ・傍点・平文へ組む。
 *
 * **どの経路も `escapeHtml` を通る。** ここを1つでも抜かすと、本文に
 * 書いた記号がタグとして読まれる。
 */
function renderInline(line: string, notation: NotationMode): string {
  return tokenizeLine(line, notation)
    .map((token) => {
      if (token.kind === "ruby") {
        return `<ruby>${escapeHtml(token.base)}<rt>${escapeHtml(
          token.reading
        )}</rt></ruby>`;
      }
      if (token.kind === "emphasis") {
        return `<span class="emphasis">${escapeHtml(token.text)}</span>`;
      }
      return escapeHtml(token.text);
    })
    .join("");
}

/**
 * 組み方の指定。
 *
 * **`break-before` と `page-break-before` を両方書く。** 新しい書き方
 * （`break-*`）だけを見るブラウザと、古い書き方だけを見るブラウザが
 * どちらも現役である。取り違えると、話の境目で改ページされない。
 */
function buildStyle(preset: PrintPresetInfo): string {
  const vertical = preset.vertical
    ? ["html, body { writing-mode: vertical-rl; }"]
    : [];

  return [
    `@page { size: ${preset.size}; margin: 15mm; }`,
    "html, body { margin: 0; padding: 0; }",
    "body {",
    // 明朝を先に置く。ゴシックで組んだ小説は、紙にすると読み疲れる
    '  font-family: "Yu Mincho", "游明朝", "Hiragino Mincho ProN", "MS Mincho", serif;',
    `  font-size: ${preset.fontSize};`,
    // ルビが親文字にぶつからない程度に空ける
    "  line-height: 1.8;",
    "  color: #000;",
    "  background: #fff;",
    "}",
    ...vertical,
    "h1, h2, p { margin: 0; padding: 0; font-weight: normal; }",
    // 扉。`text-align` は行の向きに沿って効くので、縦書きなら上下の中央、
    // 横書きなら左右の中央へ題が寄る（1つの指定で両方に効く）
    ".cover { break-after: page; page-break-after: always; text-align: center; }",
    // もう一方の向きは、余白で真ん中へ寄せる。**割合で書く。**
    // 割合の余白は紙の「行の長さ」を基準に決まるので、文庫でもA4でも
    // だいたい同じ位置に落ちる（`em` で書くと紙ごとにずれる）
    ".cover-title { font-size: 2em; letter-spacing: 0.25em; margin-block-start: 25%; }",
    ".episode { break-before: page; page-break-before: always; }",
    ".episode-heading { font-size: 1.3em; letter-spacing: 0.1em; margin-block-end: 2.5em; }",
    // 段落のあいだは空けない。字下げ（全角空白）で見分けるのが日本語の組み方
    "p { margin: 0; }",
    "p.gap { margin-block-start: 1.5em; }",
    "ruby { ruby-align: center; }",
    "rt { font-size: 0.5em; letter-spacing: 0; }",
    // 傍点は圏点（ゴマ点）で出す。位置の指定は既定のまま
    // （縦書きなら右、横書きなら上へ、ブラウザが振り分ける）
    ".emphasis { text-emphasis: filled sesame; -webkit-text-emphasis: filled sesame; }",
    // 画面で見たときに、紙らしく見えるようにする。
    // **ページの枠までは作らない**（印刷したときに正しければよい）
    "@media screen {",
    "  body { background: #d8d4cc; padding: 24px; }",
    "  .sheet { background: #fff; padding: 24px 32px; box-shadow: 0 2px 12px rgba(0, 0, 0, 0.2); }",
    "}",
  ].join("\n");
}
