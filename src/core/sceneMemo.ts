// 使うのは場所を比べるための正規化だけで、`Uri` は作らない。
// `paths` ごと取り込むと `vscode` が付いてくるので、純粋な側を直に指す
// （設計書6.87.3）
import * as paths from "./pathText";
import {
  DEFAULT_MEMO_MARKERS,
  MEMO_MARKER_DEFS,
  memoInsertOf,
  type MemoMarkers,
} from "./memoMarkers";

export { DEFAULT_MEMO_MARKERS, memoInsertOf, type MemoMarkers } from "./memoMarkers";

/**
 * シーンメモ——本文の中に置く付箋（設計書6.40）。
 *
 * 書いている最中の「ここに描写を足す」「この伏線は第12話で回収」を、
 * **その場に**書き留める。設定資料や別ファイルへ書くと、場面から離れて
 * 忘れる。**メモは本文の中にだけあり、別の台帳を持たない**（6.40.6）
 * ——ファイルを動かしてもGitで同期しても、メモは本文と一緒に動く。
 *
 * ## ここは vscode に触らない
 *
 * メモを消す経路は「字数」「投稿用」「PDF」「AIの入力」「索引」
 * 「プレビュー」と6つある。**消し忘れが公開事故になる**ので、
 * どの経路からも同じ関数を呼べるように、純粋な文字列処理だけを置く。
 *
 * ## 2つの消し方を分ける
 *
 * - `blankMemoLines` … **行数を保ったまま空行にする。** AIへ渡す本文に使う。
 *   AIは「何行目」を返し、その値で本文の位置を決めるので、行が減ると
 *   **別の行を書き換える**ことになる
 * - `stripMemoLines` … 行ごと落とす。字数・投稿用・PDFのように、
 *   行番号を持ち帰らない経路で使う
 */

/** 本文から拾った付箋1件 */
export interface SceneMemo {
  filePath: string;
  /** 行番号（1始まり。飛び先にそのまま使う） */
  line: number;
  /** 最初の語。無ければ「メモ」 */
  tag: string;
  /** タグを除いた本文 */
  text: string;
  /**
   * 行そのもの（`//` を含む）。本文から消すときの照合に使う。
   * 囲み（`<!-- ～ -->`）が複数行なら、その行々を本文の改行のままつないだもの
   */
  raw: string;
  /** 終わりの行（1始まり）。1行の付箋なら `line` と同じ */
  endLine?: number;
  /**
   * 閉じていない `<!--` の知らせの行（設計書6.40.8）。本文の付箋ではないので、
   * ［済み］（本文から消す）は出さず、［本文へ］で飛ぶだけにする
   */
  unclosed?: true;
}

/** 閉じていない囲みの行の札 */
export const UNCLOSED_MEMO_TAG = "閉じていない囲み";

/**
 * 閉じていない `<!--` を、校正・メモパネルに並べる行にする（設計書6.40.8）。
 *
 * **置き場は持たない。** 本文から毎回数え直すので、作者が `-->` を書いて閉じれば
 * 行は消える（〓の行〔`core/sjisMarkFinding.ts`〕は本文の外の記録だが、こちらは
 * 本文そのものから決まる）。
 */
export function unclosedCommentMemo(filePath: string, line: number): SceneMemo {
  return {
    filePath,
    line,
    tag: UNCLOSED_MEMO_TAG,
    text:
      `閉じていないメモの囲み（${line}行目）。--> を書いて閉じるまで、` +
      "この行からあとはメモにせず、本文として数え、投稿にも出します",
    raw: "",
    unclosed: true,
  };
}

/** 本文の中の位置（次へ・戻るの起点） */
export interface MemoPosition {
  filePath: string;
  /** 1始まり */
  line: number;
}

/*
  付箋の印（設計書6.40.1・6.40.8）。**どの印を使うかは作品ごとに選べる**
  （`core/memoMarkers.ts`。既定は `//` と `／／`）。ここの関数はどれも印の組を
  引数で受け取り、省くと既定になる（移植のコードと、作品を知らない呼び元が今のまま動く）。

  **字下げしていてもメモ**（作者の裁定、2026-09-08）。小説では段落の頭に
  全角空白を置くのが普通なので、同じ調子で「　// ここは書き直す」と
  書くと、0.40.5 までは本文扱いになって字数と投稿用コピーに混ざった。
  行頭の空白（半角・タブ・全角）を許す。

  **囲み（`<!-- ～ -->`）は1行では決まらない**（前後の行で決まる）。そのため判定の本体は
  本文全体を見る `scanMemoLines` の1つにし、ほかの関数はどれもそれを使う。
*/

/** タグが書かれていない付箋の呼び名 */
export const DEFAULT_MEMO_TAG = "メモ";

/**
 * 「ここにメモを足す」で挿す行の頭（設計書6.40.3）。既定の組の字。
 *
 * **半角の `//` と空白まで。** 中身は作者が打つ。タグの雛形を入れておくと、
 * 消して打ち直す手間になる（付箋はタグ無しでも使える）。
 * `//` を外した作品では、オンの印のうち最初のもので挿す（`memoInsertOf`）。
 */
export const MEMO_LINE_PREFIX = memoInsertOf(DEFAULT_MEMO_MARKERS).prefix;

/**
 * 1件も無いときに出す、書き方の案内。
 *
 * **文は1か所に置く。** パネルとコマンドの2か所で同じことを言うので、
 * 書き写すと片方だけ古くなる（「…と書くと行頭になります」という、
 * 意味の通らない文が残っていた。2026-09-06、作者の指摘）。
 */
export function memoHint(markers: MemoMarkers = DEFAULT_MEMO_MARKERS): string {
  const lead = MEMO_MARKER_DEFS.filter((def) => markers.ids.includes(def.id) && def.prefixes.length > 0).map(
    (def) => def.prefixes[0]
  );
  const parts: string[] = [];
  if (lead.length > 0) {
    parts.push(`本文の行頭に ${lead.join(" か ")} と書くとメモになります（字下げしていても構いません）`);
  }
  if (markers.comment) parts.push("<!-- と --> で囲んだ行もメモになります");
  return parts.join("。");
}

/** 既定の組の案内（作品を知らない所で使う） */
export const MEMO_HINT = memoHint(DEFAULT_MEMO_MARKERS);

/**
 * 校正・メモパネルを開くコマンド（Ctrl+Alt+M と同じもの）。
 *
 * **検知が終わったときも、提案パネルの側からこのコマンドを通して開く**
 * （作者の裁定 2026-10-04「終わったら校正・メモパネルを開く」）。引数は
 * `({ type: "work", work }, { preserveFocus: true })`——作品を名指しし、
 * 書いている手からフォーカスを奪わない。画面を開く処理を直に呼ぶと、
 * 提案パネルの試験まで画面の代役を用意することになる（`OPEN_PROPOSALS_COMMAND` と同じ考え）。
 *
 * `core` に置くのは、提案パネルの単体テストの多くが `features/sceneMemoPanel` を
 * 丸ごと差し替えており、そちらに置くと定数まで消えるため
 */
export const OPEN_SCENE_MEMOS_COMMAND = "novelai.openSceneMemos";

/**
 * タグとして読む最初の語の長さの上限。
 *
 * 日本語には語の切れ目に空白が無いので、`// 潮の匂いを足す` は1語である
 * （＝タグ無しとして扱う）。ところが `// 彼女は港を見下ろしていた 風が吹いた`
 * のように文の途中で空けると、前半がまるごとタグになってしまう。
 * **タグは絞り込みの見出しなので、長いものはタグではない。**
 */
const MEMO_TAG_MAX = 12;

/** 色分けの種類。CSSのクラス名の後半にもなる */
export type MemoTagKind = "todo" | "check" | "foreshadow" | "idea" | "other";

/**
 * よく使うタグの読み替え。**書き方の揺れをここで吸収する。**
 *
 * ここに無いタグは `other`（灰）になる。作者は好きな語をタグにできるので、
 * 知らないタグを弾かず、色だけを控えめにする。
 */
const MEMO_TAG_KINDS: ReadonlyArray<[readonly string[], MemoTagKind]> = [
  [["TODO", "todo", "ToDo", "Todo", "やること"], "todo"],
  [["要確認", "確認", "CHECK", "check"], "check"],
  [["伏線", "回収"], "foreshadow"],
  [["アイデア", "案", "IDEA", "idea"], "idea"],
];

export interface MemoColorPair {
  light: string;
  dark: string;
}

/**
 * タグごとの色。**16進を書くのはここだけ**（画面はCSS変数で受ける）。
 *
 * `core/termColors.ts` とは**別の表**にしてある（設計書6.40.5）。
 * 用語の色は「その語が何か」を示すもので、付箋の色は「あとで何をするか」を
 * 示すものなので、同じ色に揃えると意味が混ざる。
 */
export const MEMO_TAG_COLORS: Record<MemoTagKind, MemoColorPair> = {
  // やり残しは赤。いちばん強く目を引く
  todo: { light: "#c01c28", dark: "#ff8a80" },
  // 要確認は黄。赤ほど急がないが、放置できない
  check: { light: "#9a6700", dark: "#e3b341" },
  // 伏線は青。回収の予定であって、直すべき不備ではない
  foreshadow: { light: "#1a5fb4", dark: "#7cb7ff" },
  // 思いつきは緑。使わないまま消えてもよいもの
  idea: { light: "#1c7c3c", dark: "#7ee08a" },
  // それ以外は灰。作者が自由に付けたタグを、勝手に強調しない
  other: { light: "#6b6b6b", dark: "#a8a8a8" },
};

/**
 * メモ行に引く蛍光ペンの色（作者の指示、2026-08-29
 * 「シーンメモした場所は、蛍光黄色でマーカーしてください」）。
 *
 * **タグによらず同じ黄色にする。** 作者が求めているのは
 * 「メモの場所が一目で分かる」ことで、種類の区別ではない
 * （種類は行頭の小さな丸で示す）。
 *
 * **半透明にする。** 打っている面（textarea）の上に重ねて塗るので、
 * 不透明にすると字が隠れる。暗いテーマでは背景が黒に近く、同じ濃さだと
 * 字が読めなくなるため薄くする。
 */
export const MEMO_MARKER_COLOR: MemoColorPair = {
  light: "rgba(255, 235, 59, 0.45)",
  dark: "rgba(255, 235, 59, 0.28)",
};

/**
 * 画面へ渡す色の一式（`--novelai-<鍵>` になる）。
 *
 * **明暗のどちらを使うかだけを受け取る。** ここは `core` なので、
 * テーマを見るのは呼ぶ側（原稿エディタとパネル）の仕事である
 * （`core/termColors.ts` と同じ分け方）。**2つの画面が同じ色を使う**ように、
 * 選び方そのものはここへ寄せてある。
 */
export function memoColorVars(dark: boolean): Record<string, string> {
  const colors: Record<string, string> = {
    "memo-marker": dark ? MEMO_MARKER_COLOR.dark : MEMO_MARKER_COLOR.light,
  };
  for (const [kind, pair] of Object.entries(MEMO_TAG_COLORS)) {
    colors[`memo-${kind}`] = dark ? pair.dark : pair.light;
  }
  return colors;
}

/** そのタグの色の種類 */
export function memoTagKind(tag: string): MemoTagKind {
  const trimmed = tag.trim();
  for (const [names, kind] of MEMO_TAG_KINDS) {
    if (names.includes(trimmed)) return kind;
  }
  return "other";
}

/**
 * 画面で使うクラス名。**組んで書く面の段落にも、打つ面の目印にも同じものを付ける。**
 *
 * 名前と色の対応を1か所にしておかないと、面ごとに違う色の付箋が出る。
 */
export function memoTagClass(tag: string): string {
  return `memo-${memoTagKind(tag)}`;
}

/**
 * タグの読み替えを、画面側JSへそのまま渡すための表。
 *
 * 画面は `import` できないので、`JSON.stringify` して埋め込む
 * （`NOTATION_RULES` と同じ渡し方）。**写しを置かない。**
 */
export const MEMO_TAG_CLASS_MAP: Record<string, string> = (() => {
  const map: Record<string, string> = {};
  for (const [names, kind] of MEMO_TAG_KINDS) {
    for (const name of names) map[name] = `memo-${kind}`;
  }
  return map;
})();

/** 行の頭の空白（半角・タブ・全角） */
const LEAD_RE = /^[ \t　]*/;
const COMMENT_OPEN = "<!--";
const COMMENT_CLOSE = "-->";
/** 閉じの印のあとに許すもの（空白だけ） */
const TRAIL_BLANK_RE = /^[ \t　]*$/;

function leadLength(line: string): number {
  return LEAD_RE.exec(line)?.[0].length ?? 0;
}

/** 本文の中のメモ1件の範囲（行は0始まり、両端を含む） */
export interface MemoBlock {
  start: number;
  end: number;
  /** 囲み（`<!-- ～ -->`）か */
  comment: boolean;
}

/** `scanMemoLines` の答え */
export interface MemoLineScan {
  /** 行ごとに、メモの行か */
  memo: boolean[];
  /** メモ1件ずつ（1行の印は1行で1件、囲みは囲み全体で1件） */
  blocks: MemoBlock[];
  /**
   * 閉じていない `<!--` の行（0始まり）。無ければ null。
   * **そこからあとの囲みはメモにしない**（本文のまま数え、投稿にも出す）
   */
  unclosedLine: number | null;
}

/**
 * 本文の行から、どの行がメモかを決める。**判定の本体はこれ1つ。**
 *
 * - 1行の印：行の頭（空白のあと）が印で始まれば、その行がメモ
 * - 囲み：行の頭（空白のあと）の `<!--` から、`-->` を含む行まで。1行で閉じてもよい。
 *   `-->` のあとに空白以外の字があれば**閉じ忘れと同じ扱い**（どこまでがメモか決められない）
 * - 閉じていない `<!--` からあとの囲みは、**メモにしない。** 黙って本文を消さないことを
 *   優先する（作者の決定 2026-11-14 夜）。1行の印は、そのあとも今までどおり効く
 *
 * 画面（原稿エディターの組んで書く面・出先のページ）にも同じ決まりの写しがある。
 * 同じ見本で同じ答えになることは `composeFace.test.ts`・`editorPageLogic.test.ts` が見張る。
 */
export function scanMemoLines(
  lines: readonly string[],
  markers: MemoMarkers = DEFAULT_MEMO_MARKERS
): MemoLineScan {
  const memo = new Array<boolean>(lines.length).fill(false);
  const blocks: MemoBlock[] = [];
  let unclosedLine: number | null = null;
  let commentOn = markers.comment;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lead = leadLength(line);
    const rest = line.slice(lead);
    if (commentOn && rest.startsWith(COMMENT_OPEN)) {
      const end = commentEnd(lines, i, lead + COMMENT_OPEN.length);
      if (end === null) {
        unclosedLine = i;
        commentOn = false;
        continue;
      }
      for (let k = i; k <= end; k++) memo[k] = true;
      blocks.push({ start: i, end, comment: true });
      i = end;
      continue;
    }
    if (markers.prefixes.some((prefix) => rest.startsWith(prefix))) {
      memo[i] = true;
      blocks.push({ start: i, end: i, comment: false });
    }
  }
  return { memo, blocks, unclosedLine };
}

/** 囲みの終わりの行。閉じていない・閉じのあとに字があるなら null */
function commentEnd(lines: readonly string[], start: number, from: number): number | null {
  for (let k = start; k < lines.length; k++) {
    const text = k === start ? lines[k].slice(from) : lines[k];
    const at = text.indexOf(COMMENT_CLOSE);
    if (at < 0) continue;
    return TRAIL_BLANK_RE.test(text.slice(at + COMMENT_CLOSE.length)) ? k : null;
  }
  return null;
}

/**
 * その1行だけで付箋か。**行の先頭だけを見る**（途中の `//` はURL・会話文）。
 *
 * 1行で閉じた囲み（`<!-- … -->`）は当たるが、**複数行の囲みの中の行は、この関数では分からない。**
 * 本文を行ごとに見る所は `memoLineMask` を使う。
 */
export function isMemoLine(line: string, markers: MemoMarkers = DEFAULT_MEMO_MARKERS): boolean {
  return scanMemoLines([line], markers).memo[0];
}

/** 行の並びの、行ごとのメモの印（囲みの中の行も true） */
export function memoLineMask(
  lines: readonly string[],
  markers: MemoMarkers = DEFAULT_MEMO_MARKERS
): boolean[] {
  return scanMemoLines(lines, markers).memo;
}

/** 閉じていない `<!--` の行（1始まり）。無ければ null。囲みがオフの組では必ず null */
export function unclosedMemoCommentLine(
  text: string,
  markers: MemoMarkers = DEFAULT_MEMO_MARKERS
): number | null {
  if (!markers.comment) return null;
  const line = scanMemoLines(lineBodies(text), markers).unclosedLine;
  return line === null ? null : line + 1;
}

/**
 * 付箋の行から印を外した中身（タグと本文に分ける前）。
 *
 * 囲みの最初の行なら `<!--` を、1行で閉じていれば `-->` も外す。
 */
export function stripMemoMark(line: string, markers: MemoMarkers = DEFAULT_MEMO_MARKERS): string {
  const rest = line.slice(leadLength(line));
  if (markers.comment && rest.startsWith(COMMENT_OPEN)) {
    const inner = rest.slice(COMMENT_OPEN.length);
    const close = inner.indexOf(COMMENT_CLOSE);
    return close >= 0 ? inner.slice(0, close) : inner;
  }
  const prefix = markers.prefixes.find((candidate) => rest.startsWith(candidate));
  return prefix ? rest.slice(prefix.length) : rest;
}

/** 囲みの2行目からあとの中身（閉じの `-->` を外す） */
function commentContinuation(line: string): string {
  const close = line.indexOf(COMMENT_CLOSE);
  return close >= 0 ? line.slice(0, close) : line;
}

function lineBodies(text: string): string[] {
  return splitLines(text).map((line) => line.body);
}

/** 改行を保ったまま行へ割る（末尾の改行は最後の空行として残る） */
interface RawLine {
  body: string;
  /** その行の改行。最終行は空文字 */
  eol: string;
  /** 本文の中での開始位置 */
  start: number;
}

function splitLines(text: string): RawLine[] {
  const lines: RawLine[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\n") {
      lines.push({ body: text.slice(start, i), eol: "\n", start });
      start = i + 1;
    } else if (ch === "\r") {
      const crlf = text[i + 1] === "\n";
      lines.push({ body: text.slice(start, i), eol: crlf ? "\r\n" : "\r", start });
      if (crlf) i++;
      start = i + 1;
    }
  }
  // **最後は必ず入れる。** 末尾が改行で終わる本文では空の行になるが、
  // 入れておくと繋ぎ直したときに元の文字列へ戻る
  lines.push({ body: text.slice(start), eol: "", start });
  return lines;
}

/**
 * 本文から付箋を拾う。
 *
 * @param filePath 飛び先に使うので、パネルからは必ず渡す
 */
export function parseMemos(
  text: string,
  filePath = "",
  markers: MemoMarkers = DEFAULT_MEMO_MARKERS
): SceneMemo[] {
  const memos: SceneMemo[] = [];
  const lines = splitLines(text);
  const scan = scanMemoLines(lines.map((line) => line.body), markers);
  for (const block of scan.blocks) {
    const first = lines[block.start].body;
    /*
      **囲みは1件を1つの付箋にする。** タグは最初の行から読み、中身は2行目からあとも
      空白でつないで添える（パネルの1行に収まるように）
    */
    let content = stripMemoMark(first, markers);
    for (let k = block.start + 1; k <= block.end; k++) {
      const more = commentContinuation(lines[k].body).trim();
      if (more) content += ` ${more}`;
    }
    const parsed = parseMemoBody(content);
    memos.push({
      filePath,
      line: block.start + 1,
      tag: parsed.tag,
      text: parsed.text,
      raw: blockRaw(lines, block.start, block.end),
      ...(block.end > block.start ? { endLine: block.end + 1 } : {}),
    });
  }
  return memos;
}

/** 行 start〜end を、本文の改行のままつないだもの（最後の行の改行は含めない） */
function blockRaw(lines: readonly RawLine[], start: number, end: number): string {
  let raw = "";
  for (let k = start; k <= end; k++) raw += lines[k].body + (k < end ? lines[k].eol : "");
  return raw;
}

/** `// TODO 潮の匂いを足す` の印を外した残りを、タグと本文に分ける */
function parseMemoBody(content: string): { tag: string; text: string } {
  // 印のあとの空白は落とす（半角も全角も）
  const body = content.replace(/^[\s　]+/, "").replace(/[\s　]+$/, "");
  const words = body.split(/[\s　]+/).filter((word) => word.length > 0);

  if (words.length === 0) return { tag: DEFAULT_MEMO_TAG, text: "" };

  const head = words[0];
  // **語が1つだけなら、それは本文である。** 日本語には語の切れ目に空白が
  // 無いので、`// 潮の匂いを足す` の全体がタグになってしまう
  if (words.length === 1) {
    // ただし、それがよく使うタグそのものなら、タグとして読む
    // （`// TODO` とだけ書いて、あとから中身を足す書き方がある）
    if (memoTagKind(head) !== "other") return { tag: head, text: "" };
    return { tag: DEFAULT_MEMO_TAG, text: body };
  }

  // 長い先頭語はタグではない（文の途中で空けただけ）
  if (head.length > MEMO_TAG_MAX) return { tag: DEFAULT_MEMO_TAG, text: body };

  return { tag: head, text: body.slice(head.length).replace(/^[\s　]+/, "") };
}

/**
 * メモ行を**空行にする**（行数と改行コードを保つ）。
 *
 * AIへ渡す本文はこちらを通す。行が減ると、AIが返す行番号が本文とずれ、
 * **別の行を書き換える**ことになる。
 */
export function blankMemoLines(text: string, markers: MemoMarkers = DEFAULT_MEMO_MARKERS): string {
  const lines = splitLines(text);
  const memo = memoLineMask(lines.map((line) => line.body), markers);
  let out = "";
  lines.forEach((line, index) => {
    out += (memo[index] ? "" : line.body) + line.eol;
  });
  return out;
}

/**
 * メモ行を**行ごと落とす**（字数・投稿用・PDF・プレビュー）。
 *
 * 改行コードは残る行のものをそのまま使う（勝手にLFへ揃えない）。
 */
export function stripMemoLines(text: string, markers: MemoMarkers = DEFAULT_MEMO_MARKERS): string {
  const lines = splitLines(text);
  const memo = memoLineMask(lines.map((line) => line.body), markers);
  let out = "";
  lines.forEach((line, index) => {
    if (memo[index]) return;
    out += line.body + line.eol;
  });
  return out;
}

/** 本文にメモがあるか（無ければ何も掛けずに済ませたいときに使う） */
export function hasMemoLines(text: string, markers: MemoMarkers = DEFAULT_MEMO_MARKERS): boolean {
  return memoLineMask(lineBodies(text), markers).some(Boolean);
}

/** メモ行の範囲（改行は含まない）。原稿エディタの目印を塗るために使う */
export function memoLineRanges(
  text: string,
  markers: MemoMarkers = DEFAULT_MEMO_MARKERS
): Array<{ start: number; end: number }> {
  const lines = splitLines(text);
  const memo = memoLineMask(lines.map((line) => line.body), markers);
  const ranges: Array<{ start: number; end: number }> = [];
  lines.forEach((line, index) => {
    if (!memo[index]) return;
    ranges.push({ start: line.start, end: line.start + line.body.length });
  });
  return ranges;
}

/** タグごとの件数（多い順→タグ名順）。作品一覧の印とパネルの見出しで使う */
export function countMemosByTag(
  memos: readonly SceneMemo[]
): Array<{ tag: string; count: number }> {
  const counts = new Map<string, number>();
  for (const memo of memos) {
    counts.set(memo.tag, (counts.get(memo.tag) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag, "ja"));
}

/**
 * 作品一覧の話の右に出す短い印（設計書6.40.5）。
 *
 * **いちばん多いタグだけを出す。** 一覧の行は既に題と字数で埋まっており、
 * 内訳まで並べると読めなくなる。詳しくはパネルの見出しにある。
 * メモが無ければ空文字（**無ければ出さない**）。
 */
export function memoBadgeText(memos: readonly SceneMemo[]): string {
  if (memos.length === 0) return "";
  const byTag = countMemosByTag(memos);
  const top = byTag[0];
  // 種類が1つだけなら、その名前と件数。混ざっているなら合計も添える
  if (byTag.length === 1) return `${top.tag} ${top.count}`;
  return `${top.tag} ${top.count}／メモ計 ${memos.length}`;
}

/* ── 次へ・戻る（設計書6.40.4） ───────────────────── */

/**
 * 並べ替えの鍵。**話数順（＝走査の順）→行**。
 *
 * ファイルの順を知っているのは走査の結果を持つ側なので、`fileOrder` で
 * 受け取る。渡されなければ `memos` に出てきた順を、そのままファイルの
 * 順とみなす（1ファイル分だけを扱うときはこれで足りる）。
 *
 * **公開しているのは、AIの指摘を同じ順で並べるためである**
 * （`core/sceneMemoRows.ts`、設計書6.96.5）。付箋と指摘が別々の順序で
 * 並ぶと、混ぜた一覧が本文の順にならない。**写しを作らない。**
 * 場所しか見ないので、受け取る型は `filePath` を持つものまで広げてある。
 */
export function fileRanker(
  memos: readonly { filePath: string }[],
  fileOrder?: readonly string[]
): (filePath: string) => number {
  const index = new Map<string, number>();
  const put = (filePath: string): void => {
    const key = paths.pathKeyForComparison(filePath);
    if (!index.has(key)) index.set(key, index.size);
  };
  for (const file of fileOrder ?? []) put(file);
  // 並びに無いファイルは後ろへ。**捨てない**——走査から漏れた話にも
  // メモは在りうるので、飛べなくなるほうが困る
  for (const memo of memos) put(memo.filePath);
  return (filePath) =>
    index.get(paths.pathKeyForComparison(filePath)) ?? index.size;
}

/** 位置の前後。負なら a が前 */
function comparePosition(
  rank: (filePath: string) => number,
  a: MemoPosition,
  b: MemoPosition
): number {
  return rank(a.filePath) - rank(b.filePath) || a.line - b.line;
}

/** 話数順→行 に並べ直す */
export function sortMemos(
  memos: readonly SceneMemo[],
  fileOrder?: readonly string[]
): SceneMemo[] {
  const rank = fileRanker(memos, fileOrder);
  return [...memos].sort((a, b) => comparePosition(rank, a, b));
}

/**
 * いまの位置の次のメモ。**話をまたぐ。末尾なら先頭へ回る**（6.40.4）。
 *
 * 起点が無い（どこも開いていない）ときは先頭のメモを返す。
 */
export function nextMemo(
  memos: readonly SceneMemo[],
  current: MemoPosition | null,
  fileOrder?: readonly string[]
): SceneMemo | undefined {
  const sorted = sortMemos(memos, fileOrder);
  if (sorted.length === 0) return undefined;
  if (!current) return sorted[0];
  const rank = fileRanker(memos, fileOrder);
  return (
    sorted.find((memo) => comparePosition(rank, memo, current) > 0) ?? sorted[0]
  );
}

/** いまの位置の前のメモ。**先頭なら末尾へ回る** */
export function prevMemo(
  memos: readonly SceneMemo[],
  current: MemoPosition | null,
  fileOrder?: readonly string[]
): SceneMemo | undefined {
  const sorted = sortMemos(memos, fileOrder);
  if (sorted.length === 0) return undefined;
  if (!current) return sorted[sorted.length - 1];
  const rank = fileRanker(memos, fileOrder);
  const before = sorted.filter(
    (memo) => comparePosition(rank, memo, current) < 0
  );
  return before.length > 0
    ? before[before.length - 1]
    : sorted[sorted.length - 1];
}

/**
 * カーソルにいちばん近いメモ（パネルで光らせる。6.40.4）。
 *
 * **同じ話の中だけを見る。** 別の話のメモを光らせると、いま書いている
 * 場面と関係のない行が選ばれて、かえって分かりにくい。
 */
export function nearestMemo(
  memos: readonly SceneMemo[],
  filePath: string,
  line: number
): SceneMemo | undefined {
  const key = paths.pathKeyForComparison(filePath);
  let best: SceneMemo | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const memo of memos) {
    if (paths.pathKeyForComparison(memo.filePath) !== key) continue;
    const distance = Math.abs(memo.line - line);
    // 同じ距離なら**手前**を選ぶ（書いている場所より先の付箋より、
    // いま通り過ぎたばかりの付箋のほうが関わりが深い）
    if (distance < bestDistance || (distance === bestDistance && memo.line < line)) {
      best = memo;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * その行のメモを本文から消す（「済みにする」。6.40.4）。
 *
 * **行そのものを照合してから消す。** 読み込んでから押すまでの間に本文が
 * 変わっていることがあり、行番号だけで消すと**別の行が消える**。
 * 消せなければ `null` を返し、呼んだ側が理由を出す。
 *
 * @param line 1始まり
 */
export function removeMemoLine(
  text: string,
  line: number,
  expectedRaw: string,
  markers: MemoMarkers = DEFAULT_MEMO_MARKERS
): string | null {
  const lines = splitLines(text);
  const block = memoBlockAt(lines, line, expectedRaw, markers);
  if (!block) return null;

  let out = "";
  for (let i = 0; i < lines.length; i++) {
    if (i >= block.start && i <= block.end) continue;
    out += lines[i].body + lines[i].eol;
  }
  return out;
}

/**
 * その行から始まるメモ1件（囲みなら囲み全体）。読み込んだときの中身と違う・
 * メモでないなら null（`removeMemoLine` と `memoLineRemoval` が同じ条件で断る）
 */
function memoBlockAt(
  lines: readonly RawLine[],
  line: number,
  expectedRaw: string,
  markers: MemoMarkers
): MemoBlock | null {
  const index = line - 1;
  if (index < 0 || index >= lines.length) return null;
  const block = scanMemoLines(lines.map((entry) => entry.body), markers).blocks.find(
    (candidate) => candidate.start === index
  );
  if (!block) return null;
  if (blockRaw(lines, block.start, block.end) !== expectedRaw) return null;
  return block;
}

/**
 * ［済み］で消したメモの行を、あとで戻すための控え（6.40.4。作者の裁定
 * 2026-10-04「［済み］の直後に戻す帯を出す」）。
 *
 * **上下の隣の行を一緒に覚える。** 戻すときに「元の位置がいまも同じ所に
 * あるか」を、行番号だけでなく隣の行の中身で確かめるため。行番号だけで
 * 差し込むと、その間に作者が上へ1行足していたら、メモが別の段落へ入る。
 */
export interface RemovedMemoLine {
  /** 消した行（1始まり） */
  line: number;
  /** 消した行の中身（改行を除く。囲みなら行々を本文の改行のままつないだもの） */
  raw: string;
  /** 消した行の数（1行の付箋は1、囲みは囲みの行数） */
  lineCount: number;
  /** 消した行の改行。最終行で改行が無かったなら空文字 */
  eol: string;
  /** 上の行の中身。先頭の行だったなら null */
  before: string | null;
  /** 下の行の中身。改行の無い最終行だったなら null */
  after: string | null;
}

/**
 * 消す前の本文から、戻すための控えを作る（消すのは `removeMemoLine`）。
 *
 * 消せない行（読み込んだときと違う・メモでない）なら `null`——
 * `removeMemoLine` と同じ条件で断る。
 *
 * @param line 1始まり
 */
export function memoLineRemoval(
  text: string,
  line: number,
  expectedRaw: string,
  markers: MemoMarkers = DEFAULT_MEMO_MARKERS
): RemovedMemoLine | null {
  const lines = splitLines(text);
  const block = memoBlockAt(lines, line, expectedRaw, markers);
  if (!block) return null;
  return {
    line,
    raw: expectedRaw,
    lineCount: block.end - block.start + 1,
    eol: lines[block.end].eol,
    before: block.start > 0 ? lines[block.start - 1].body : null,
    // 改行の無い最終行は、下に行が無い（`splitLines` の最後の要素そのもの）
    after: block.end + 1 < lines.length ? lines[block.end + 1].body : null,
  };
}

/**
 * 消したメモの行を、どこへ差し込めば元に戻るか（文字の位置と、差し込む字）。
 *
 * **元の位置が確かめられなければ `null`**（実装ルール1）。上下の隣の行が
 * 消したときと同じ位置に居ることを確かめる。違えば、その間に本文が
 * 書き換わっているので、当て推量で差し込まない。
 *
 * 開いている文書へ `WorkspaceEdit` で差し込むときも、ディスクの本文を
 * 書き直すときも、ここで決めた位置を使う（2つの経路で判定を分けない）。
 */
export function memoLineRestorePoint(
  text: string,
  removed: RemovedMemoLine
): { offset: number; insert: string } | null {
  const lines = splitLines(text);
  const index = removed.line - 1;
  // 消したあとは、元の行の位置に「下の行」（または最後の空の行）が居る
  if (index < 0 || index >= lines.length) return null;

  if (removed.before === null) {
    if (index !== 0) return null;
  } else if (index === 0 || lines[index - 1].body !== removed.before) {
    return null;
  }

  const here = lines[index];
  if (removed.after === null) {
    // 改行の無い最終行だった：消したあとは、空の最終行がそこに残る
    if (index !== lines.length - 1 || here.body !== "") return null;
  } else if (here.body !== removed.after) {
    return null;
  }

  return { offset: here.start, insert: removed.raw + removed.eol };
}

/**
 * 消したメモの行を本文へ戻す（ディスクの本文を書き直す経路で使う）。
 * 元の位置が確かめられなければ `null`。
 */
export function restoreMemoLine(
  text: string,
  removed: RemovedMemoLine
): string | null {
  const point = memoLineRestorePoint(text, removed);
  if (!point) return null;
  return text.slice(0, point.offset) + point.insert + text.slice(point.offset);
}

/**
 * 新しくオンにする印で始まる行（1始まり）。切り替える前の確かめに使う（設計書6.40.8）。
 *
 * **囲みは `<!--` で始まる行だけを数える**（閉じているかは問わない）。数えたいのは
 * 「切り替えると本文から外れるかもしれない行」で、作者が見て判断するための材料である。
 */
export function linesStartingWithMarkers(text: string, added: MemoMarkers): number[] {
  const found: number[] = [];
  lineBodies(text).forEach((line, index) => {
    const rest = line.slice(leadLength(line));
    if (
      (added.comment && rest.startsWith(COMMENT_OPEN)) ||
      added.prefixes.some((prefix) => rest.startsWith(prefix))
    ) {
      found.push(index + 1);
    }
  });
  return found;
}
