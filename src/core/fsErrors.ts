import * as vscode from "vscode";

// 原稿の書き戻しの道（atomicWrite.ts）にも同じ判定が写してある。あちらは他の部品に頼らず独立させておくため、ここへは寄せない。
/** 読もうとしたファイルが無かったか（無いのは正常な場合の見分けに使う。他の失敗は呼び出し側で投げ直す）。 */
export function isFileNotFound(error: unknown): boolean {
  return error instanceof vscode.FileSystemError && error.code === "FileNotFound";
}
