import * as vscode from "vscode";

/**
 * 入力欄と選択画面の入口（設計書6.17.2）。
 *
 * **取りやめ方が分からない、という指摘から作った**（作者、2026-08-16）。
 *
 * VS Codeの入力欄と選択画面には**×ボタンが無い**。閉じる方法は
 * `Esc` を押すか、外側をクリックするかの2つしかない。
 * ところがこの拡張機能は、入力を失わせないために
 * **`ignoreFocusOut: true` を39か所で使っている**（外側をクリックしても
 * 閉じない）。つまり **`Esc` が唯一の出口なのに、それを書いていなかった。**
 *
 * `ignoreFocusOut` は外さない。作品名を入れている途中で別のウィンドウへ
 * 目を移した拍子に消えると、最初からやり直しになる（設計書6.4.1）。
 * **代わりに、出口を必ず書く。**
 *
 * 選択画面には**「取りやめる」を項目として置ける**ので、そちらは
 * 目に見える形にする（`cancelItem`）。
 */

/** 入力欄の説明の末尾に必ず付ける案内 */
export const CANCEL_HINT = "（Escキーで取りやめられます）";

/**
 * 文字を入力してもらう。
 *
 * **`showInputBox` を直接呼ばないこと。** 案内の付け忘れを防ぐため、
 * `test/unit/dialogCancel.test.ts` が直接呼び出しを見張っている。
 */
export async function askText(
  options: vscode.InputBoxOptions
): Promise<string | undefined> {
  return vscode.window.showInputBox({
    ...options,
    prompt: withCancelHint(options.prompt),
    // 入力の取りこぼしを防ぐ。そのぶん Esc の案内が要る
    ignoreFocusOut: options.ignoreFocusOut ?? true,
  });
}

/** 説明に案内を足す。既に入っていれば二重にしない */
export function withCancelHint(prompt: string | undefined): string {
  const body = prompt?.trim() ?? "";
  if (body.includes(CANCEL_HINT)) return body;
  return body ? `${body}${CANCEL_HINT}` : CANCEL_HINT.replace(/^（|）$/g, "");
}

/**
 * 選択画面に置く「取りやめる」の項目。
 *
 * **一覧の中に見えている形にする。** `Esc` を知らない作者にも
 * 出口が見える。押されたときの見分けは `isCancelItem` で行う。
 */
export function cancelItem(label = "取りやめる"): vscode.QuickPickItem & {
  readonly __cancel: true;
} {
  return {
    label: `$(close) ${label}`,
    // 一覧の並びから浮かせて、選択肢と読み違えないようにする
    detail: "何もせずに閉じます",
    __cancel: true,
  };
}

export function isCancelItem(item: unknown): boolean {
  return (
    typeof item === "object" &&
    item !== null &&
    (item as { __cancel?: boolean }).__cancel === true
  );
}
