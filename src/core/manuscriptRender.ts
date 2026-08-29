import {
  SITE_EMPHASIS_SOURCE,
  SITE_RUBY_BARE_SOURCE,
  SITE_RUBY_BAR_SOURCE,
} from "./ruby";
import { TermIndex, type TermKind, type TermMatch } from "./termIndex";
import { memoLineRanges } from "./sceneMemo";

/**
 * 原稿エディタの表示の土台——記法の切り出し・用語の位置・記法の判定（設計書6.25）。
 *
 * 作者の指摘（2026-08-23）：VS Code 1.131 の Markdown 編集画面
 * （hybrid Markdown editor）では、用語ハイライト・右クリックの設定資料・
 * ルビの表示がどれも効かない。**あちらは拡張機能から手が出せない**ので、
 * 縦書きと投稿サイト対応まで含めて自前で持つことにした。
 *
 * 当初はここで「読む」面のHTMLを組み立てていた（`renderManuscript`）。
 * 0.24.14で「組んで書く」面が既定になり、読む面は開く道が無くなったので
 * 0.25.5で組み立ての側は消した。残っているのは、組んで書く面・打つ面の
 * 重ね敷き・PDF出力・用語ハイライトが共通で使う部品である。
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

/*
  **本文まるごとをHTMLへ組む経路は消した**（0.25.2）。

  `renderManuscript()` と、それだけが使っていた `renderLine()` /
  `markTerms()` / `escapeBody()` である。送り先だった原稿エディタの
  「読む」面・「並べる」面は、0.24.14で切り替えのボタンが無くなった時点から
  **開く道が無く**、0.25.2で面そのものを消した。

  **記法の切り分け（`tokenizeLine`）と `escapeHtml` は残す**——PDF出力
  （`core/printHtml.ts`）が使っている。用語の目印（`renderTermMarks`）と
  位置の一覧（`collectTermSpans`）も、打つ面と組んで書く面が使う。
*/

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
 *
 * ## シーンメモの蛍光ペンも、ここで敷く（設計書6.40.3）
 *
 * 作者の指示（2026-08-29）「シーンメモした場所は、蛍光黄色でマーカーして
 * ください」。**半透明の背景だけを置き、字には触らない**——この重ね敷きは
 * 打つ面の上に載るので、不透明に塗ると打っている字が隠れる。
 * 用語の色と重なっても、片方は文字色・片方は背景なので潰し合わない。
 */
export function renderTermMarks(text: string, index?: TermIndex): string {
  const matches = index ? index.find(text) : [];
  const memos = memoLineRanges(text);
  if (matches.length === 0 && memos.length === 0) return escapeHtml(text);

  let html = "";
  let cursor = 0;
  for (const range of memos) {
    if (range.start > cursor) {
      html += markedSlice(text, matches, cursor, range.start);
    }
    html +=
      '<span class="memo-line">' +
      markedSlice(text, matches, range.start, range.end) +
      "</span>";
    cursor = range.end;
  }
  if (cursor < text.length) {
    html += markedSlice(text, matches, cursor, text.length);
  }
  return html;
}

/**
 * `from` から `to` までを、用語の色を当てながら組む。
 *
 * **範囲で切れるようにしてある。** メモ行を包む `<span>` を挟むために
 * 行の境目で組み立てを区切る必要があり、用語の一致は本文全体に対する
 * 位置で持っているためである。用語（人名・地名）に改行は入らないので、
 * 一致が行をまたぐことは無いが、はみ出しても字が消えないよう丸めておく。
 */
function markedSlice(
  text: string,
  matches: readonly TermMatch[],
  from: number,
  to: number
): string {
  let html = "";
  let last = from;
  for (const match of matches) {
    if (match.end <= from || match.start >= to) continue;
    const start = Math.max(match.start, from);
    const end = Math.min(match.end, to);
    if (start > last) html += escapeHtml(text.slice(last, start));
    html +=
      `<span class="mark mark-${match.entry.kind}">` +
      `${escapeHtml(text.slice(start, end))}</span>`;
    last = end;
  }
  if (last < to) html += escapeHtml(text.slice(last, to));
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
