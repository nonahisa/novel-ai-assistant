/**
 * 設定資料の読み仮名を、本文のルビとして振る（設計書6.12.5）。
 *
 * 作者の指示（2026-08-23）：設定資料のパネルに「ルビを追加」を置き、
 * すべての話／開いている話／選んだ話、から対象を選べるようにする。
 *
 * ## 読み仮名を持つ名前だけを扱う
 *
 * 別名（呼び方）には読み仮名が無い。**読みの分からないものにルビは振れない**
 * ので、`name` と `reading` がそろっているレコードだけを対象にする。
 * 姓名を分けた呼び方（「マルキオ・イークェス」に対する「マルキオ」）も
 * 広げない——**その部分だけの読みは、こちらには分からない。**
 *
 * ## すでにルビのあるところへは振らない
 *
 * `{漢字|かんじ}` の中や、投稿サイト記法 `｜漢字《かんじ》` の中に
 * もう一度ルビを振ると、**二重になって本文が壊れる。**
 *
 * VS Code APIに依存しない。
 */

export interface RubyTerm {
  /** 本文に現れる文字列（レコードの正式名称） */
  text: string;
  /** 振る読み仮名 */
  reading: string;
}

/** どこまで振るか */
export type RubyScope =
  /** その話で最初に出てきた1回だけ（投稿作品でよくある形） */
  | "first"
  /** 出てくるところすべて */
  | "all";

export interface RubyInsertion {
  start: number;
  end: number;
  term: RubyTerm;
}

/**
 * すでにルビや傍点になっているところ。ここへは振らない。
 *
 * - `{漢字|かんじ}` … この拡張機能の書き方
 * - `{{強調}}` … 傍点
 * - `｜漢字《かんじ》` / `漢字《かんじ》` … 投稿サイトの書き方
 * - `#漢字__かんじ__#` … アルファポリスのもう1つの書き方
 */
const PROTECTED = [
  /\{[^{}|\r\n]+\|[^{}|\r\n]*\}/g,
  /\{\{[^{}\r\n]+\}\}/g,
  /[|｜][^|｜《》\r\n]+《[^《》\r\n]*》/g,
  /[一-鿿々々]+《[^《》\r\n]*》/g,
  /#[^#\r\n]+?__[^#\r\n]*?__#/g,
];

/** 触ってはいけない範囲を集める */
function protectedRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (const pattern of PROTECTED) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      if (match.index === undefined) continue;
      ranges.push([match.index, match.index + match[0].length]);
    }
  }
  return ranges;
}

/**
 * すでにルビが振ってある語（ルビの土台の文字列）を集める。
 *
 * **「各話の最初の1回だけ」で、その話にもうルビがある語には振らない**
 * （作者の裁定、2026-09-08）。0.40.5 までは既存のルビを飛ばして次の出現に
 * 振っていたので、作者が手で振った `{文佳|ふみか}` と、こちらが振った
 * ものが1話に2つ並んだ。「最初の1回」は「読者がその話で最初に見るとき」
 * の意味なので、もう振ってあれば済んでいる。
 *
 * 傍点（`{{強調}}`）はルビではないので数えない。
 */
export function rubiedBases(text: string): Set<string> {
  const bases = new Set<string>();
  const patterns = [
    /\{([^{}|\r\n]+)\|[^{}|\r\n]*\}/g,
    /[|｜]([^|｜《》\r\n]+)《[^《》\r\n]*》/g,
    /([一-鿿々]+)《[^《》\r\n]*》/g,
    /#([^#\r\n]+?)__[^#\r\n]*?__#/g,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) bases.add(match[1]);
  }
  return bases;
}

function overlaps(
  start: number,
  end: number,
  ranges: ReadonlyArray<[number, number]>
): boolean {
  return ranges.some(([from, to]) => start < to && end > from);
}

/**
 * コードポイントで数えた文字数。
 *
 * `String.length` はサロゲートペア（「𠮟」など）を2と数えるので、
 * それを「2文字の語」と誤って通してしまう。
 */
function charLength(text: string): number {
  return [...text.trim()].length;
}

/**
 * 1文字の語を、振る対象から外す（設計書6.12.5）。
 *
 * **1文字の語は、ほかの語の一部に当たりやすい。** 実機で能力「因」
 * （読み「いん」）が本文の「原因」に当たり、`原{因|いん}` と割れた
 * （2026-09-06）。前後の文脈を見ずに機械で当てている以上、
 * 1文字は当たりが多すぎて使いものにならない。
 *
 * **2文字は外さない。** 「文佳」「奥原」のような2文字の名前は主要人物に
 * 多く、外すと本来の目的（人名にルビを振る）が果たせない。名前の付け替え
 * （6.37.3）が「2文字以下を一括の既定から外す」のとは判断が違う——
 * あちらは名前そのものを書き換えるので、当たり損ねの被害が大きい。
 */
export function splitSingleCharTerms(terms: readonly RubyTerm[]): {
  usable: RubyTerm[];
  singleChar: RubyTerm[];
} {
  const usable: RubyTerm[] = [];
  const singleChar: RubyTerm[] = [];
  for (const term of terms) {
    if (charLength(term.text) <= 1) singleChar.push(term);
    else usable.push(term);
  }
  return { usable, singleChar };
}

/**
 * どこへ振るかを決める。**本文は書き換えない。**
 *
 * **長い名前を先に当てる。** 「ミナ」と「ミナモト」が両方あるとき、
 * 短いほうを先に取ると「ミナ」＋「モト」に割れる。
 *
 * **1文字の語はここでも飛ばす。** 呼び出し側が `splitSingleCharTerms` を
 * 通し忘れても本文を割らないように、二重に守る。
 */
export function planRubyInsertions(
  text: string,
  terms: readonly RubyTerm[],
  scope: RubyScope
): RubyInsertion[] {
  const usable = terms
    .filter(
      (term) =>
        term.text.trim() && term.reading.trim() && charLength(term.text) > 1
    )
    .sort((a, b) => b.text.length - a.text.length);
  if (usable.length === 0) return [];

  const blocked = protectedRanges(text);
  const found: RubyInsertion[] = [];
  const taken: Array<[number, number]> = [];
  // 「最初の1回だけ」は、すでにルビのある語を済んだものとして扱う
  const done = scope === "first" ? rubiedBases(text) : new Set<string>();

  for (const term of usable) {
    let from = 0;
    for (;;) {
      const at = text.indexOf(term.text, from);
      if (at < 0) break;
      const end = at + term.text.length;
      from = end;

      if (scope === "first" && done.has(term.text)) break;
      if (overlaps(at, end, blocked)) continue;
      // 長い名前がすでに取った場所へ、短い名前を重ねない
      if (overlaps(at, end, taken)) continue;

      found.push({ start: at, end, term });
      taken.push([at, end]);
      done.add(term.text);
      if (scope === "first") break;
    }
  }

  return found.sort((a, b) => a.start - b.start);
}

/**
 * 決めたところへ実際に振る。
 *
 * **うしろから入れる。** 前から入れると、入れたぶんだけ後ろの位置がずれる。
 */
export function applyRubyInsertions(
  text: string,
  insertions: readonly RubyInsertion[]
): string {
  let result = text;
  for (const insertion of [...insertions].sort((a, b) => b.start - a.start)) {
    result =
      result.slice(0, insertion.start) +
      `{${insertion.term.text}|${insertion.term.reading}}` +
      result.slice(insertion.end);
  }
  return result;
}

/** 1つの本文へ振った結果 */
export interface RubyFileResult {
  filePath: string;
  /** 振った件数 */
  count: number;
  /** 振れなかった理由。あれば書き換えていない */
  skipped?: string;
  /** どの語が何件入るか。確認画面で「何にルビが付くのか」を見せるために使う */
  byTerm?: ReadonlyArray<{ term: RubyTerm; count: number }>;
}

/**
 * 語ごとの件数を数える。
 *
 * 件数の多い順。同数のときは語の順（文字コード順）で並べる——
 * **並び順が呼ぶたびに変わると、同じ操作なのに確認画面の見た目が変わる。**
 */
export function countByTerm(
  insertions: readonly RubyInsertion[]
): Array<{ term: RubyTerm; count: number }> {
  const byText = new Map<string, { term: RubyTerm; count: number }>();
  for (const insertion of insertions) {
    const found = byText.get(insertion.term.text);
    if (found) {
      found.count += 1;
    } else {
      byText.set(insertion.term.text, { term: insertion.term, count: 1 });
    }
  }
  return [...byText.values()].sort(compareTermTotals);
}

function compareTermTotals(
  a: { term: RubyTerm; count: number },
  b: { term: RubyTerm; count: number }
): number {
  if (b.count !== a.count) return b.count - a.count;
  // localeCompare は環境の照合順に左右される。ここは見た目の安定だけが
  // 目的なので、どこでも同じ結果になる素の比較で並べる
  return a.term.text < b.term.text ? -1 : a.term.text > b.term.text ? 1 : 0;
}

/** 語ごとの件数を、確認画面に出す行数の上限 */
const TERM_TOTAL_LINES = 12;

/**
 * 全話を合算した「語ごとの件数」。
 *
 * **合計だけでは、何にルビが付くのかが分からない。** 実機で「因」が
 * 「原因」に当たった件は、語ごとの件数が出ていれば押す前に気づけた。
 * 語数が多いと確認画面が読めなくなるので、上位だけを出して残りは数で示す。
 */
export function describeRubyTermTotals(
  results: readonly RubyFileResult[]
): string {
  const byText = new Map<string, { term: RubyTerm; count: number }>();
  for (const result of results) {
    for (const entry of result.byTerm ?? []) {
      const found = byText.get(entry.term.text);
      if (found) {
        found.count += entry.count;
      } else {
        byText.set(entry.term.text, { term: entry.term, count: entry.count });
      }
    }
  }

  const totals = [...byText.values()]
    .filter((entry) => entry.count > 0)
    .sort(compareTermTotals);
  if (totals.length === 0) return "";

  const lines = totals
    .slice(0, TERM_TOTAL_LINES)
    // **件数を先に書く**（作者の要望、2026-09-07「：〇件の位置をそろえて」）。
    // ダイアログの字は等幅ではないので、名前のうしろに置くと長さぶんずれる。
    // 先頭に置けば揃う
    .map((entry) => `　${entry.count}件　${entry.term.text}（${entry.term.reading}）`);
  if (totals.length > TERM_TOTAL_LINES) {
    lines.push(`　…ほか${totals.length - TERM_TOTAL_LINES}語`);
  }
  return lines.join("\n");
}

/**
 * ルビを振る前の確認画面（設計書6.12.5）。
 *
 * **数はすべて `results` から数える。** 見出しの「6件」、話ごとの内訳、
 * 語ごとの件数が別々の計算から出ていると、片方だけ直したときに黙って
 * 食い違う。実機では目で足して確かめるしかなかった確認である
 * （作者の指示、2026-09-08「機械にできるものはテストへ」）。
 *
 * 画面へ出すのは呼び出し側（`features/applySettingsRuby.ts`）。ここは
 * 文字列を組むだけにして、VS Code に依存させない。
 */
export function buildRubyConfirm(options: {
  results: readonly RubyFileResult[];
  /** 読み仮名のある名前（使える語と、1文字なので外した語） */
  terms: { usable: readonly RubyTerm[]; singleChar: readonly RubyTerm[] };
  /** 「選んだ1話」「すべての話」など、どこへ振るか */
  scopeLabel: string;
  fileName: (filePath: string) => string;
}): { title: string; detail: string } {
  const { results, terms, scopeLabel, fileName } = options;
  const total = results.reduce((sum, entry) => sum + entry.count, 0);

  const detail = [
    `読み仮名のある名前：${terms.usable.length}語`,
    "",
    describeRubyResults(results, fileName),
  ];
  // **何にルビが付くのかを、押す前に見せる。** 合計と話ごとの件数だけでは、
  // 思っていない語に当たっていることに気づけない（実機で「因」が
  // 「原因」に当たった、2026-09-06）
  const byTerm = describeRubyTermTotals(results);
  if (byTerm) {
    detail.push("", "語ごとの件数", byTerm);
  }
  detail.push("", "すでにルビや傍点になっているところへは振りません。");
  if (terms.singleChar.length > 0) {
    detail.push(describeSingleCharTerms(terms.singleChar));
  }
  // **Ctrl+Z では戻らない。** 書き込みは「削除→作り直し」なので、
  // VS Codeの取り消し履歴に載らない（設計書6.12.5）
  detail.push(
    "元の本文は退避します。振ったあとの通知の「元に戻す」で戻せます。"
  );

  return {
    title: `${scopeLabel}に、${total}件のルビを振りますか？`,
    detail: detail.join("\n"),
  };
}

/** 外した1文字の語を、確認画面に1行で出す（多いと読めないので5語まで） */
export function describeSingleCharTerms(terms: readonly RubyTerm[]): string {
  const shown = terms.slice(0, 5).map((term) => term.text);
  const rest = terms.length > shown.length ? "、…" : "";
  return `1文字の語（${shown.join("、")}${rest}）は、ほかの語の一部に当たりやすいので対象外です。`;
}

/**
 * 振ったあとの本文が、そのままかどうか。
 *
 * **戻せるのは、振った直後のままの本文だけである。** 振ったあとに作者が
 * 書き足していたら、退避してある本文を書き戻すとその書き足しが消える。
 */
export function canRevertRuby(
  entry: { hashAfter: string },
  currentHash: string
): boolean {
  return entry.hashAfter === currentHash;
}

/**
 * 作者に見せる要約。
 *
 * **話ごとの内訳まで出す。** 合計だけだと、どこへ入るのかが分からない。
 */
export function describeRubyResults(
  results: readonly RubyFileResult[],
  fileName: (filePath: string) => string
): string {
  const done = results.filter((entry) => entry.count > 0);
  const skipped = results.filter((entry) => entry.skipped);

  const lines: string[] = [];
  if (done.length > 0) {
    const total = done.reduce((sum, entry) => sum + entry.count, 0);
    lines.push(`${done.length}話に、あわせて${total}件のルビを振ります。`);
    for (const entry of done) {
      lines.push(`　${fileName(entry.filePath)}：${entry.count}件`);
    }
  } else {
    lines.push("振るところが見つかりませんでした。");
  }

  if (skipped.length > 0) {
    lines.push("");
    lines.push(`対象にできない話（${skipped.length}件）`);
    for (const entry of skipped) {
      lines.push(`　${fileName(entry.filePath)}：${entry.skipped}`);
    }
  }
  return lines.join("\n");
}
