import {
  SITE_EMPHASIS_SOURCE,
  SITE_RUBY_BARE_SOURCE,
  SITE_RUBY_BAR_SOURCE,
} from "./ruby";
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
 * 原稿がどちらの記法で書かれているか（設計書6.12）。
 *
 * - `curly` … 拡張機能の記法 `{漢字|かんじ}` `{{強調}}`（`.md`）
 * - `site`  … 投稿サイトの記法 `｜漢字《かんじ》` `《《強調》》`（`.txt`）
 *
 * **混ぜない。** `.md` の中の `《》` は組まないし、`.txt` の中の `{}` も
 * 組まない。`.txt` は投稿サイトから持ってきた形をそのまま保つ決まりで、
 * ルビを振る操作は `.md` 限定である。片方の面だけが両方を解釈すると、
 * 「振れないのに消える」記法が生まれる。
 */
export type NotationMode = "curly" | "site";

/**
 * 1つのモードの記法。
 *
 * **捕獲の番号で意味を決める。** モードによって規則の数が違う（site は
 * 縦線ありと縦線なしの2通りのルビを持つ）ので、`match[2]` が親文字だと
 * 決め打つことができない。どの番号が何なのかを、規則と一緒に持たせる。
 */
export interface NotationRules {
  /** 正規表現の本体（`g` を付けて使う） */
  pattern: string;
  /** 傍点の中の文字が入る捕獲番号（先に値のあるものを使う） */
  emphasis: number[];
  /** ルビの［親文字, 読み］の捕獲番号（先に値のあるものを使う） */
  ruby: Array<[number, number]>;
}

/**
 * 拡張機能の記法。**この1つを唯一の定義にする。**
 *
 * **傍点を先に見る。** `{{強調}}` はルビの規則にも当たってしまうため、
 * 後回しにすると `{強調}` というルビ（読み仮名なし）に化ける。
 *
 * 正規表現ではなく**文字列**で置いてあるのは、組んで書く面（設計書6.34）の
 * 画面側JSへそのまま渡すためである。あちらは webview のテンプレート文字列の
 * 中にあり `import` が効かないので、写しを置くと**片方だけが直る日が来る**。
 */
export const NOTATION_PATTERN =
  "\\{\\{([^{}\\r\\n]+)\\}\\}|\\{([^{}|\\r\\n]+)\\|([^{}|\\r\\n]*)\\}";

/**
 * 投稿サイトの記法。**規則そのものは `core/ruby.ts` が持つ**（写さない）。
 *
 * 並べる順番に意味がある。
 *
 * 1. 傍点 `《《強調》》` … `彼《《強調》》` のような並びを、縦線なしのルビ
 *    （親文字「彼」・読み「《強調」）と読み違えないように、いちばん先に見る
 * 2. 縦線ありのルビ `｜漢字《かんじ》` … 先に縦線なしを当てると、縦線が
 *    置いてけぼりになって本文へ `｜` だけが残る
 * 3. 縦線なしのルビ `漢字《かんじ》`
 *
 * `fromSiteNotation` が置換をこの順で行っているのと同じ理由である。
 */
export const SITE_NOTATION_PATTERN = [
  SITE_EMPHASIS_SOURCE,
  SITE_RUBY_BAR_SOURCE,
  SITE_RUBY_BARE_SOURCE,
].join("|");

/** モードごとの記法。**画面側JSへはこれを丸ごと埋め込む** */
export const NOTATION_RULES: Record<NotationMode, NotationRules> = {
  curly: { pattern: NOTATION_PATTERN, emphasis: [1], ruby: [[2, 3]] },
  site: {
    pattern: SITE_NOTATION_PATTERN,
    emphasis: [1],
    ruby: [
      [2, 3],
      [4, 5],
    ],
  },
};

/**
 * そのファイルの記法。
 *
 * **`.md` だけが拡張機能の記法**である。判定を「ルビを振る」の可否
 * （`features/manuscriptEditor.ts` の `insertRuby`）と同じにしておく
 * ——振れる面と組める面がずれると、振ったのに組まれない原稿が出る。
 */
export function notationModeFor(fileName: string): NotationMode {
  return fileName.toLowerCase().endsWith(".md") ? "curly" : "site";
}

/** モードごとに1つだけ作って使い回す（行ごとに作り直すと本文の長さで効く） */
const TOKENS: Record<NotationMode, RegExp> = {
  curly: new RegExp(NOTATION_RULES.curly.pattern, "g"),
  site: new RegExp(NOTATION_RULES.site.pattern, "g"),
};

/** 当たった一致を、部品1つへ。**本文は何があっても落とさない** */
function tokenFor(match: RegExpMatchArray, rules: NotationRules): Token {
  for (const at of rules.emphasis) {
    const text = match[at];
    if (text !== undefined) return { kind: "emphasis", text };
  }
  for (const [baseAt, readingAt] of rules.ruby) {
    const base = match[baseAt];
    if (base === undefined) continue;
    // 読み仮名が空の `{漢字|}`（`｜漢字《》`）は、ルビとして出しても読めない。
    // **本文は消さずに平文へ戻す**（作者が書きかけの可能性がある）
    const reading = match[readingAt] ?? "";
    return reading.trim()
      ? { kind: "ruby", base, reading }
      : { kind: "plain", text: base };
  }
  // どの規則にも当たらない一致は作っていないが、出たとしても字は消さない
  return { kind: "plain", text: match[0] };
}

export function tokenizeLine(
  line: string,
  mode: NotationMode = "curly"
): Token[] {
  const rules = NOTATION_RULES[mode];
  const token = TOKENS[mode];
  const tokens: Token[] = [];
  let last = 0;
  token.lastIndex = 0;
  for (const match of line.matchAll(token)) {
    const start = match.index ?? 0;
    if (start > last) {
      tokens.push({ kind: "plain", text: line.slice(last, start) });
    }
    tokens.push(tokenFor(match, rules));
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
export function renderLine(
  line: string,
  index?: TermIndex,
  mode: NotationMode = "curly"
): string {
  if (line.length === 0) return "<br>";

  let html = "";
  for (const token of tokenizeLine(line, mode)) {
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
 *
 * @param mode 記法（`.txt` は投稿サイトの記法で組む。`notationModeFor`）
 */
export function renderManuscript(
  text: string,
  index?: TermIndex,
  mode: NotationMode = "curly"
): string {
  const lines = text.split(/\r\n|\r|\n/);
  return lines
    .map(
      (line, i) =>
        `<p class="line" data-line="${i}">${renderLine(line, index, mode)}</p>`
    )
    .join("\n");
}

/**
 * 用語の種類の呼び名。**定義はここだけ**（ホバーの見出しなどで使う）。
 *
 * 原稿エディタの下段に出していた色分けの凡例は、作者の指示で外した
 * （2026-08-28）。色の意味は設定資料パネルのタブが同じ色で示す。
 */
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
  /** 紹介の一文（チップに出す）。無ければ空文字 */
  summary: string;
}

export function collectTermSpans(text: string, index?: TermIndex): TermSpan[] {
  if (!index) return [];
  return index.find(text).map((match) => ({
    start: match.start,
    end: match.end,
    id: match.entry.id,
    kind: match.entry.kind,
    name: match.entry.canonicalName,
    // ホバーのチップに出す紹介。無ければ名前と種別だけのチップになる
    summary: match.entry.summary ?? "",
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
