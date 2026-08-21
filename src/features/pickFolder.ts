import * as vscode from "vscode";
import { fromUri } from "../core/paths";
import { canRunProcesses } from "../core/runtime";
import { cancelItem, isCancelItem } from "../views/dialogs";

/**
 * 作品フォルダー（またはその置き場）を選ぶ（設計書5.8.8）。
 *
 * **ブラウザ版では、フォルダーを選ぶダイアログを当てにできない。**
 * vscode.dev で開いているのはGitHubの仮想ファイルシステム
 * （`vscode-vfs://github/...`）で、そこにOSのファイル選択画面は無い。
 *
 * 代わりに**いま開いているフォルダー**（ワークスペース）から選ばせる。
 * ブラウザでは、そもそも作品はそこにしか無い——リポジトリを開いた状態が
 * 出発点なので、これで足りる。
 *
 * 手元のVS Codeでは、これまでどおりダイアログを出す。**作品はどこにでも
 * 置けるので、開いているフォルダーに限ると不便になる。**
 */

/** 選べるフォルダーが無いときに出す案内 */
const NO_FOLDER_HINT =
  "フォルダーが開かれていません。vscode.dev でGitHubのリポジトリを開いてから、もう一度お試しください。";

/**
 * @param purpose 選択画面の見出しに出す目的（「作品フォルダを選択」など）
 * @param openLabel ダイアログのボタン文言（手元のVS Codeでのみ使う）
 */
export async function pickFolder(
  purpose: string,
  openLabel: string
): Promise<string | undefined> {
  if (canRunProcesses()) {
    const picked = await vscode.window.showOpenDialog({
      canSelectFolders: true,
      canSelectFiles: false,
      canSelectMany: false,
      openLabel,
      title: purpose,
    });
    if (!picked || picked.length === 0) return undefined;
    return fromUri(picked[0]);
  }

  return pickFromWorkspaceFolders(purpose);
}

/**
 * 開いているフォルダーから選ぶ。
 *
 * **1つしか無くても選択画面を出す。** 黙って決めると、作者は何が
 * 登録されようとしているのか分からないまま次の画面（作品名の入力）へ
 * 進むことになる。
 */
async function pickFromWorkspaceFolders(
  purpose: string
): Promise<string | undefined> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) {
    await vscode.window.showWarningMessage(NO_FOLDER_HINT);
    return undefined;
  }

  const items: Array<vscode.QuickPickItem & { folderPath?: string }> = folders.map(
    (folder) => ({
      label: folder.name,
      description: describeFolder(folder.uri),
      folderPath: fromUri(folder.uri),
    })
  );

  const picked = await vscode.window.showQuickPick<
    vscode.QuickPickItem & { folderPath?: string }
  >([...items, cancelItem()], {
    title: purpose,
    placeHolder: "いま開いているフォルダーから選びます",
    ignoreFocusOut: true,
  });
  if (!picked || isCancelItem(picked) || !picked.folderPath) return undefined;
  return picked.folderPath;
}

/**
 * 選択肢の右に出す説明。
 *
 * **どこのリポジトリかを見せる。** 同じ名前のフォルダーを別の場所で
 * 開いていることがあるので、名前だけでは選べない。
 */
export function describeFolder(uri: vscode.Uri): string {
  if (uri.scheme === "file") return uri.fsPath;
  // vscode-vfs://github/nonahisa/HisasNovels → github: nonahisa/HisasNovels
  const authority = uri.authority || uri.scheme;
  return `${authority}: ${uri.path.replace(/^\//, "")}`;
}
