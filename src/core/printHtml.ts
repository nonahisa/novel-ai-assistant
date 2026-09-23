import {
  escapeHtml,
  tokenizeLine,
  type NotationMode,
} from "./manuscriptRender";
import { stripMemoLines } from "./sceneMemo";
import { kindLineClass, kindLineCss } from "./kindLines";
import type { WorkKindKey } from "./workKind";
import { PRINT_PAGINATE_SCRIPT } from "./printPaginate";

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

/**
 * 上下の余白（ヘッダー・フッター）に刷るもの（設計書6.33.5 の2）。
 *
 * 中身を入れるのは面に割るスクリプト（`printPaginate.ts` の `marginText`）。
 * ページ番号と「その面がどの話か」は面に割ってみないと決まらないため。
 */
export type MarginContent = "title" | "episode" | "author" | "page" | "none";

/** 選ぶ画面に並べる順と名前 */
export const MARGIN_CONTENTS: readonly {
  id: MarginContent;
  label: string;
  detail: string;
}[] = [
  { id: "title", label: "題名", detail: "作品の題を、どのページにも刷ります" },
  { id: "episode", label: "話の見出し", detail: "そのページが入っている話の見出し（「第3話　雨」など）" },
  { id: "author", label: "作者名", detail: "筆名を刷ります。公募では名前を出さない決まりのこともあります" },
  { id: "page", label: "ページ番号", detail: "扉を数えず、本文の1ページ目を1とします" },
  { id: "none", label: "なし", detail: "何も刷りません" },
];

export interface HeaderFooter {
  top: MarginContent;
  bottom: MarginContent;
}

export function marginContentLabel(id: MarginContent): string {
  return MARGIN_CONTENTS.find((item) => item.id === id)?.label ?? id;
}

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
  /**
   * 上下の余白に刷るものの既定（作者が選ばなかったとき）。
   *
   * **ページ番号は下に置く**（どの紙でも）。文庫は市販の本に倣って上に
   * 話の見出し（柱）を、A5・A4 は手元で読み返すときに何の紙か分かるよう
   * 題名を置く。
   */
  headerFooter: HeaderFooter;
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
    headerFooter: { top: "episode", bottom: "page" },
  },
  {
    id: "a5-vertical",
    label: "A5・縦書き",
    detail: "148mm × 210mm。同人誌でよく使われる大きさです",
    size: "148mm 210mm",
    vertical: true,
    fontSize: "10pt",
    headerFooter: { top: "title", bottom: "page" },
  },
  {
    id: "a4-horizontal",
    label: "A4・横書き",
    detail: "210mm × 297mm。手元のプリンタで刷って読み返すのに向きます",
    size: "210mm 297mm",
    vertical: false,
    fontSize: "10.5pt",
    headerFooter: { top: "title", bottom: "page" },
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
  /**
   * 作品の種類（設計書6.109。台本は 6.70 から）。**小説以外で組み方が変わる**
   * （台本の柱・ト書き・台詞、漫画の原作のページ・コマ、エッセイの見出し、
   * 歌詞の節の札）。
   *
   * 省略・小説なら、これまでどおりの組み方になる（1バイトも変わらない）。
   */
  kind?: WorkKindKey;
  /**
   * 上下の余白に刷るもの（設計書6.33.5 の2）。省略なら紙の既定
   * （`PrintPresetInfo.headerFooter`）。
   */
  headerFooter?: HeaderFooter;
  /**
   * 作者名。上下のどちらかに「作者名」を選んだときだけ刷られる。
   * 省略・空なら、そこは何も刷らない。
   */
  author?: string;
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
  const margins = input.headerFooter ?? preset.headerFooter;
  const author = escapeHtml((input.author ?? "").trim());

  return [
    "<!DOCTYPE html>",
    '<html lang="ja">',
    "<head>",
    '<meta charset="utf-8">',
    `<title>${title}</title>`,
    "<style>",
    buildStyle(preset, input.kind),
    "</style>",
    "</head>",
    // 縦書きかどうかは、面に割るスクリプトが「どちらへはみ出したか」を
    // 測るのに使う（縦書きは左へ、横書きは下へはみ出す）
    // 上下の余白に何を刷るかと、その材料（題名・作者名）もスクリプトへ渡す。
    // 中身を入れるのはスクリプト（ページ番号と話は面に割るまで決まらない）
    `<body data-vertical="${preset.vertical ? "1" : "0"}" data-head="${margins.top}" data-foot="${margins.bottom}" data-title="${title}" data-author="${author}">`,
    buildGuide(preset, margins),
    // 紙1枚ずつの面は、ここへスクリプトが並べる（設計書6.33.5 の1）
    '<div id="print-pages"></div>',
    // 流し込みの本文。面に割るもとであり、スクリプトが動かなかったときの
    // 紙でもある（そのときは以前と同じ刷り上がりになる）
    '<div class="sheet" id="print-source">',
    // 1ページ目は題だけの扉。ここで改ページして本文へ移る
    `<section class="cover"><h1 class="cover-title">${title}</h1></section>`,
    ...input.episodes.map((episode) => renderEpisode(episode, input.kind)),
    "</div>",
    // 本文のあとに置く。先に置くと、割る相手がまだ読み込まれていない
    "<script>",
    PRINT_PAGINATE_SCRIPT,
    "</script>",
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

/**
 * 画面の上に出す、印刷のしかたの案内（紙には刷らない）。
 *
 * **ブラウザの「ヘッダーとフッター」を外させる。** 入れたままだと、
 * 日付とファイルの場所（`file:///C:/Users/…`）が紙の端に刷られる。
 * 作者の「不安になる」の一因がここにある（設計書6.33.5 の2）。
 *
 * 紙の大きさを書くのは、印刷の画面の「用紙サイズ」と突き合わせられるように
 * するため（Firefox は `@page` の大きさを見ないので、手で合わせることになる）。
 */
function buildGuide(preset: PrintPresetInfo, margins: HeaderFooter): string {
  const [width, height] = paperSize(preset);
  return buildPrintGuide(`${escapeHtml(preset.label)}（${width} × ${height}）`, margins);
}

/**
 * 案内帯の本体。`paper` は紙の説明（**逃がし済みの**HTML）。
 * 公募の納品用の組版（`printGridHtml.ts`）も同じ帯を出す。
 */
export function buildPrintGuide(paper: string, margins: HeaderFooter): string {
  return [
    '<div class="print-guide">',
    `<p class="print-guide-lead">この画面の白い面が、そのまま紙1枚ずつになります（<span id="print-page-count">面に分けています…</span>）。` +
      `紙：${paper}。` +
      `上の余白：${marginContentLabel(margins.top)}／下の余白：${marginContentLabel(margins.bottom)}</p>`,
    "<p>Ctrl+P で印刷の画面を開き、送信先を「PDF に保存」にしてください。" +
      "「詳細設定」の「ヘッダーとフッター」のチェックを外してください（入れたままだと、日付とファイルの場所が紙の端に刷られます）。" +
      "用紙サイズ・余白・倍率は「既定」のままにしてください。</p>",
    "</div>",
  ].join("\n");
}

/** `@page` の `size`（幅 高さ）を、幅と高さに分ける */
function paperSize(preset: PrintPresetInfo): [string, string] {
  const [width = "", height = ""] = preset.size.split(/\s+/);
  return [width, height];
}

/**
 * 面の余白（紙の端から本文までの空き）。
 *
 * **以前の `@page` の余白と同じ値にしてある。** 面に割れなかったときの紙
 * （`@page` の余白で組む）と、面に割れたときの紙で、本文の載る範囲が
 * 変わらないようにするため。
 */
const PAGE_MARGIN = "15mm";

/** 紙の書体。明朝を先に置く（公募の納品用の組版も同じ） */
export const PRINT_FONT_FAMILY =
  '"Yu Mincho", "游明朝", "Hiragino Mincho ProN", "MS Mincho", serif';

/** 1話ぶん。**話ごとに改ページする**（本の体裁に合わせる） */
function renderEpisode(
  episode: PrintEpisode,
  kind: WorkKindKey | undefined
): string {
  const heading = escapeHtml(episode.heading.trim());
  return [
    '<section class="episode">',
    ...(heading ? [`<h2 class="episode-heading">${heading}</h2>`] : []),
    ...renderBody(episode.body, episode.notation, kind),
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
 *
 * **小説以外の種類では、行の種別を印として付ける**（設計書6.70・6.109）。
 * 判定も組み方も `core/kindLines.ts` が持っており、原稿エディタと
 * 同じものが当たる——画面で見た形のまま紙になる。
 */
function renderBody(
  body: string,
  notation: NotationMode,
  kind?: WorkKindKey
): string[] {
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
    const names: string[] = [];
    // 先頭の空きは、扉との境目で既に付いている
    if (afterBlank && paragraphs.length > 0) names.push("gap");
    const lineClass = kindLineClass(kind, line);
    if (lineClass) names.push(lineClass);
    const attr = names.length > 0 ? ` class="${names.join(" ")}"` : "";
    paragraphs.push(`<p${attr}>${renderInline(line, notation)}</p>`);
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
function buildStyle(
  preset: PrintPresetInfo,
  kind: WorkKindKey | undefined
): string {
  /*
    **縦に組むのは本文だけ。** 以前は html・body ごと縦書きにしていたが、
    それでは紙1枚ずつの面が右から左へ横に並び、画面を横へ送らないと
    次の面が見えない。面は上から下へ積み、面の中と流し込みの本文だけを
    縦に組む。頭と足（ヘッダー・フッター）は横書きのまま
  */
  const vertical = preset.vertical
    ? [
        "#print-source { writing-mode: vertical-rl; }",
        ".page-body { writing-mode: vertical-rl; }",
        ".page-head, .page-foot { writing-mode: horizontal-tb; }",
      ]
    : [];
  const [width, height] = paperSize(preset);
  const margin = PAGE_MARGIN;
  /*
    種類ごとの組み方（設計書6.70・6.109）。**値は原稿エディタと同じものを
    埋め込む**——`core/kindLines.ts` の1か所にあり、こちらへ写しは置かない。
    小説の紙は、これまでと1バイトも変わらない
  */
  const kindCss = kindLineCss(kind);
  const script = kindCss ? [kindCss] : [];

  return [
    // 面に割れたら、スクリプトが余白を0にする（面の中に余白を持つため）。
    // ここに書いた余白は、割れなかったときの流し込みの紙のためのもの
    `@page { size: ${preset.size}; margin: ${margin}; }`,
    "html, body { margin: 0; padding: 0; }",
    "body {",
    // 明朝を先に置く。ゴシックで組んだ小説は、紙にすると読み疲れる
    `  font-family: ${PRINT_FONT_FAMILY};`,
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
    // **改ページの指定は流し込みの本文にだけ当てる。** 面の中へ写した札に
    // 付いていると、面の途中で紙が切れて白紙が挟まる
    "#print-source .cover { break-after: page; page-break-after: always; }",
    ".cover, .page-cover .page-body { text-align: center; }",
    // もう一方の向きは、余白で真ん中へ寄せる。**割合で書く。**
    // 割合の余白は紙の「行の長さ」を基準に決まるので、文庫でもA4でも
    // だいたい同じ位置に落ちる（`em` で書くと紙ごとにずれる）
    ".cover-title { font-size: 2em; letter-spacing: 0.25em; margin-block-start: 25%; }",
    "#print-source .episode { break-before: page; page-break-before: always; }",
    ".episode-heading { font-size: 1.3em; letter-spacing: 0.1em; margin-block-end: 2.5em; }",
    // 段落のあいだは空けない。字下げ（全角空白）で見分けるのが日本語の組み方
    "p { margin: 0; }",
    "p.gap { margin-block-start: 1.5em; }",
    ...script,
    "ruby { ruby-align: center; }",
    "rt { font-size: 0.5em; letter-spacing: 0; }",
    // 傍点は圏点（ゴマ点）で出す。位置の指定は既定のまま
    // （縦書きなら右、横書きなら上へ、ブラウザが振り分ける）
    ".emphasis { text-emphasis: filled sesame; -webkit-text-emphasis: filled sesame; }",
    ...pageSheetCss(width, height, margin),
  ].join("\n");
}

/**
 * 紙1枚ずつの面と、画面・印刷の見せ方の指定（設計書6.33.5 の1）。
 * 公募の納品用の組版（`printGridHtml.ts`）も同じものを使う。
 *
 * 面は**紙と同じ寸法の箱**で、余白の内側に本文の箱を置く。印刷のときは
 * `@page` の余白が0になり、箱1つが紙1枚に刷られる。箱の外へははみ出させない
 * （はみ出したら次の面へ送ってある）。
 */
export function pageSheetCss(
  width: string,
  height: string,
  margin: string
): string[] {
  return [
    `.page { position: relative; box-sizing: border-box; width: ${width}; height: ${height}; overflow: hidden; background: #fff; break-after: page; page-break-after: always; }`,
    ".page:last-child { break-after: auto; page-break-after: auto; }",
    `.page-body { position: absolute; top: ${margin}; right: ${margin}; bottom: ${margin}; left: ${margin}; overflow: hidden; }`,
    // 頭と足（ヘッダー・フッター）は上下の余白の中ほどに置く
    `.page-head, .page-foot { position: absolute; left: ${margin}; right: ${margin}; height: ${margin}; display: flex; align-items: center; justify-content: center; font-size: 0.8em; line-height: 1; white-space: nowrap; overflow: hidden; }`,
    ".page-head { top: 0; }",
    ".page-foot { bottom: 0; }",
    // 段落が面をまたいだとき、続きの頭には場面転換の空きを付けない
    "p.cont { margin-block-start: 0; }",
    ".paginating #print-source, .paginated #print-source { display: none; }",
    // 画面で見たときだけ：面を灰色の机に並べ、本文の載る範囲を薄い線で見せる
    // （余白がどれだけあるかが分かる）。**紙には刷らない**
    "@media screen {",
    "  body { background: #d8d4cc; }",
    '  .print-guide { position: sticky; top: 0; z-index: 1; margin: 0; padding: 10px 16px; background: #fff8dc; border-bottom: 1px solid #c8b560; font-family: "Yu Gothic UI", "Meiryo", sans-serif; font-size: 14px; line-height: 1.6; }',
    "  .print-guide p { margin: 0; }",
    "  .print-guide-lead { font-weight: bold; }",
    "  #print-pages { padding: 24px 16px; }",
    "  .page { margin: 0 auto 24px; box-shadow: 0 2px 12px rgba(0, 0, 0, 0.25); }",
    "  .page-body { outline: 1px dashed rgba(0, 0, 0, 0.15); }",
    "  #print-source { margin: 24px; background: #fff; padding: 24px 32px; box-shadow: 0 2px 12px rgba(0, 0, 0, 0.2); }",
    "}",
    "@media print {",
    "  .print-guide { display: none; }",
    "  body { background: #fff; }",
    "}",
  ];
}
