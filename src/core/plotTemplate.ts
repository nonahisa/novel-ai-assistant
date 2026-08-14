import { buildPlotMarkdown, emptyPlotSections } from "./plotDoc";

/**
 * プロット（`設定/plot.md`）の初期テンプレート。
 *
 * 新規作品を「プロットから始める」で作ったときと、あとから
 * 「プロットをつくる」を実行したときの両方で使う。2か所に書くと、
 * 片方だけ項目を足したときに作品によって形が変わる。
 *
 * **見出しの定義は `plotDoc.ts` に一本化してある。** テンプレートと、
 * プロット逆算生成（P-02）の書き戻しが同じ形を使う必要があるため。
 * 別々に持つと、逆算した内容が既存の見出しに入らず、同じ節が二重に並ぶ。
 */
export function buildPlotTemplate(title: string): string {
  return buildPlotMarkdown(title, emptyPlotSections(), { hints: true });
}
