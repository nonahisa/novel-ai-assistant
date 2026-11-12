import * as vscode from "vscode";
import {
  CONVERT_TO_UTF8_COMMAND,
  UTF8_CONVERT_BUTTON,
  utf8ConvertFileArg,
} from "../core/utf8ConvertHint";
import { whenNoticePicked } from "../views/notify";

/**
 * Shift_JIS で書けない字で止めた知らせに、［UTF-8 に変換する］を添えて出す（設計書5.4.2、0.149.0）。
 *
 * 作者の指示（2026-11-09）：「知らせる時は、原稿の文字コード変換を案内してください」。
 * 案内の文（`UTF8_CONVERT_HINT`）は呼ぶ側が知らせの文に入れておく（文だけを返す所——パネルの
 * 状態欄・MCP——とそろえるため）。ここはボタンだけを足す。
 *
 * **押されるのを待たずに戻る**（`whenNoticePicked`）。待つと、知らせを閉じるまで呼んだ操作の
 * 「動いている」札を持ち続ける（実装ルールの「ボタンつきの知らせの答えを待つとき」）。
 */
export function offerUtf8Conversion(
  message: string,
  filePath: string,
  options: { severity?: "error" | "warning"; workFolder?: string } = {}
): void {
  const shown =
    options.severity === "error"
      ? vscode.window.showErrorMessage(message, UTF8_CONVERT_BUTTON)
      : vscode.window.showWarningMessage(message, UTF8_CONVERT_BUTTON);
  whenNoticePicked(
    shown,
    (picked) => {
      if (picked !== UTF8_CONVERT_BUTTON) return undefined;
      return vscode.commands.executeCommand(CONVERT_TO_UTF8_COMMAND, utf8ConvertFileArg(filePath));
    },
    { label: "原稿 UTF-8 変換", workFolder: options.workFolder }
  );
}
