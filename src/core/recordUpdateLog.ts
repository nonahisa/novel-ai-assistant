import type { CharacterDiff, FieldChange } from "./characterDiff";

/**
 * 設定資料の更新（承認待ちの案）を反映・見送りしたときの、動作の記録の1行
 * （`.aiwriter/logs/actions.log`。設計書5.6・6.32）。
 *
 * **反映しても1行も残らなかった**（2026-10-10、作者の作品で発覚）。抽出の
 * 完了のあと、16秒で人物6件が書き換わったのに、作品のログにも保管庫の
 * ログにも適用の行が無く、誰が・いつ・どの画面から押したのかが追えなかった。
 * 失敗だけは `logFailure` で残っていたが、成功と見送りは黙っていた。
 *
 * **言い方をここに1つだけ持つ。** 提案パネルの道と確認ダイアログの道が
 * それぞれ組むと、同じ1件が2通りに書かれて検索で拾えなくなる。
 * `vscode` に依存しない（純粋関数。`test/unit/core/recordUpdateLog.test.ts`）。
 */

/** どの画面から押したか。ログを読むときに「どこで押したか」が要る */
export type RecordUpdateVia = "提案パネル" | "確認ダイアログ";

/** 反映したか、見送ったか */
export type RecordUpdateVerdict = "applied" | "dismissed";

const VERDICT_WORD: Record<RecordUpdateVerdict, string> = {
  applied: "適用",
  dismissed: "見送り",
};

/**
 * 1項目の変化を短く言う。
 *
 * **1つずつ落とせる項目（呼称・関係・別名）は数で言う。** 値をそのまま
 * 書くと1行が長くなりすぎ、人物の名前もログへ大量に流れる。
 * ✕ で落とした葉は「入った数」から除く——入っていない値を「＋」に
 * 数えると、ログが作者の判断と食い違う（CLAUDE.md 規則2）。
 *
 * 地の文の項目は、足されたのか（空から）・書き足されたのか（前の文の
 * 後ろに続く）・書き換えたのか・消えたのかだけを言う。本文の要約や
 * 資料の中身はログへ写さない。
 */
function describeFieldChange(change: FieldChange, dropped: ReadonlySet<string>): string {
  if (change.entries) {
    const added = change.entries.filter(
      (entry) => entry.state === "added" && !dropped.has(entry.key)
    ).length;
    const removed = change.entries.filter((entry) => entry.state === "removed").length;
    const parts: string[] = [];
    if (added > 0) parts.push(`＋${added}`);
    if (removed > 0) parts.push(`−${removed}`);
    // 全部落とした・並びが変わっただけ、は「変更」とだけ言う
    return parts.length > 0 ? `${change.label}${parts.join("")}` : `${change.label}（変更）`;
  }
  if (!change.before) return `${change.label}（追加）`;
  if (!change.after) return `${change.label}（削除）`;
  if (change.after.startsWith(change.before)) return `${change.label}（追記）`;
  return `${change.label}（変更）`;
}

/**
 * 何が変わったかの要約（「別名＋3・性格（追記）」）。
 *
 * 新しく作る案は、項目を並べても「全部が追加」になるだけなので
 * 「新規作成」とだけ言う。
 */
export function summarizeRecordUpdateForLog(
  diff: CharacterDiff,
  options: { creation?: boolean; dropKeys?: readonly string[] } = {}
): string {
  if (options.creation) return "新規作成";
  if (diff.changes.length === 0) return "変更なし";
  const dropped = new Set(options.dropKeys ?? []);
  return diff.changes.map((change) => describeFieldChange(change, dropped)).join("・");
}

/**
 * 1件の行。
 *
 * 例：`設定資料の更新を適用：人物「リンセップ・アウクト」 別名＋3・性格（追記）（提案パネル）`
 */
export function describeRecordUpdateLog(entry: {
  verdict: RecordUpdateVerdict;
  /** 種類の短い呼び名（人物・能力・組織・場所・世界観） */
  kindLabel: string;
  name: string;
  diff: CharacterDiff;
  via: RecordUpdateVia;
  creation?: boolean;
  /** 出どころの呼び名（プロットから・相談から・外部AIから）。抽出は空 */
  sourceLabel?: string;
  /** 作者が ✕ を付けた葉の鍵（反映のときだけ） */
  dropKeys?: readonly string[];
  /** 保存の直前に実際に落ちた数（反映のときだけ） */
  dropped?: number;
}): string {
  const summary = summarizeRecordUpdateForLog(entry.diff, {
    creation: entry.creation,
    dropKeys: entry.dropKeys,
  });
  const notes: string[] = [];
  if (entry.sourceLabel) notes.push(`〔${entry.sourceLabel}〕`);
  // **黙って落としたことにしない**（CLAUDE.md 規則2）
  if (entry.verdict === "applied" && (entry.dropped ?? 0) > 0) {
    notes.push(`（✕で${entry.dropped}件を落とした）`);
  }
  return (
    `設定資料の更新を${VERDICT_WORD[entry.verdict]}：` +
    `${entry.kindLabel}「${entry.name}」 ${summary}` +
    notes.join("") +
    `（${entry.via}）`
  );
}

/**
 * まとめて押したときの、最後の1行。
 *
 * **1件ずつの行のあとに件数を置く。** 何件のうち何件が入ったかが
 * 1行で読めないと、作者はログを上から数え直すことになる。
 */
export function describeRecordUpdateBatchLog(entry: {
  /** 分類の見出し（「設定資料の更新」・伏線の候補など） */
  category: string;
  /** 押した操作の語（適用・承認・登録など） */
  verb: string;
  applied: number;
  total: number;
  /** 反映できなかった数 */
  failed?: number;
  /** ✕ で落とした葉の合計 */
  dropped?: number;
  via: RecordUpdateVia;
}): string {
  const notes: string[] = [];
  if ((entry.failed ?? 0) > 0) notes.push(`反映できなかった ${entry.failed}件`);
  if ((entry.dropped ?? 0) > 0) notes.push(`✕で落とした ${entry.dropped}件`);
  return (
    `${entry.category}をまとめて${entry.verb}：${entry.applied}/${entry.total}件` +
    (notes.length > 0 ? `（${notes.join("、")}）` : "") +
    `（${entry.via}）`
  );
}

/**
 * 画面の押しボタンの語（「反映する」「登録する」）から、ログの動詞を作る。
 *
 * 設定資料の更新（ボタンの語を持たない既定）は、1件ずつの行と同じ
 * 「適用」に揃える——同じ操作を2つの言い方で書かない。
 */
export function batchVerbFromLabel(applyLabel: string | undefined): string {
  if (!applyLabel) return VERDICT_WORD.applied;
  return applyLabel.replace(/する$/, "");
}

/**
 * 移す案（語り手の取り違えで主人公に入った値。設計書6.5.12）の1行（0.102.3）。
 *
 * 例：`設定資料の更新を適用：移す 人物「アジャーノ」役割「皇子」（第12話）→「殿下」（提案パネル）`
 *
 * **ふつうの更新案と同じ頭で書く**——「設定資料の更新を」で拾えば、移す案も
 * 一緒に出る。差分（`CharacterDiff`）を持たないので、値は項目と話数で言う。
 * 外すだけは `→（外すだけ）`、見送りは移し先を書かない。
 */
export function describeNarratorMoveLog(entry: {
  verdict: RecordUpdateVerdict;
  /** 主人公の名前 */
  sourceName: string;
  /** 項目と値と話数（`narratorMoveValueForLog`） */
  value: string;
  /** 移し先の名前。null は外すだけ（反映のときだけ見る） */
  destinationName?: string | null;
  via: RecordUpdateVia;
  /** 移し先の値を上書きしなかった件数（`applyNarratorMoves` の notes） */
  keptNotes?: number;
}): string {
  const arrow =
    entry.verdict === "applied"
      ? entry.destinationName
        ? `→「${entry.destinationName}」`
        : "→（外すだけ）"
      : "";
  const notes =
    entry.verdict === "applied" && (entry.keptNotes ?? 0) > 0
      ? `（移し先の値は変えず記録へ残した ${entry.keptNotes}件）`
      : "";
  return (
    `設定資料の更新を${VERDICT_WORD[entry.verdict]}：移す 人物「${entry.sourceName}」` +
    `${entry.value}${arrow}${notes}（${entry.via}）`
  );
}
