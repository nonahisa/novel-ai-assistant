// 場所を比べるための正規化だけを使う。`paths` ごと取り込むと `vscode` が
// 付いてくるので、純粋な側を直に指す（`core/sceneMemo.ts` と同じ理由）
import * as paths from "./pathText";
import { fileRanker, type MemoColorPair, type SceneMemo } from "./sceneMemo";
import type { Finding, FindingCategory } from "../models/finding";

/**
 * 作者の付箋とAIの指摘を、1本の並びに混ぜる（設計書6.96.5）。
 *
 * 作者の指示（2026-09-19）：「ファイルを開いたら、そのファイルに関係する
 * 提案を種類にこだわらず、該当位置順でまとめて右側に幅を取らない感じで
 * 並べる機能が欲しい」。
 *
 * ## 混ぜるのは画面の上だけである
 *
 * 付箋は**本文の中**（`// TODO …` の行）、指摘は
 * `.aiwriter/findings.jsonl`。**置き場は分かれたままで、この線は動かさない**
 * （6.96.5）。ここがするのは、2つの列を**位置の順に一列へ並べ直す**ことだけ
 * である。
 *
 * ## なぜ `core` に置くか
 *
 * 並び順と「同じ行のまとめ方」は、**この製品が作者へ約束した順序**である
 * （話数 → 行。種類では分けない）。パネルの中に書くと `vscode` 抜きでは
 * 試せず、画面を動かさないと崩れに気づけない。純粋な関数にしておけば、
 * 単体テストが毎回見張る。
 */

/**
 * 指摘を、いまの本文の場所へ結び付けたもの。
 *
 * `Finding.file` は**作品フォルダーからの相対パス**で、`hintLine` は
 * 検知した日の行番号である。どちらもそのままでは開けないので、
 * **絶対パスと探し直した行**を呼び出し側（パネル）が添える
 * （`core/findingLocation.ts` の `locateFindings` が行を出す）。
 */
export interface PlacedFinding extends Finding {
  /** 本文の在りか。押したらここへ飛ぶ */
  filePath: string;
  /** いまの本文での行（1始まり）。**保存してある `hintLine` ではない** */
  line: number;
}

/** 一覧に並ぶ1行。**付箋か指摘のどちらか**で、混ざった型は作らない */
export type NoteRow =
  | {
      kind: "memo";
      filePath: string;
      line: number;
      /** 直前の行と同じ場所か。**同じなら、場所の表示をまとめる**（6.96.5） */
      sameLine: boolean;
      memo: SceneMemo;
    }
  | {
      kind: "finding";
      filePath: string;
      line: number;
      sameLine: boolean;
      finding: PlacedFinding;
    };

/** 同じ行に並んだときの前後。**作者が書いたものを先に読ませる** */
function kindRank(row: NoteRow): number {
  return row.kind === "memo" ? 0 : 1;
}

/**
 * 付箋と指摘を、**話数 → 行**の順で一列にする（設計書6.96.5）。
 *
 * **種類で分けない。** 作者が直すときの順序は種類ではなく本文の順である
 * ——誤字を全部直してから推敲を全部見る、という直し方を人はしない。
 *
 * @param fileOrder 話数順のファイルの並び（走査の結果を持つ側が渡す）。
 *   ここに無いファイルは後ろへ回る（**捨てない**）
 */
export function mergeNoteRows(
  memos: readonly SceneMemo[],
  findings: readonly PlacedFinding[],
  fileOrder?: readonly string[]
): NoteRow[] {
  const rows: NoteRow[] = [
    ...memos.map<NoteRow>((memo) => ({
      kind: "memo",
      filePath: memo.filePath,
      line: memo.line,
      sameLine: false,
      memo,
    })),
    ...findings.map<NoteRow>((finding) => ({
      kind: "finding",
      filePath: finding.filePath,
      line: finding.line,
      sameLine: false,
      finding,
    })),
  ];

  // **届いた順を最後の決め手にする。** 同じ行に同じ種類が2件来たとき、
  // 並べ直すたびに上下が入れ替わると、押そうとした行が逃げる
  return markSameLine(sortNoteRows(rows, fileOrder));
}

/** 位置の前後。負なら a が前（`core/sceneMemo.ts` の並べ方と同じ） */
function comparePlace(
  rank: (filePath: string) => number,
  a: { filePath: string; line: number },
  b: { filePath: string; line: number }
): number {
  return rank(a.filePath) - rank(b.filePath) || a.line - b.line;
}

/**
 * 「次へ」「戻る」で回る先（設計書6.96.5）。
 *
 * **付箋だけでなく、AIの指摘も回る。** 作者が直したい順は、付箋と指摘を
 * 分けた順ではなく**本文の順**である——一覧を位置順に混ぜておきながら、
 * 飛ぶときだけ付箋しか止まらないのでは、混ぜた意味が半分になる。
 *
 * **末尾なら先頭へ回る**（付箋だけのころと同じ。`nextMemo`）。起点が
 * 無い（どこも開いていない）ときは先頭を返す。
 *
 * @param rows `mergeNoteRows` を通したもの（並べ替えはここでもう一度する
 *   ——パネルは「いま開いている話を先頭へ」入れ替えたものを持っており、
 *   その並びで飛ぶと話をまたいだ順序が狂う）
 */
export function nextNoteRow(
  rows: readonly NoteRow[],
  current: { filePath: string; line: number } | null,
  fileOrder?: readonly string[]
): NoteRow | undefined {
  const sorted = sortNoteRows(rows, fileOrder);
  if (sorted.length === 0) return undefined;
  if (!current) return sorted[0];
  const rank = fileRanker(rows, fileOrder);
  return (
    sorted.find((row) => comparePlace(rank, row, current) > 0) ?? sorted[0]
  );
}

/** いまの位置の前の1件。**先頭なら末尾へ回る** */
export function prevNoteRow(
  rows: readonly NoteRow[],
  current: { filePath: string; line: number } | null,
  fileOrder?: readonly string[]
): NoteRow | undefined {
  const sorted = sortNoteRows(rows, fileOrder);
  if (sorted.length === 0) return undefined;
  if (!current) return sorted[sorted.length - 1];
  const rank = fileRanker(rows, fileOrder);
  const before = sorted.filter((row) => comparePlace(rank, row, current) < 0);
  return before.length > 0
    ? before[before.length - 1]
    : sorted[sorted.length - 1];
}

/** 話数 → 行の順（同じ行なら付箋が先）。**飛ぶ順序はいつもこれ** */
function sortNoteRows(
  rows: readonly NoteRow[],
  fileOrder?: readonly string[]
): NoteRow[] {
  const rank = fileRanker(rows, fileOrder);
  return rows
    .map((row, index) => ({ row, index }))
    .sort(
      (a, b) =>
        comparePlace(rank, a.row, b.row) ||
        kindRank(a.row) - kindRank(b.row) ||
        a.index - b.index
    )
    .map((entry) => entry.row);
}

/**
 * 直前と同じ場所の行に印を付ける。
 *
 * **画面は場所の表示（「第3話　18行目」）を1度だけ出す**ので、2件目から
 * 行が下にぶら下がって見える。まとめるのは表示だけで、行そのものは減らない。
 *
 * **並びを変えたあとにも呼べる**ようにしてある。パネルは「いま開いている話 →
 * その他」で二分するが、この並べ方はファイル単位で切るので、同じ場所の行が
 * 離れ離れになることはない。
 */
export function markSameLine(rows: readonly NoteRow[]): NoteRow[] {
  let previous = "";
  return rows.map((row) => {
    // **行番号を先に置く**（`memoKey` と同じ理由）。道の中に区切りと同じ
    // 文字があっても、数字が先なら最初の区切りで必ず割れる
    const key = `${row.line}:${paths.normalizeForComparison(row.filePath)}`;
    const sameLine = key === previous;
    previous = key;
    return { ...row, sameLine };
  });
}

/**
 * いま開いている話の行を、先頭へ寄せる（設計書6.40。0.74.11）。
 *
 * 書いている場面のものが下のほうにあると、横に並べた意味が薄れる。
 *
 * **塊のまま動く。** 並びはファイル単位で切れているので、同じファイルの
 * 行どうしの順番は変わらない（話数の順で下のほうにあった話でも、
 * 中の並びはそのままで頭へ来る）。
 *
 * `currentKey` は **`normalizeForComparison` を通した**形で渡す
 * （大文字小文字や区切りの違いで同じ話を別物にしないため）。
 * 開いている話が無ければ、並びは1つも動かない。
 *
 * **パネルの private メソッドだった**ものを、0.74.11 で外へ出した。
 * この並べ方は作者への約束（開いている話が先頭）なのに、画面を動かす
 * まで崩れに気づけない場所にあった。
 */
export function currentFirst<T extends { filePath: string }>(
  rows: readonly T[],
  currentKey: string | null
): T[] {
  if (!currentKey) return [...rows];
  const here = rows.filter(
    (row) => paths.normalizeForComparison(row.filePath) === currentKey
  );
  const rest = rows.filter(
    (row) => paths.normalizeForComparison(row.filePath) !== currentKey
  );
  return [...here, ...rest];
}

/**
 * 画面へ出す並びを整える（設計書6.40。0.74.11）。
 *
 * **順番が決まっている。** 先に「いま開いている話を先頭へ」、そのあとで
 * 「直前と同じ場所」の印を付け直す。逆にすると、**先頭へ来た行の印が
 * 入れ替え前のまま残る**——下のほうで2件目だった行が先頭に立っても
 * 「直前と同じ場所」を名乗り、場所の表示が消えたまま出る。
 *
 * `visibleRows()` が呼び分けていたこの順序を、1つの関数にまとめて
 * 試験で見張る（画面を動かさないと崩れに気づけない場所から出した）。
 */
export function arrangeRows(
  rows: readonly NoteRow[],
  currentKey: string | null
): NoteRow[] {
  if (!currentKey) return [...rows];
  return markSameLine(currentFirst(rows, currentKey));
}

/**
 * 指摘の種類の呼び名。
 *
 * **並べるためではなく、どこから来た指摘かを作者へ伝えるためにある**
 * （6.96.5。種類で並べ替えはしない）。知らない種類は「指摘」と呼ぶ——
 * 検知の機能が増えても、画面が空欄を出さないようにするため。
 */
export const FINDING_CATEGORY_LABELS: Record<FindingCategory, string> = {
  typo: "誤字",
  notation: "表記ゆれ",
  proofread: "推敲",
  contradiction: "矛盾",
  deviation: "プロット逸脱",
  other: "指摘",
};

export function findingCategoryLabel(category: FindingCategory): string {
  return FINDING_CATEGORY_LABELS[category] ?? FINDING_CATEGORY_LABELS.other;
}

/**
 * その指摘の呼び名。**記録してある分類名を先に使う**（設計書6.88.9）。
 *
 * 「矛盾」と「矛盾（事実の照合）」はどちらも種類が `contradiction` だが、
 * 作者はこの2つを並行させて見比べる。種類の呼び名だけで出すと、画面の上で
 * 一緒くたになる。古い記録（分類名を残していなかったころ）は種類から決める。
 */
export function findingLabelOf(finding: {
  category: FindingCategory;
  label?: string;
}): string {
  return finding.label || findingCategoryLabel(finding.category);
}

/**
 * 指摘の印の色。**種類で分けず、1色にする。**
 *
 * 並びを種類で分けないと決めた以上、色まで種類ごとに割ると、目が
 * 「色の順に見る」ことを覚えてしまう。ここで区別したいのは
 * **誰が書いたか**（作者の付箋か、機械の指摘か）だけである。
 *
 * 付箋の色（`core/sceneMemo.ts` の `MEMO_TAG_COLORS`）とは別の表に
 * してある。あちらは「あとで何をするか」の色で、こちらは出どころの印である。
 */
export const FINDING_DOT_COLOR: MemoColorPair = {
  light: "#6b4fbb",
  dark: "#c0a9ff",
};

/** 画面で使うクラス名。付箋の `memo-todo` などと同じ並びに置く */
export const FINDING_DOT_CLASS = "memo-ai";

/** 画面へ渡す色（`--novelai-memo-ai`）。明暗の選び方は呼ぶ側が決める */
export function findingColorVars(dark: boolean): Record<string, string> {
  return {
    [FINDING_DOT_CLASS]: dark ? FINDING_DOT_COLOR.dark : FINDING_DOT_COLOR.light,
  };
}

/**
 * 指摘の1行に出す文。
 *
 * **直し方があるなら、それを主文にする**（「見つめてた」→「見つめていた」）。
 * 矛盾と逸脱は直し方を出さないので、そのときは理由が主文になる——
 * 「どうする指摘なのか」が一目で分かる側を先に置く。
 */
export function findingHeadline(finding: Finding): string {
  if (finding.suggestion && finding.target) {
    return `「${finding.target}」→「${finding.suggestion}」`;
  }
  return finding.message || finding.original;
}

/** 主文の下に添える補足。主文と同じものは繰り返さない */
export function findingNote(finding: Finding): string {
  const headline = findingHeadline(finding);
  return finding.message === headline ? "" : finding.message;
}
