import * as vscode from "vscode";
import * as path from "./paths";
import { computeDocumentEdit, toLf } from "./eolSpace";
import { hashBytes } from "./hash";
import { hasConflictMarkers, type TextFileContent } from "./textDecode";

/**
 * **エディターで開いている文書へ、変わった所だけを当てる**（作者の裁定「両方直す」、2026-10-16）。
 *
 * ## なぜディスクを直に書かないのか
 *
 * 本文と同じ書き戻しの口（`writeTextFilePreservingFormat`）は「退避 → 消して作り直す」で書く。
 * 開いたままのエディターは、VS Code のファイルの見張りがその変化を拾って読み直すまで、**古い中身と
 * 古い更新時刻**を持ち続ける。その間に作者が打つと文書は未保存になり、遅れて届いた変化は読み直されず、
 * Ctrl+S が「Failed to save 'plot.md': The content of the file is newer（Compare／Overwrite）」で
 * 断られた（プロットモードの［入れる］の直後。画面テスト plotRenamePending、2026-10-16）。
 * ［Overwrite］を押せば作者の打った字は残るが、押す前の画面は「原稿が壊れたか」と思わせる。
 *
 * 書いたあとに読み直させる道は取らない。開いている文書を読み直させる公開の口が無く
 * （`workbench.action.files.revert` は前面のエディターにしか効かない）、待っている間も作者は打てるので、
 * 食い違う間を縮めるだけで消せない。**文書へ当てて VS Code に保存させれば、エディターとディスクが
 * 食い違う間がそもそも無い。** プロットモードの見出しを足す口（`plotModePanel.ts` の `addSection`）と同じ考え方。
 *
 * ## 作者の原稿を壊さない（実装ルール1）をどう守るか
 *
 * - **ハッシュの照合は残す。** 読み込み時のハッシュとディスクの今を比べ、違えば当てない
 * - **未保存の変更がある文書には当てない**（書きかけを巻き込んで保存しない。今の口と同じ断り）
 * - **変わった所だけを当てる**（`computeDocumentEdit`。差分はLF空間で取り、入れる文字列は文書の改行に合わせる）
 * - 文字コードは、VS Code が開いたときに読み取ったもので保存される。**文書の中身が読み込み時の
 *   中身と一致するときだけ当てる**ので、読み違えた文字コードのまま保存することはない（一致しなければ
 *   今までどおりディスクへ書く道へ戻す）
 * - **改行の混ざったファイルは当てない。** VS Code は開くときに改行を1種類へ揃えるので、保存すると
 *   触っていない行の改行まで変わる。混ざっているときはバイトを保つ今の口へ戻す
 * - 回復先（`.novelai-recovery`）への退避は無い。代わりにエディターの Ctrl+Z で戻せる
 * - 保存の前の加工（末尾の空白を落とす等）は、作者が自分で Ctrl+S したときと同じ設定で走る
 */

export type OpenDocumentEditResult =
  /** 開いていない（または、今の口で書くほうが安全な形）。呼び出し側はディスクへ書く */
  | { kind: "notOpen" }
  /** 当てた。`save` を呼ぶまで保存はしない（保存の前に済ませたい処理を挟めるように） */
  | { kind: "edited"; save: () => Promise<boolean> }
  /** 止めた。理由は書き戻しの口と同じ言葉で返す（断りの文を写さずに済むよう） */
  | {
      kind: "failed";
      reason: "unsaved_changes" | "modified_externally" | "conflict_markers" | "edit_rejected";
    };

/**
 * @param filePath 書きたいファイル
 * @param original 読み込み時の中身（`readTextFile`。text はLF空間）
 * @param nextLfText 書きたい中身（LF空間）
 */
export async function editOpenDocument(
  filePath: string,
  original: TextFileContent,
  nextLfText: string
): Promise<OpenDocumentEditResult> {
  const document = vscode.workspace.textDocuments.find((entry) =>
    path.isSamePath(path.fromUri(entry.uri), filePath)
  );
  if (!document) return { kind: "notOpen" };
  if (document.isDirty) return { kind: "failed", reason: "unsaved_changes" };
  if (hasConflictMarkers(nextLfText)) return { kind: "failed", reason: "conflict_markers" };

  let current: Uint8Array;
  try {
    current = await vscode.workspace.fs.readFile(path.toUri(filePath));
  } catch {
    return { kind: "failed", reason: "modified_externally" };
  }
  if (hashBytes(current) !== original.hash) {
    return { kind: "failed", reason: "modified_externally" };
  }

  // 文書がディスクに追いついていない・文字コードを読み違えている・改行が混ざっている。
  // どれも文書へ当てて保存すると、作者の見ていないところまで変わりうる。バイトを保つ今の口へ戻す
  const documentText = document.getText();
  if (original.hasMixedEol || toLf(documentText) !== original.text) {
    return { kind: "notOpen" };
  }

  const edit = computeDocumentEdit(
    documentText,
    nextLfText,
    document.eol === vscode.EndOfLine.CRLF
  );
  if (edit) {
    const workspaceEdit = new vscode.WorkspaceEdit();
    workspaceEdit.replace(
      document.uri,
      new vscode.Range(document.positionAt(edit.start), document.positionAt(edit.end)),
      edit.insert
    );
    if (!(await vscode.workspace.applyEdit(workspaceEdit))) {
      return { kind: "failed", reason: "edit_rejected" };
    }
  }
  return { kind: "edited", save: () => Promise.resolve(document.save()) };
}
