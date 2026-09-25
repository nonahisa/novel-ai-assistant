import * as path from "./paths";
import { relocateQuote } from "./relocateQuote";
import { FACT_CONTRADICTION_CATEGORY } from "./factContradiction";
import {
  findingId,
  type Finding,
  type FindingCategory,
  type FindingComparison,
  type FindingProducer,
} from "../models/finding";

/**
 * 検知が出した指摘を、数日残す形（`models/finding.ts`）へ写すところ
 * （設計書6.96）。
 *
 * ## 対応表を1つしか置かない
 *
 * **残す側**（提案パネルの `replaceContents`）と**戻す側**
 * （`features/primeFindings.ts`）が、同じ表を見る。片方だけを直すと、
 * 残したのに戻らない指摘や、戻したのに判断が別の番号へ足される指摘が
 * できる——どちらも画面からは「消えた」としか見えない。
 *
 * ## `vscode` に触らない
 *
 * 本文の読み込みは `features` 側の仕事である。ここは「本文の文字列を
 * 渡されたら、1件を組む」だけを受け持つので、単体で試せる。
 */

/** 戻すときに、提案パネルのどちらの形で組むか */
export type FindingShape =
  /** 本文の置き換え（`ProposalViewItem`）。適用の道がある */
  | "item"
  /** 食い違い（`ContradictionViewItem`）。適用の道は無い */
  | "contradiction";

/**
 * 提案パネルの分類名 → 残すときの種類。
 *
 * **ここに無い分類は残さない。** 残さないものには理由がある。
 *
 * - **編集部からの提案**：`proposals.jsonl` に既に永続している（5.6.1.1）
 * - **設定資料の更新・伏線の候補**：`.aiwriter/pending-characters/` に
 *   既に永続している。そもそも本文の指摘ではない
 * - **名前の付け替え**：「資料にも反映」と対になった一続きの操作で、
 *   対応表を `workspaceState` に預けている。数日後に置き換えだけが
 *   戻ってきても、資料と噛み合わない
 * - **単話プロット・単話プロットと本文**：指しているのが本文ではなく
 *   プロットのファイルで、飛び先も押せる口も本文の指摘とは違う。
 *   戻すと「押しても何も起きない口」ができる
 *
 * **検知を足したら、ここへ1行足す。** 足し忘れると記録されないので、
 * `test/unit/models/findingRecording.test.ts` が実際の検知の口を通して見張る。
 */
const RECORDED: ReadonlyMap<
  string,
  { category: FindingCategory; shape: FindingShape }
> = new Map<string, { category: FindingCategory; shape: FindingShape }>([
  ["誤字脱字", { category: "typo", shape: "item" }],
  ["表記ゆれ", { category: "notation", shape: "item" }],
  ["推敲", { category: "proofread", shape: "item" }],
  ["矛盾", { category: "contradiction", shape: "contradiction" }],
  [
    FACT_CONTRADICTION_CATEGORY,
    { category: "contradiction", shape: "contradiction" },
  ],
  ["プロット逸脱", { category: "deviation", shape: "contradiction" }],
]);

/**
 * 分類名を残していなかった記録の、戻し先（種類 → 分類名）。
 *
 * **0.68.2 までの記録のためだけにある。** いまは分類名（`Finding.label`）を
 * そのまま残すので、ここは通らない。古い記録を黙って捨てないために置く
 * ——「矛盾（事実の照合）」で出たものは「矛盾」のタブへ入るが、
 * 出ないよりはよい。
 */
const LEGACY_RESTORED: ReadonlyMap<
  FindingCategory,
  { shape: FindingShape; panelCategory: string }
> = new Map<FindingCategory, { shape: FindingShape; panelCategory: string }>([
  ["typo", { shape: "item", panelCategory: "誤字脱字" }],
  ["notation", { shape: "item", panelCategory: "表記ゆれ" }],
  ["proofread", { shape: "item", panelCategory: "推敲" }],
  ["contradiction", { shape: "contradiction", panelCategory: "矛盾" }],
  ["deviation", { shape: "contradiction", panelCategory: "プロット逸脱" }],
]);

/** その分類の指摘を残すか。**残さないなら `undefined`** */
export function findingCategoryOf(
  panelCategory: string
): FindingCategory | undefined {
  return RECORDED.get(panelCategory)?.category;
}

/**
 * その指摘をどう戻すか。**戻し方の無い種類（`other`）は `undefined`**。
 *
 * **分類名（`label`）を先に見る**（設計書6.88.9）。「矛盾」と
 * 「矛盾（事実の照合）」は同じ種類だが別のタブで、作者はこの2つを
 * 並行させて見比べる。種類から決めると片方へ混ざる。
 */
export function findingRestoreOf(
  finding: { category: FindingCategory; label?: string }
): { shape: FindingShape; panelCategory: string } | undefined {
  const label = finding.label ?? "";
  const recorded = label ? RECORDED.get(label) : undefined;
  if (recorded) return { shape: recorded.shape, panelCategory: label };
  return LEGACY_RESTORED.get(finding.category);
}

/**
 * 残す1件の中身（提案パネルの形から、残す形への中継ぎ）。
 *
 * **記録するときも、判断を足すときも、ここを通す。** 番号（`id`）は
 * 中身から決まるので、片方が別の形で組むと**同じ指摘に別の番号が付き、
 * 退けた記録がどこにも効かなくなる**。
 */
export interface FindingDraft {
  /** 本文のありか（絶対パス。作品の外なら、そのままの形） */
  filePath: string;
  /** 検知したときの行番号（1始まり） */
  line: number;
  /** 本文に実在するはずの原文 */
  original: string;
  /** 置き換える範囲。無い指摘もある（矛盾など） */
  target: string;
  /** 置き換えた後。無い指摘もある */
  suggestion: string;
  /** なぜ挙げたか */
  message: string;
  category: FindingCategory;
  /** 記録したときの分類名（提案パネルのタブ名）。**戻し先はこれで決まる** */
  label: string;
  /** 左右に並べる指摘（矛盾・逸脱）。置き換えの指摘は持たない */
  compared?: FindingComparison;
  /**
   * どのAIが出した指摘か（設計書6.49.7）。**番号には混ぜない**
   * （`findingIdOf` は見ない）——同じ直しを別のモデルが出しても同じ指摘である
   */
  producer?: FindingProducer;
}

/**
 * `Finding.file` の表記を決める——**作品フォルダーからの相対パス、区切りは `/`**。
 *
 * **ここがずれると全件が黙って消える。** 位置の探し直し
 * （`locateFindings`）は、渡された本文の `Map` をこの表記で引く。
 * 記録する側と画面側が別々に作ると、Windows の `\` と `/` が混ざるだけで
 * 1件も一致しなくなり、しかも**エラーにはならない**（「本文をまだ見て
 * いない」と区別が付かないため、黙って並ばないだけになる）。
 */
export function findingFileKey(workFolder: string, filePath: string): string {
  // 既に相対で渡されたものを、いまの作業フォルダー基準で解決し直さない
  const relative = path.isAbsolute(filePath)
    ? path.relative(workFolder, filePath)
    : filePath;
  return relative.split("\\").join("/");
}

/** `Finding.file` から、いまの手元のありかへ戻す */
export function findingFilePath(workFolder: string, file: string): string {
  return path.isAbsolute(file) ? file : path.join(workFolder, file);
}

/**
 * その指摘の番号。**記録する前でも、記録した後でも同じ値になる。**
 *
 * 判断（採った・退けた）はこの番号を指すので、適用したあとに
 * 呼び出し側が指摘の中身から作り直せる必要がある。
 */
export function findingIdOf(workFolder: string, draft: FindingDraft): string {
  return findingId(
    findingFileKey(workFolder, draft.filePath),
    draft.original,
    draft.target,
    draft.suggestion,
    draft.category,
    draft.label
  );
}

/**
 * 1件を組む。**原文がいまの本文に無ければ組まない**（`undefined`）。
 *
 * 探し直しの鍵は原文である（6.96.3）。本文に無いものを残しても、
 * 開くたびに `locateFindings` が捨てるだけなので、置き場が太るだけ損である。
 * AIが本文に無い引用を返すことは実際にあるので、ここで濾す
 * （実装ルール3。**AIの出力を信用しない**）。
 *
 * @param text いまの本文（そのファイルの全文）
 * @param time 検知した時刻（ISO 8601）。**期限の起点**なので、
 *   1回の検知でまとめて同じ値を渡す
 */
export function buildFinding(
  workFolder: string,
  draft: FindingDraft,
  text: string,
  time: string
): Finding | undefined {
  // 検知したときの行がもう動いていることもある。**本文のほうから決め直す**
  const line = relocateQuote(text, draft.original, draft.line);
  if (line === undefined) return undefined;
  const file = findingFileKey(workFolder, draft.filePath);
  return {
    id: findingIdOf(workFolder, draft),
    time,
    file,
    hintLine: line,
    original: draft.original,
    target: draft.target,
    suggestion: draft.suggestion,
    before: neighborOf(text, line, -1),
    after: neighborOf(text, line, +1),
    message: draft.message,
    category: draft.category,
    label: draft.label,
    compared: draft.compared,
    producer: draft.producer,
  };
}

/**
 * その行の、前（`-1`）か後ろ（`+1`）の**中身のある1行**。
 *
 * **1行でよい。** 探し直す側（`relocateQuote` の `narrowByContext`）は
 * 「前は最後の1行、後ろは最初の1行」しか見ないので、それ以上を持っても
 * 置き場が太るだけである。
 *
 * 空行は飛ばす。原稿は段落の間に空行を挟む形なので、隣をそのまま採ると
 * 空文字になり、**どの候補にも合ってしまって絞れない**。
 */
function neighborOf(text: string, line: number, step: -1 | 1): string {
  const lines = text.split(/\r\n|\r|\n/u);
  for (let at = line - 1 + step; at >= 0 && at < lines.length; at += step) {
    if (lines[at].trim().length > 0) return lines[at];
  }
  return "";
}
