import * as vscode from "vscode";
import { toUri } from "./paths";

/** 見つからない場合だけfalseとし、権限・一時障害は呼び出し元へ伝える。 */
export async function pathExists(filePath: string): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(toUri(filePath));
    return true;
  } catch (error) {
    if (
      error instanceof vscode.FileSystemError &&
      error.code === "FileNotFound"
    ) {
      return false;
    }
    throw error;
  }
}
