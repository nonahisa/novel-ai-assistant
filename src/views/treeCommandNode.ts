import * as vscode from "vscode";

/**
 * 作品一覧の右クリックから来た命令の行を受け取る（0.102.8）。
 *
 * **一覧の描き直しの最中に品書きを押すと、命令に行が渡らない。** VS Code の
 * 拡張機能ホストは、描き直しを求められた瞬間に「行の控え → 行の中身」の表を
 * 空にし、画面が行を取り直すまで埋めない。その隙間に押された品書きは、行の
 * 代わりに `undefined`（`null` のこともある）を命令へ渡す。
 *
 * これまでは `if (!node) return;` で黙って終わっていたため、作者には
 * 「押したのに何も起きない」としか見えなかった。**使えないときは理由を出す**
 * （実装ルール7と同じ考え方）——何が起きたかと、次の一手（落ち着いてから
 * もう一度右クリック）を1回だけ知らせる。
 *
 * 行を推し量って進めることはしない。右クリックは VS Code の「選んだ行」を
 * 変えない（焦点だけを動かす。1.138.0 の `TreeView.onContextMenu` で確かめた）
 * ので、`treeView.selection` から引き直すと、前に左クリックした**別の話**に
 * 挿入や削除をしかねない。
 *
 * @param action 品書きに出ている名前（「この話の前に挿入」など）。知らせに入れる
 */
export function requireTreeNode<T>(
  node: T | null | undefined,
  action: string,
  warn: (message: string) => unknown = (message) =>
    vscode.window.showWarningMessage(message)
): T | undefined {
  if (node !== undefined && node !== null) return node;
  void warn(
    `「${action}」を始められませんでした。どの行で押されたかを受け取れませんでした` +
      "（作品一覧を読み直している最中に押すと、こうなることがあります）。" +
      "一覧の表示が落ち着いてから、もう一度その行を右クリックして選んでください。"
  );
  return undefined;
}
