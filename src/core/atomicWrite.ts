import * as crypto from "crypto";
import * as vscode from "vscode";

/**
 * 同じディレクトリ内で置換することで、書き込み途中の原稿を残さない。
 */
export async function atomicWriteFile(
  filePath: string,
  bytes: Uint8Array
): Promise<void> {
  const destination = vscode.Uri.file(filePath);
  const temporary = vscode.Uri.file(
    `${filePath}.novelai-${process.pid}-${crypto.randomUUID()}.tmp`
  );

  try {
    await vscode.workspace.fs.writeFile(temporary, bytes);
    await vscode.workspace.fs.rename(temporary, destination, { overwrite: true });
  } catch (error) {
    try {
      await vscode.workspace.fs.delete(temporary);
    } catch {
      // 一時ファイルが無い場合は元の失敗を優先する
    }
    throw error;
  }
}
