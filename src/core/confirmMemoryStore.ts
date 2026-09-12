import * as vscode from "vscode";
import type { ConfirmMemory } from "./confirmMemory";

/**
 * 「以降は訊かない」の覚え書きを、VS Codeの設定へ置く薄い層。
 *
 * **設定に置くのは、依頼の「解除、変更は設定管理画面で」を満たすため。**
 * 独自のファイルへ持つと、解除するのに専用の画面が要る。設定なら
 * 「設定管理を開く」でそのまま見えて、手で消すこともできる。
 *
 * 書き込みは `Global`（ユーザー設定）。作品フォルダーはGitHubで同期され、
 * 編集部とも共有するので、**作品側へ書くと他人の環境の確認まで黙って
 * 消えてしまう。** 端末をまたいで同じにしたいのは作者本人の好みである。
 *
 * **`core` に置く。** 読むのは `views/notify.ts`（確認を出すところ）で、
 * `views` → `features` は依存の逆流になる（`manuscriptViewTypes.ts` と
 * 同じ理由で `core` へ寄せた）。設定を読む部品が `core` にあるのは
 * `countSettings.ts` などと同じ。
 */

const SECTION = "novelai";
const KEY = "confirm.remembered";

/** いま覚えているもの。設定が壊れていたら「何も覚えていない」に倒す */
export function readConfirmMemory(): ConfirmMemory {
  const raw = vscode.workspace.getConfiguration(SECTION).get<unknown>(KEY);
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};

  // **文字列でない値は捨てる。** 手で書き換えられる場所なので、
  // 数値や真偽値が入っていても落ちないようにする
  const entries = Object.entries(raw as Record<string, unknown>).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string"
  );
  return Object.fromEntries(entries);
}

/** 覚え書きを丸ごと置き換える */
export async function saveConfirmMemory(next: ConfirmMemory): Promise<void> {
  await vscode.workspace
    .getConfiguration(SECTION)
    .update(KEY, { ...next }, vscode.ConfigurationTarget.Global);
}
