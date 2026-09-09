import * as vscode from "vscode";
import * as path from "../core/paths";
import { logStep } from "../core/logger";

/**
 * 本文の「その行」を示す（設計書6.37.4）。
 *
 * **もとは `proposalPanel.ts` の「本文を見る」だけが持っていた。** 名前の
 * 点検の「登場箇所」も同じことをするので、別の経路を作らずここへ切り出した。
 * 2本に分けると、原稿エディタの都合（どの向きで開くか・画面が動き出したか）を
 * 直したときに片方だけが直る。
 */

/**
 * 原稿エディタで示せたか。
 *
 * **引き受けられたときだけ true を返す**約束になっている——素のエディタで
 * 書いている作者まで、勝手に縦書きの画面へ移さないため。
 */
export type RevealInManuscript = (
  filePath: string,
  line: number
) => Promise<boolean>;

/**
 * そのファイルの、その行へ飛ぶ。
 *
 * まず原稿エディタに任せ、引き受けられなかったとき（素のエディタで書いて
 * いる・原稿を開けなかった）だけ素のエディタで開く。
 *
 * @param line 1始まりの行番号
 * @param revealInManuscript 原稿エディタの口。渡さなければ素のエディタで開く
 */
export async function revealTextLocation(
  filePath: string,
  line: number,
  revealInManuscript?: RevealInManuscript,
  /** 記録に残すときの呼び名。どの画面から飛んだのかが分かるようにする */
  source = "提案パネル"
): Promise<void> {
  /*
    **降りた枝は、どれも1行残す**（`manuscriptEditor.ts` の `revealLine` と
    同じ考え方）。年表から話を押しても何も起きず、通知もログも1行も無くて
    原因を追えなかった（実機で発見、2026-09-05）。飛べなかったときに
    「どこで止まったか」が残っていないと、画面側と拡張機能側のどちらの
    不具合かすら分からない。
  */
  if (!filePath) {
    logStep(`${source}：飛び先のファイルが空だったので、何も開きませんでした。`);
    return;
  }

  try {
    if (await revealInManuscript?.(filePath, line)) {
      logStep(`${source}：原稿エディタが引き受けました（${filePath} ${line}行目）。`);
      return;
    }
  } catch (error) {
    // 原稿エディタ側で転んでも、飛べる道は残す（下で素のエディタを開く）。
    // **理由は残す。** 残さないと「押しても何も起きない」で終わる
    logStep(
      `${source}：原稿エディタで示せませんでした（${filePath} ${line}行目：${
        error instanceof Error ? error.message : String(error)
      }）。`
    );
  }

  try {
    // **文字列で渡さない。** 文字列を受ける口はローカルのファイルパスと
    // みなすので、ブラウザ上の作品（`vscode-vfs://github/...`）では
    // 開けない。場所の組み立ては `paths.ts` を通す（CLAUDE.md 規則7）
    const doc = await vscode.workspace.openTextDocument(path.toUri(filePath));
    const editor = await vscode.window.showTextDocument(doc, {
      preserveFocus: false,
    });
    const lineIndex = Math.min(Math.max(line - 1, 0), doc.lineCount - 1);
    const range = doc.lineAt(lineIndex).range;
    editor.selection = new vscode.Selection(range.start, range.end);
    editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
    logStep(`${source}：素のエディタで示しました（${filePath} ${line}行目）。`);
  } catch (error) {
    // **例外の中身を捨てない。** 通知は一言で済ませても、原因（見つからない
    // のか、開けないのか）はログに残らないと作者も開発側もたどり着けない
    logStep(
      `${source}：素のエディタでも開けませんでした（${filePath}：${
        error instanceof Error ? error.message : String(error)
      }）。`
    );
    vscode.window.showWarningMessage("該当のファイルを開けませんでした。");
  }
}
