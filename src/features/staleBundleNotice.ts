import * as vscode from "vscode";
import { isStaleBundleError } from "../core/staleBundle";
import { logFailure, useLogFile } from "../core/logger";

/**
 * コマンドが落ちたとき、**拡張機能が裏で入れ替わったせいなら**受け止めて
 * 案内する（設計書6.106）。
 *
 * VS Code が更新すると古い版のフォルダーが消えるのに、開いている
 * ウィンドウは古い版を動かし続ける。この拡張機能はコマンドの本体を
 * 押されたときに読む作りなので、押した瞬間に「もう無いフォルダー」を
 * 探しに行って落ちる。作者の画面には素の「システム エラー」しか
 * 出ていなかった。
 *
 * **それ以外の失敗には何もしない**（`false` を返し、呼び出し側が同じ失敗を
 * そのまま投げ直す）。作品ファイルの ENOENT（原稿を退避した・消えた）で
 * 「再読み込みしてください」と出すと、作者は再読み込みしても直らない
 * ものを直そうとする。
 *
 * `extension.ts` のコマンドの包みから切り出した（0.85.2）。`activate` は
 * 単体で動かせないので、ここに置くと「作品ファイルの ENOENT では元の失敗が
 * そのまま出る」ことを試験で確かめられる。
 *
 * @returns 受け止めて案内したら true
 */
export function handleStaleBundleFailure(
  error: unknown,
  extensionPath: string,
  command: string
): boolean {
  if (!isStaleBundleError(error, extensionPath)) return false;

  /*
    **保管庫側のログへ書く**（作品が決まらない出来事なので）。包みの中に
    あった頃は、直前に触っていた作品のログへ紛れることがあった。
  */
  useLogFile(undefined);
  logFailure("拡張機能の更新", {
    操作: command,
    詳細: error instanceof Error ? error.message : String(error),
  });
  void vscode.window
    .showErrorMessage(
      "拡張機能が更新されています。ウィンドウを再読み込みしてください。",
      "再読み込み"
    )
    .then((choice) => {
      if (choice === "再読み込み") {
        void vscode.commands.executeCommand("workbench.action.reloadWindow");
      }
    });
  return true;
}
