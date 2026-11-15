import * as vscode from "vscode";

/**
 * 画面の部品の束（`dist/webview-elements.js`。`esbuild.js` の `webviewElements`）を、
 * パネルから読ませるための2つの値（作者の決定 2026-11-15）。
 *
 * **在りかは `extensionUri` から `joinPath` で作る。** `vscode.Uri.file()` や `path` を使うと、
 * ブラウザ版（vscode.dev）では拡張機能が `https://…` の在りかにあるため別の所を指す
 * （実装ルール7）。`asWebviewUri` は手元でもブラウザ版でも、画面から読める URI に変える。
 */
export function webviewElementsRoot(extensionUri: vscode.Uri): vscode.Uri {
  return vscode.Uri.joinPath(extensionUri, "dist");
}

/** 画面の `<script nonce="…" src="…">` に入れる URI（文字列） */
export function webviewElementsScriptUri(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  return webview
    .asWebviewUri(vscode.Uri.joinPath(webviewElementsRoot(extensionUri), "webview-elements.js"))
    .toString();
}
