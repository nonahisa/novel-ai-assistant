/**
 * 原稿エディタの入口のID（設計書6.25.4）。
 *
 * **`features/manuscriptEditor.ts` から切り出してある。** 作品一覧
 * （`views/workTree.ts`）が「話を開くときの既定の画面」としてこのIDを使う
 * ようになったが、あちらから原稿エディタの実体を import すると
 * `views → features` の逆流になり、一覧を出すだけで原稿エディタの束
 * （WebViewの組み立て・ルビ・用語索引）まで引き込むことになる。
 *
 * **IDは文字列でしかない**ので、依存の向きに関わらず誰でも参照してよい
 * ものとして `core` へ置いた。`package.json` の `customEditors` と
 * 一致していることは `test/unit/manuscriptEditorEntries.test.ts` が見る。
 */

import type { WorkFormatKey } from "./workFormat";

export const MANUSCRIPT_EDITOR_VIEW_TYPE = "novelai.manuscriptEditor";

/**
 * 横書きで開く入口（作者の依頼、2026-08-27）。
 *
 * **本文ファイルを開くときの既定はこちら**（作者の指示、2026-08-29）。
 * 縦書きは、作者が「エディターを再度開く」や画面の切り替えで選ぶ。
 */
export const MANUSCRIPT_EDITOR_HORIZONTAL_VIEW_TYPE =
  "novelai.manuscriptEditorHorizontal";

/**
 * そのタイプの本文を開くときの、既定の入口（設計書6.70）。
 *
 * **脚本だけ縦書きにする**（作者の指定、2026-09-04）。台本は縦書きで
 * 組むのが普通で、横書きで開くと書き出しの一行目から向きを直すことに
 * なる。ほかのタイプはこれまでどおり横書き。
 *
 * 型だけを見る関数にしてあるので、`views` からでも `features` からでも
 * 同じ答えを引ける（開く場所ごとに違う既定を持たせない）。
 */
export function manuscriptViewTypeFor(format?: WorkFormatKey): string {
  return format === "script"
    ? MANUSCRIPT_EDITOR_VIEW_TYPE
    : MANUSCRIPT_EDITOR_HORIZONTAL_VIEW_TYPE;
}
