import { formatCount } from "./charCount";

/**
 * 執筆量の言い方（作者の指定、2026-09-06）。
 *
 * **減った日を「−12字」と出さない。** 推敲で削った日は「書かなかった日」
 * ではないのに、負の数を見ると「マイナス＝良くないこと」と読めてしまう。
 * 記号ではなく言葉で「削った 12字」と言う。
 *
 * ステータスバー・執筆量パネルの合計・日別のどこでも同じ言い方にする
 * （数え方と同じで、場所によって言い方が変わると読み違える）。
 *
 * **画面（WebView）のぶんは、この関数を呼べない**——WebViewの中は
 * 文字列として埋め込むスクリプトだからである。同じ言い方になっているかは
 * `writingStatsPanelHtml.test.ts` が見張る。
 */
export function describeWrittenAmount(net: number): string {
  if (net < 0) return `削った ${formatCount(-net)}字`;
  return `${net > 0 ? "+" : ""}${formatCount(net)}字`;
}
