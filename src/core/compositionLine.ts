/**
 * 設定「変換中の線」（縦書きで変換中の字の線を、行の左右どちらに出すか。設計書6.25.2 の【裁定】
 * 2026-11-16 夜）の名前と値。**名前と値はここ1か所に置く**——モバイル版と名前をそろえるときに、
 * ここと package.json（`compositionLine.test.ts` が一致を見張る）だけを直せば済むようにするため。
 *
 * - `"left"`（既定）：今までの打つ面・組んで書く面。線は日本語入力が引くので左に出る
 * - `"right"`（テスト中）：縦書きのときだけ、右傍線の入力欄（`rightImeLineScript.ts`）に切り替える
 */

/** `vscode.workspace.getConfiguration` に渡す節 */
export const COMPOSITION_LINE_SECTION = "novelai";
/** 節の中の鍵 */
export const COMPOSITION_LINE_KEY = "compositionLine";
/** 設定の名前（package.json の contributes.configuration の鍵） */
export const COMPOSITION_LINE_SETTING = `${COMPOSITION_LINE_SECTION}.${COMPOSITION_LINE_KEY}`;

export const COMPOSITION_LINE_VALUES = ["left", "right"] as const;
export type CompositionLine = (typeof COMPOSITION_LINE_VALUES)[number];
export const COMPOSITION_LINE_DEFAULT: CompositionLine = "left";

/**
 * 設定に書かれた値を読む。**知らない値は既定（左）にする**——settings.json へ手で書いた
 * 綴りの違いで、テスト中の入力欄へ黙って切り替わらないため
 */
export function readCompositionLine(value: unknown): CompositionLine {
  return value === "right" ? "right" : COMPOSITION_LINE_DEFAULT;
}
