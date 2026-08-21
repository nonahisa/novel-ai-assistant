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

/**
 * フォルダーかどうか。見つからない・権限が無いなどは false にする。
 *
 * **`node:fs` の `stat` ではなく `vscode.workspace.fs` を使う。** ブラウザ版の
 * VS Codeには `node:fs` が無く、作品はローカルとは限らない
 * （`vscode-vfs://github/...` にある。設計書5.8）。
 */
export async function isDirectory(target: string): Promise<boolean> {
  try {
    const stat = await vscode.workspace.fs.stat(toUri(target));
    return (stat.type & vscode.FileType.Directory) !== 0;
  } catch {
    return false;
  }
}

/** フォルダー直下の名前一覧。読めなければ投げる（呼び出し側が理由を出す） */
export async function listDirectory(folderPath: string): Promise<string[]> {
  const entries = await vscode.workspace.fs.readDirectory(toUri(folderPath));
  return entries.map(([name]) => name);
}
