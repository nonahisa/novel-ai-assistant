/**
 * HTML の文章部分・属性値へ差し込む文字列の逃がし。
 *
 * どこにも依存しない葉の部品。ルビの変換（ruby.ts）と原稿の表示の土台
 * （manuscriptRender.ts）が同じ中身を別々に持っていたのを1つにした。
 * 置き換えの順（`&` を先に）が崩れると二重に逃がすので、順を変えない。
 * ここは `"` も逃がす（markdownLite.ts のものは逃がさない別物）。
 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
