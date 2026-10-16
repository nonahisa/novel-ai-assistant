import * as vscode from "vscode";
import * as path from "./paths";
import { computeDocumentEdit, toLf } from "./eolSpace";
import { hashBytes } from "./hash";
import { hasConflictMarkers, type TextFileContent } from "./textDecode";
import { writeTextFilePreservingFormat, type WriteTextFailureReason } from "./textFile";
import { forgetOwnPlotSave, isPlotFilePath, noteOwnPlotSave } from "./ownPlotSave";

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

export type PreferOpenDocumentWriteResult =
  /** 中身が同じだったので何もしていない */
  | { ok: true; via: "unchanged" }
  /** 開いていなかった（または今の口が安全な形）ので、ディスクへ書いた */
  | { ok: true; via: "disk"; recoveryPath?: string }
  /**
   * 開いている文書へ当てた。`saved` が false なら、文書には入ったが保存できていない
   * （作者に保存を頼む。当てた分は Ctrl+Z で戻せる）。`detail` は保存が投げた失敗の文
   */
  | { ok: true; via: "document"; saved: boolean; detail?: string }
  | {
      ok: false;
      reason: WriteTextFailureReason | "edit_rejected";
      detail?: string;
    };

/**
 * **作者がエディターで開いていそうなファイルを書く口**（plot.md・単話プロット。作者の裁定「両方直す」、
 * 2026-10-16）。開いていれば `editOpenDocument` で文書へ当てて保存し、開いていなければ本文と同じ
 * 書き戻しの口（`writeTextFilePreservingFormat`）でディスクへ書く。
 *
 * 0.107.8 でプロットモードの［入れる］（`plotNameSuggest.ts` の `applyPlotNames`）だけを直したが、
 * plot.md を書く口はほかにもあり、どれも同じ事故（Ctrl+S が「ファイルのほうが新しい」で断られる）が
 * 起こりえた。書き手ごとに同じ分かれ道を書き写すと片方だけ直り損ねるので、ここへ1本にまとめる
 * （［入れる］は保存の前に承認待ちを置く順番があるので、見本として今の形のまま残す）。
 *
 * - **ハッシュの照合・未保存なら止める・変わった所だけ**は両方の道に残る（実装ルール1）
 * - **plot.md なら、こちらの保存を覚えてから保存する**（`ownPlotSave.ts`）。保存からの反映を
 *   こちらの保存で走らせない（ディスクへ書いていたころと同じ振る舞い）
 * - **中身が同じなら何もしない。** 汚れていない文書の保存は保存の知らせを出さないことがあり、
 *   覚え書きだけが残ると、作者が次に同じ中身で保存したときの反映が飛ぶ
 *
 * @param original 読み込み時の中身（`readTextFile`）。ハッシュは押した時点のもの
 * @param nextLfText 書きたい中身（LF空間）
 */
export async function writeTextFilePreferringOpenDocument(
  filePath: string,
  original: TextFileContent,
  nextLfText: string
): Promise<PreferOpenDocumentWriteResult> {
  if (nextLfText === original.text) return { ok: true, via: "unchanged" };
  if (original.hasConflictMarkers) return { ok: false, reason: "conflict_markers" };

  const viaDocument = await editOpenDocument(filePath, original, nextLfText);
  if (viaDocument.kind === "failed") return { ok: false, reason: viaDocument.reason };
  if (viaDocument.kind === "notOpen") {
    const written = await writeTextFilePreservingFormat(
      filePath,
      nextLfText,
      original,
      original.hash
    );
    if (!written.ok) return { ok: false, reason: written.reason, detail: written.detail };
    return { ok: true, via: "disk", recoveryPath: written.recoveryPath };
  }

  const ownPlot = isPlotFilePath(filePath);
  if (ownPlot) noteOwnPlotSave(filePath, nextLfText);
  try {
    const saved = await viaDocument.save();
    if (!saved && ownPlot) forgetOwnPlotSave(filePath);
    return { ok: true, via: "document", saved };
  } catch (error) {
    if (ownPlot) forgetOwnPlotSave(filePath);
    return {
      ok: true,
      via: "document",
      saved: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * 書けなかった・保存できなかったときの断り（作者に見せる文）。書けたなら undefined。
 * `label` は「プロット（plot.md）」のような、作者が見て分かるファイルの呼び名
 */
export function describePreferOpenDocumentFailure(
  result: PreferOpenDocumentWriteResult,
  label: string
): string | undefined {
  if (result.ok) {
    return result.via === "document" && !result.saved
      ? `${label}へは書きましたが、保存できませんでした。開いている${label}を保存してください。`
      : undefined;
  }
  switch (result.reason) {
    case "unsaved_changes":
      return `${label}に保存していない変更があります。保存してから、もう一度やり直してください。`;
    case "modified_externally":
      return `${label}が読み込んだあとに変わっていたため、書くのを止めました。もう一度やり直してください。`;
    case "conflict_markers":
      return `${label}に競合の印（<<<<<<<）が残っているため、書くのを止めました。`;
    case "edit_rejected":
      return `開いている${label}へ書けませんでした。${label}を開き直してから、もう一度やり直してください。`;
    case "path_conflict":
      return `${label}の置き場に同じ名前の別のものがあるため、書くのを止めました。`;
    case "encoding_error":
      return `${label}の文字コードで書けない文字があるため、書くのを止めました。`;
  }
}
