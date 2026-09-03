/**
 * 左側の4つのビュー（作品一覧・簡単ステップメニュー・詳細メニュー・AIに相談）の
 * 出し入れに使う印（設計書6.29.4）。
 *
 * 出し入れそのものは `package.json` のビューの `when` 式が決めており、
 * 見ているのはここにある2つの印だけである。
 *
 * ## なぜ起動のたびに入れ直すのか（作者の報告、2026-09-03）
 *
 * 「VSCodeを再起動したとき、詳細メニューの下に『AIに相談』が無いことがある」。
 *
 * 印は `setContext` で立てるだけで、**拡張機能は起動時に初期値を入れていなかった。**
 * `setContext` の印を持っているのは拡張機能ではなくVS Code側なので、
 * **拡張機能ホストだけが再起動したとき（クラッシュからの復帰・
 * 「Restart Extension Host」・拡張機能の入れ替え）、前の印はそのまま残る。**
 * 残ったのが `soloView = 'actions'` なら、相談のビューだけが消えた状態で
 * 立ち上がり、拡張機能側には戻す機会が無い。
 *
 * **どちらの印も「いまの作業に集中する」ための一時的な畳み方**であって、
 * 次の起動まで持ち越す設定ではない（`setSoloView` の説明にあるとおり、
 * 閉じ込め事故のほうが高くつく）。だから起動時は素の状態から始める。
 *
 * **ビューを前面に出す（focus）ことはしない。** 目的は「サイドバーを開けば
 * 見出しが在る」ことであって、起動のたびに相談へ場所を奪うことではない。
 */

/** 相談に集中する表示（設計書6.21.2）。ほかのビューを引っ込める */
export const FOCUS_CHAT_KEY = "novelai.focusChat";

/** 1つのメニューだけを残す（作者の依頼、2026-08-29）。残すビューの短い名前 */
export const SOLO_VIEW_KEY = "novelai.soloView";

/**
 * 起動直後の印。**4つのビューがすべて出ている素の状態。**
 *
 * `soloView` は `undefined`（印なし）が「全部出す」であり、
 * 空文字などの別の値を入れてはいけない——`when` 式は
 * `novelai.soloView == 'works'` の形でも見るため、値の形が変わると
 * 片方の式だけが通ってしまう。
 */
export function initialViewContext(): Record<string, unknown> {
  return { [FOCUS_CHAT_KEY]: false, [SOLO_VIEW_KEY]: undefined };
}

/**
 * 印を素の状態へ戻す。
 *
 * `setContext` を引数で受け取るのは、**VS Code を持ち込まずに試験するため**。
 * ここが決めているのは「どの印へ、どの値を入れるか」だけである。
 */
export async function resetViewVisibility(
  setContext: (key: string, value: unknown) => unknown
): Promise<void> {
  const initial = initialViewContext();
  // 順番は focusChat が先。こちらが真だとほかの3つがまとめて消えるので、
  // 先に落としておくと、途中で失敗しても「相談だけ残る」形にはならない
  for (const key of [FOCUS_CHAT_KEY, SOLO_VIEW_KEY]) {
    await setContext(key, initial[key]);
  }
}
