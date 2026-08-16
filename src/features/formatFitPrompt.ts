import * as vscode from "vscode";
import type { WorkEntry } from "../models/types";
import { formatWarningFor, type FormatSensitiveFeature } from "../core/formatFit";
import { readWorkFormat } from "../core/workFormatStore";

/**
 * 形式に合わない機能を実行する前に、断りを入れる（設計書6.4.5）。
 *
 * **止めない。** 形式はプロットに書かれた作者の申告で、実際の中身と
 * ずれていることがある。合わないから実行させない作りにすると、
 * 書き途中の作品で機能が使えなくなる。
 *
 * @returns 続けてよければ true
 */
export async function confirmFormatFit(
  work: WorkEntry,
  feature: FormatSensitiveFeature
): Promise<boolean> {
  const warning = formatWarningFor(feature, await readWorkFormat(work));
  if (!warning) return true;

  const answer = await vscode.window.showWarningMessage(
    warning.message,
    {
      modal: true,
      detail: `${warning.detail}\n\n形式はプロットの「## 形式」に書かれています。違っていればそちらを直してください。`,
    },
    "それでも実行する"
  );
  return answer === "それでも実行する";
}
