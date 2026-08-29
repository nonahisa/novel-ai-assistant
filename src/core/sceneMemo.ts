import * as paths from "./paths";

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
  /** 行そのもの（`//` を含む）。本文から消すときの照合に使う */
  raw: string;
}

/** 本文の中の位置（次へ・戻るの起点） */
export interface MemoPosition {
  filePath: string;
  /** 1始まり */
  line: number;
}

/**
 * 付箋の印。**行の先頭が半角2つ `//` か全角2つ `／／`。**
 *
 * **先頭の空白は許さない。** 日本語の小説は段落の頭を全角空白で
 * 字下げするので、字下げを許すと本文と見分けが付かなくなる。
 *
 * 正規表現ではなく**文字列**で置いてあるのは、組んで書く面（設計書6.34）の
 * 画面側JSへそのまま渡すためである。あちらは webview のテンプレート文字列の
 * 中にあって `import` が効かないので、写しを置くと**片方だけが直る日が来る**
 * （`NOTATION_PATTERN` と同じ事情）。
 */
export const MEMO_LINE_PATTERN = "^(?:\\/\\/|／／)";

/** タグが書かれていない付箋の呼び名 */
export const DEFAULT_MEMO_TAG = "メモ";

/**
 * 「ここにメモを足す」で挿す行（設計書6.40.3）。
 *
 * **半角の `//` と空白まで。** 中身は作者が打つ。タグの雛形を入れておくと、
 * 消して打ち直す手間になる（付箋はタグ無しでも使える）。
 */
export const MEMO_LINE_PREFIX = "// ";

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

const MEMO_LINE_RE = new RegExp(MEMO_LINE_PATTERN);

/** その1行が付箋か。**行の先頭だけを見る**（途中の `//` はURL・会話文） */
export function isMemoLine(line: string): boolean {
  return MEMO_LINE_RE.test(line);
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
export function parseMemos(text: string, filePath = ""): SceneMemo[] {
  const memos: SceneMemo[] = [];
  const lines = splitLines(text);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].body;
    if (!isMemoLine(raw)) continue;
    const parsed = parseMemoBody(raw);
    memos.push({
      filePath,
      line: i + 1,
      tag: parsed.tag,
      text: parsed.text,
      raw,
    });
  }
  return memos;
}

/** `// TODO 潮の匂いを足す` を、タグと本文に分ける */
function parseMemoBody(raw: string): { tag: string; text: string } {
  // 印のあとの空白は落とす（半角も全角も）
  const body = raw.replace(MEMO_LINE_RE, "").replace(/^[\s　]+/, "");
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
export function blankMemoLines(text: string): string {
  let out = "";
  for (const line of splitLines(text)) {
    out += (isMemoLine(line.body) ? "" : line.body) + line.eol;
  }
  return out;
}

/**
 * メモ行を**行ごと落とす**（字数・投稿用・PDF・プレビュー）。
 *
 * 改行コードは残る行のものをそのまま使う（勝手にLFへ揃えない）。
 */
export function stripMemoLines(text: string): string {
  let out = "";
  for (const line of splitLines(text)) {
    if (isMemoLine(line.body)) continue;
    out += line.body + line.eol;
  }
  return out;
}

/** 本文にメモがあるか（無ければ何も掛けずに済ませたいときに使う） */
export function hasMemoLines(text: string): boolean {
  for (const line of splitLines(text)) {
    if (isMemoLine(line.body)) return true;
  }
  return false;
}

/** メモ行の範囲（改行は含まない）。原稿エディタの目印を塗るために使う */
export function memoLineRanges(
  text: string
): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  for (const line of splitLines(text)) {
    if (!isMemoLine(line.body)) continue;
    ranges.push({ start: line.start, end: line.start + line.body.length });
  }
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
 */
function fileRanker(
  memos: readonly SceneMemo[],
  fileOrder?: readonly string[]
): (filePath: string) => number {
  const index = new Map<string, number>();
  const put = (filePath: string): void => {
    const key = paths.normalizeForComparison(filePath);
    if (!index.has(key)) index.set(key, index.size);
  };
  for (const file of fileOrder ?? []) put(file);
  // 並びに無いファイルは後ろへ。**捨てない**——走査から漏れた話にも
  // メモは在りうるので、飛べなくなるほうが困る
  for (const memo of memos) put(memo.filePath);
  return (filePath) =>
    index.get(paths.normalizeForComparison(filePath)) ?? index.size;
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
  const key = paths.normalizeForComparison(filePath);
  let best: SceneMemo | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const memo of memos) {
    if (paths.normalizeForComparison(memo.filePath) !== key) continue;
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
  expectedRaw: string
): string | null {
  const lines = splitLines(text);
  const target = lines[line - 1];
  if (!target || target.body !== expectedRaw) return null;
  if (!isMemoLine(target.body)) return null;

  let out = "";
  for (let i = 0; i < lines.length; i++) {
    if (i === line - 1) continue;
    out += lines[i].body + lines[i].eol;
  }
  return out;
}
