import * as path from "./paths";
import { relocateQuote } from "./relocateQuote";
import { FACT_CONTRADICTION_CATEGORY } from "./factContradiction";
import {
  findingId,
  type Finding,
  type FindingCategory,
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
 * `test/unit/findingRecording.test.ts` が実際の検知の口を通して見張る。
 */
const RECORDED: ReadonlyMap<string, FindingCategory> = new Map<
  string,
  FindingCategory
>([
  ["誤字脱字", "typo"],
  ["表記ゆれ", "notation"],
  ["推敲", "proofread"],
  ["矛盾", "contradiction"],
  [FACT_CONTRADICTION_CATEGORY, "contradiction"],
  ["プロット逸脱", "deviation"],
]);

/**
 * 残すときの種類 → 戻し方。
 *
 * **記録した分類名は残していない**（`Finding` が持つのは出どころの種類
 * だけである。`models/finding.ts`）。そのため「矛盾（事実の照合）」で
 * 出た指摘は、戻すと「矛盾」のタブへ入る。**種類は画面を分けるための
 * ものではない**という決め（6.96.5）に合わせてある。
 */
const RESTORED: ReadonlyMap<
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
  return RECORDED.get(panelCategory);
}

/** その種類をどう戻すか。**戻し方の無い種類（`other`）は `undefined`** */
export function findingRestoreOf(
  category: FindingCategory
): { shape: FindingShape; panelCategory: string } | undefined {
  return RESTORED.get(category);
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
    draft.category
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
    id: findingId(
      file,
      draft.original,
      draft.target,
      draft.suggestion,
      draft.category
    ),
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
