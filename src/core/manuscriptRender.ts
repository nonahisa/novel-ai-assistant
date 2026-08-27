import { TermIndex, type TermKind } from "./termIndex";

/**
 * 原稿エディタの「読む」面を組み立てる（設計書6.25）。
 *
 * 作者の指摘（2026-08-23）：VS Code 1.131 の Markdown 編集画面
 * （hybrid Markdown editor）では、用語ハイライト・右クリックの設定資料・
 * ルビの表示がどれも効かない。**あちらは拡張機能から手が出せない**ので、
 * 縦書きと投稿サイト対応まで含めて自前で持つことにした。
 *
 * ## ここは vscode に触らない
 *
 * 画面の組み立ては、**本文とHTMLの対応が合っているか**がすべてである。
 * ずれると読めない原稿が出る。vscode API を混ぜると単体テストで
 * 確かめられなくなるので、この層は純粋な文字列処理だけにする。
 *
 * ## 記法を「先に」切り出してから用語を探す
 *
 * ルビ `{漢字|かんじ}` と傍点 `{{強調}}` を素通ししたまま用語索引を当てると、
 * 記法の記号をまたいだ一致が出る（`{灯|あかり}` の中の「灯」と、その外側の
 * 文字が繋がって別の語に見える）。**記法を先に token へ割ってから、
 * 平文の部分にだけ用語を当てる。** 重なりの計算をしなくて済む。
 */

/** 1行を組み立てるときの部品 */
type Token =
  | { kind: "plain"; text: string }
  | { kind: "ruby"; base: string; reading: string }
  | { kind: "emphasis"; text: string };

/**
 * ルビ・傍点・平文へ割る。
 *
 * **傍点を先に見る。** `{{強調}}` はルビの規則にも当たってしまうため、
 * 後回しにすると `{強調}` というルビ（読み仮名なし）に化ける。
 */
const TOKEN = /\{\{([^{}\r\n]+)\}\}|\{([^{}|\r\n]+)\|([^{}|\r\n]*)\}/g;

export function tokenizeLine(line: string): Token[] {
  const tokens: Token[] = [];
  let last = 0;
  TOKEN.lastIndex = 0;
  for (const match of line.matchAll(TOKEN)) {
    const start = match.index ?? 0;
    if (start > last) {
      tokens.push({ kind: "plain", text: line.slice(last, start) });
    }
    if (match[1] !== undefined) {
      tokens.push({ kind: "emphasis", text: match[1] });
    } else {
      // 読み仮名が空の `{漢字|}` は、ルビとして出しても読めない。
      // **本文は消さずに平文へ戻す**（作者が書きかけの可能性がある）
      const reading = match[3] ?? "";
      if (reading.trim()) {
        tokens.push({ kind: "ruby", base: match[2], reading });
      } else {
        tokens.push({ kind: "plain", text: match[2] });
      }
    }
    last = start + match[0].length;
  }
  if (last < line.length) tokens.push({ kind: "plain", text: line.slice(last) });
  return tokens;
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * 本文の三点リーダ「…」を、行の中央に寄せるための印で包む
 * （作者の依頼、2026-08-28）。
 *
 * 位置はフォント任せで、欧文フォントに落ちると横書きでは下に沈み、
 * 縦書きでは縦用の字形（縦3点）を持たないフォントで横倒しのまま出る。
 * 読む面はHTMLなので、印を付けてCSSで寄せられる。
 * **書く面（textarea）は文字単位の調整ができない**ので、フォントの形のまま。
 *
 * **1文字ずつ包む。** 「……」をまとめて回すと、回転の中心が2文字の
 * 真ん中になり、縦書きで点列が柱からはみ出す。
 *
 * **本文の経路だけに使う。** 属性値（data-term-name など）へ使うと、
 * 名前に「…」を含む用語でHTMLが壊れる。
 */
function escapeBody(text: string): string {
  return escapeHtml(text).replace(
    /…/g,
    '<span class="ellipsis">…</span>'
  );
}

/**
 * 平文に用語索引を当て、色分けの印を付ける。
 *
 * **索引が無いときは、ただ escape して返す。** 設定資料をまだ作って
 * いない作品でも、本文は読めなければならない。
 */
function markTerms(text: string, index: TermIndex | undefined): string {
  if (!index || index.size === 0) return escapeBody(text);

  // 重なりは `find` の中で解消済み（最左最長）。「白瀬」と「白瀬澪」が
  // 両方登録されている作品で短いほうが勝つと、名字だけが色付いて、
  // 続く名前が地の文に見える
  const matches = index.find(text);
  if (matches.length === 0) return escapeBody(text);

  let html = "";
  let last = 0;
  for (const match of matches) {
    if (match.start > last) html += escapeBody(text.slice(last, match.start));
    const entry = match.entry;
    html +=
      `<span class="term term-${entry.kind}"` +
      ` data-term-id="${escapeHtml(entry.id)}"` +
      ` data-term-kind="${escapeHtml(entry.kind)}"` +
      ` data-term-name="${escapeHtml(entry.canonicalName)}"` +
      `>${escapeBody(text.slice(match.start, match.end))}</span>`;
    last = match.end;
  }
  if (last < text.length) html += escapeBody(text.slice(last));
  return html;
}

/** 1行ぶんのHTML。空行は高さを保つために `<br>` を入れる */
export function renderLine(line: string, index?: TermIndex): string {
  if (line.length === 0) return "<br>";

  let html = "";
  for (const token of tokenizeLine(line)) {
    switch (token.kind) {
      case "plain":
        html += markTerms(token.text, index);
        break;
      case "ruby":
        // **親文字にも用語の色を当てる。** ルビが振ってある名前だけ
        // 色が付かないと、同じ人物が別扱いに見える
        html +=
          `<ruby>${markTerms(token.base, index)}` +
          `<rt>${escapeHtml(token.reading)}</rt></ruby>`;
        break;
      case "emphasis":
        html += `<em class="emph">${markTerms(token.text, index)}</em>`;
        break;
    }
  }
  return html;
}

/**
 * 本文まるごとを、行ごとの `<p>` にする。
 *
 * **1行を1つの段落にする。** 小説の本文は改行が意味を持つ（会話の切れ目、
 * 場面の間）。Markdown の規則どおりに空行までを1段落へ畳むと、作者が
 * 置いた改行が消えて別の文章になる。
 */
export function renderManuscript(text: string, index?: TermIndex): string {
  const lines = text.split(/\r\n|\r|\n/);
  return lines
    .map(
      (line, i) =>
        `<p class="line" data-line="${i}">${renderLine(line, index)}</p>`
    )
    .join("\n");
}

/** 色分けの凡例。画面の隅に出して、色の意味が分かるようにする */
export const TERM_LABELS: Record<TermKind, string> = {
  character: "登場人物",
  location: "場所",
  ability: "能力",
  organization: "組織",
};

/**
 * 「書く」面の裏に敷く、用語の目印（設計書6.25.6）。
 *
 * 作者の依頼（2026-08-27）：「『書く』モードの時に設定資料の用語の
 * ハイライトは出せますか？」
 *
 * ## textarea の中の文字は飾れない
 *
 * 打つ面は `textarea` である。**中の一部分だけに色を付ける方法は無い。**
 * ルビを出したまま打てる面（`contenteditable`）は日本語入力と相性が悪く、
 * この作品では既に2度壊している（6.25.1・6.25.2）。**入力の受け口は変えない。**
 *
 * ## 裏に同じ文を敷いて、背景だけを塗る
 *
 * 打つ面と**同じ字送りで同じ本文**を裏に置き、用語のところだけ背景を塗る。
 * 表の `textarea` は文字だけを見せ、背景は透ける。
 *
 * **文字は裏でも表でも出さない**（裏は透明、表が本物）。二重に見えないし、
 * **変換中の文字も表にそのまま出る**——ここが肝で、裏に文字を出す作りだと
 * 変換中の文字が見えなくなる。
 *
 * ## 塗るのは背景だけ
 *
 * 文字の色は変えない。**打っている本文の色を変えると、変換中の文字と
 * 確定した文字の見分けが付かなくなる。**
 */
export function renderTermMarks(text: string, index?: TermIndex): string {
  if (!index) return escapeHtml(text);
  const matches = index.find(text);
  if (matches.length === 0) return escapeHtml(text);

  let html = "";
  let last = 0;
  for (const match of matches) {
    if (match.start > last) html += escapeHtml(text.slice(last, match.start));
    html +=
      `<span class="mark mark-${match.entry.kind}">` +
      `${escapeHtml(text.slice(match.start, match.end))}</span>`;
    last = match.end;
  }
  if (last < text.length) html += escapeHtml(text.slice(last));
  return html;
}

/**
 * 用語の位置（右クリックで、どの用語の上かを知るために使う）。
 *
 * **打つ面では、当たり判定を要素で取れない**（textareaの中に要素は無い）。
 * カーソルの文字位置から引くので、位置の一覧をそのまま渡す。
 */
export interface TermSpan {
  start: number;
  end: number;
  id: string;
  kind: TermKind;
  name: string;
}

export function collectTermSpans(text: string, index?: TermIndex): TermSpan[] {
  if (!index) return [];
  return index.find(text).map((match) => ({
    start: match.start,
    end: match.end,
    id: match.entry.id,
    kind: match.entry.kind,
    name: match.entry.canonicalName,
  }));
}

/** その文字位置にある用語。無ければ undefined */
export function termSpanAt(
  spans: readonly TermSpan[],
  offset: number
): TermSpan | undefined {
  // **端は含めない。** 用語の直後にカーソルを置いて右クリックしたときに、
  // 隣の言葉の資料が開くと分かりにくい
  return spans.find((span) => offset >= span.start && offset < span.end);
}
