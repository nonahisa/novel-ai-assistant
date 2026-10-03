import * as vscode from "vscode";
import * as paths from "../core/paths";
import { fromUri } from "../core/paths";
import { logStep, useLogFile } from "../core/logger";
import type { WorkEntry } from "../models/types";
import { columnForLocation } from "./editorColumn";
import {
  existingManuscriptTab,
  manuscriptLedgerKey,
  openManuscriptFile,
} from "./manuscriptTab";

/**
 * 本文を書き込んだあと、そのファイルを開いている画面の表示を最新にする
 * （提案パネルの［適用］［戻す］。もとは `proposalPanel.ts` の `revertIfOpen`）。
 *
 * `writeTextFilePreservingFormat` は「元の原稿を回復先へ退避 → 新しい内容で
 * 作り直す」手順（同じパスに新しいファイルを作り直す）で書き込む。
 * 単純な上書きと違い、この退避→作り直しの動きはVS Codeの
 * 「外部でファイルが変わったら自動的に読み直す」仕組みで拾われないことがあり、
 * 保存は成功しているのにエディターの表示だけ古いまま、という事故になる
 * （実機で発覚、2026-08-12）。ここで明示的に読み直させる。
 *
 * ## 開いている画面で道を分ける（0.97.7）
 *
 * 1. **素のテキストエディターのタブがある** → これまでどおり、そのタブを
 *    前へ出して読み直し、カーソル位置を戻す（`revertTextEditor`）
 * 2. **素のタブは無く、原稿エディターのタブがある** → 原稿エディターのタブを
 *    その列で前へ出して読み直す（`revertManuscriptEditor`）。
 *    **`showTextDocument` を呼ばない**
 * 3. どちらも無い → 何もしない
 *
 * 2026-10-03（広報の動画の撮影で発見）まで、2 も 1 の道を通っていた。
 * 原稿エディター（テキスト型のカスタムエディター）が抱える文書も
 * `vscode.workspace.textDocuments` に入るので、それを `showTextDocument` へ
 * 渡すと、**常に素のテキストエディターが開く**（`views/openDocument.ts` の冒頭）。
 * 列は `columnForLocation` が「既に開いている列」＝原稿エディターの列を返すので、
 * **原稿の列に同じ話の素のタブがもう1枚開き、原稿エディターがその下に隠れた**。
 * ［適用］を押すたびに起きていた。
 *
 * 対象が開いていても未保存の変更があれば触れない（`writeTextFilePreservingFormat`
 * 側の `hasUnsavedChanges` で、そもそもここまで来ないはずだが念のため。
 * 読み直しは打ちかけを捨てる）。
 *
 * **失敗しても投げない。** 書き込み自体は既に成功している。作者は
 * タブを閉じて開き直せば最新内容を見られる。
 *
 * @param work 書き込んだ本文の作品。渡されたら、記録をその作品のログファイルへ残す
 *   （`revealLocation.ts` と同じ。渡されなければ出力チャンネルだけ）
 */
export async function reloadOpenDocumentAfterWrite(
  filePath: string,
  work?: WorkEntry
): Promise<void> {
  // 記録の直前に書き先を向ける（ほかの機能が別の作品へ向け直していることがある）
  if (work) useLogFile(work.folderPath);
  const openDoc = vscode.workspace.textDocuments.find(
    (doc) => paths.isSamePath(fromUri(doc.uri), filePath) && !doc.isDirty
  );
  if (!openDoc) return;
  try {
    if (!hasTextEditorTab(filePath)) {
      const manuscript = existingManuscriptTab(manuscriptLedgerKey(filePath));
      if (manuscript) {
        await revertManuscriptEditor(filePath, manuscript);
        return;
      }
    }
    await revertTextEditor(filePath, openDoc);
  } catch (error) {
    // 表示の更新に失敗しても、書き込み自体は既に成功している。
    // **理由は残す**（「表示が古いまま」の報告を追う手がかり）
    logStep(
      `適用のあとの読み直しに失敗しました（${filePath}：${
        error instanceof Error ? error.message : String(error)
      }）。タブを閉じて開き直すと最新の本文が出ます。`
    );
  }
}

/**
 * その本文を、素のテキストエディターのタブで開いているか。
 *
 * **タブで見る**（`visibleTextEditors` ではない）。裏に回ったタブは
 * `visibleTextEditors` に出ないが、そのタブがあれば前へ出して読み直せば
 * 済み、新しいタブは増えない（これまでの道）。
 * タブを読めない環境では true（これまでどおりの道へ）。
 */
function hasTextEditorTab(filePath: string): boolean {
  try {
    const wanted = paths.pathKeyForComparison(filePath);
    return vscode.window.tabGroups.all.some((group) =>
      group.tabs.some((tab) => {
        const input: unknown = tab.input;
        return (
          input instanceof vscode.TabInputText &&
          paths.pathKeyForComparison(fromUri(input.uri)) === wanted
        );
      })
    );
  } catch {
    return true;
  }
}

/**
 * 原稿エディターで開いている本文を読み直す（0.97.7）。
 *
 * **前へ出すのは原稿を開く共通の口（`openManuscriptFile`）。** 既にあるタブの
 * 入口と列で `vscode.openWith` するので、そのタブが前へ出るだけで、
 * 2枚目の面も素のタブもできない（設計書6.25.11）。
 *
 * 読み直しの命令（`workbench.action.files.revert`）は前面の列の
 * 前面のエディターに掛かる。原稿エディターはテキスト型のカスタムエディター
 * なので、読み直しは VS Code が持つ文書そのものに掛かり、文書が変われば
 * 原稿エディターの既存の受け口（`onDidChangeTextDocument` →
 * 「外で変わったので画面へ送り直します」）が画面へ送り直す。
 *
 * カーソル位置は戻さない——原稿エディターでは画面の側がカーソルを持っていて、
 * 外からの変更で送り直すときに画面が位置を保つ（`TextEditor` も無い）。
 * フォーカスは呼ぶ側（提案パネルの `reloadAfterApply`）が提案パネルへ戻す。
 */
async function revertManuscriptEditor(
  filePath: string,
  tab: { viewType: string; column: vscode.ViewColumn }
): Promise<void> {
  await openManuscriptFile(filePath, tab.viewType, tab.column);
  /*
    E2E（画面テストの作品はワークスペースの中）では、この読み直しを外しても
    原稿エディターの本文は新しくなった（2026-10-03 に2回測った）。それでも残す——
    ワークスペースの外の本文や裏に回ったタブでは VS Code が読み直さないことがあり
    （2026-08-12・09-07）、読み直しは文書が既に新しければ何も変えない
  */
  await vscode.commands.executeCommand("workbench.action.files.revert");
  logStep(
    `適用のあと、原稿エディター（${tab.column}列目）の本文を読み直しました（${filePath}）。`
  );
}

/**
 * 素のテキストエディターで開いている本文を読み直す（これまでの道）。
 *
 * `revert` はスクロール位置・カーソル位置を保たない（実機で確認）ため、
 * 読み直す前の選択位置を控えておき、読み直した後に復元する。
 *
 * スクロール位置そのものを「表示範囲の先頭行をrevealRangeで指定し直す」
 * 形で厳密に復元しようとしたが、`AtTop`が実際にどこへ置くかが実機で
 * 安定せず（範囲全体を渡しても・先頭1行だけに絞っても、復元後の表示が
 * 数行分ずれた）、当てずっぽうの補正を重ねるやり方は行き詰まった
 * （2026-08-13）。そこで方針を変え、「直前の表示範囲を厳密に再現する」
 * のではなく、「編集した行がその後も画面内に見えていればそれで良い」
 * という緩い目標に切り替えた。`InCenterIfOutsideViewport`
 * は対象がすでに画面内にあれば何もしない（＝適用直前の表示位置が
 * そのまま保たれる）ため、通常のケース（適用した行を見ながら「適用」を
 * 押した直後）では一切スクロールが発生しない。対象が画面外に出ていた
 * 場合だけ、その行が見えるように寄せる。
 *
 * **`revert` 前に取得した `TextEditor` を使い回さない。** `revert` の後は
 * 別のエディターインスタンスになっていることがあり、古い参照へ
 * `selection` を代入しても反映されなかった（実機で確認）。復元は
 * 読み直した後に改めて取得したエディターに対して行う。
 */
async function revertTextEditor(
  filePath: string,
  openDoc: vscode.TextDocument
): Promise<void> {
  /*
    **本文が開いている列を名指しし、その列を前へ出す**（2026-09-23）。

    読み直しの命令（`workbench.action.files.revert`）は**前面の列**の本文に
    掛かる。提案パネルが下段にあったころは、フォーカスが下段にあっても
    前面の列は本文の列のままだったので `preserveFocus: true` で足りた。
    **右の列に開くようになると、前面の列が提案パネルの列になる**——
    フォーカスを残したままでは読み直しが提案パネルへ掛かって空振りし、
    列を名指ししないと本文が提案パネルの列へもう1枚開く。
    フォーカスは呼ぶ側（`reloadAfterApply`）が提案パネルへ戻す。
  */
  const before = await vscode.window.showTextDocument(openDoc, {
    viewColumn: columnForLocation(filePath).column,
    preserveFocus: false,
    preview: false,
  });
  const selection = before.selection;

  await vscode.commands.executeCommand("workbench.action.files.revert");

  const after =
    vscode.window.visibleTextEditors.find(
      (candidate) => candidate.document.uri.toString() === openDoc.uri.toString()
    ) ??
    (await vscode.window.showTextDocument(openDoc, {
      // 読み直す前と同じ列へ（提案パネルの列へ開かない）
      viewColumn: before.viewColumn,
      preserveFocus: true,
      preview: false,
    }));

  after.selection = selection;
  after.revealRange(selection, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
}
