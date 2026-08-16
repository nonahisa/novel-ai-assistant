import { PLOT_SECTIONS } from "./plotDoc";

/**
 * プロット（`設定/plot.md`）の書き出し。
 *
 * 新規作品を「プロットから始める」で作ったときと、あとから
 * 「プロットをつくる」を実行したときの両方で使う。
 *
 * **用紙ではなく、書き出しにする**（作者の指示、2026-08-16）。
 * 以前は決まった10個の見出しを空のまま並べていた。開いた瞬間に
 * 埋めるべき欄が10個あるのは、**自由に書くための文書ではなく記入用紙**
 * である。プロットは作者の文書なので、形は作者が決めてよい。
 *
 * 見出しを2つだけ置くのは、白紙よりは書き始めやすいためである。
 * 残りの見出しは案内に名前だけ並べる。**使いたい人には名前が要り、
 * 使わない人には空欄が要らない。**
 *
 * ここに置いた見出しも消してよい。`updatePlotMarkdown` は
 * **消された見出しを復活させない。**
 */

/** 書き出しに置く見出し。白紙よりは書き始めやすい程度に留める */
const STARTERS = ["logline", "outline"] as const;

export function buildPlotTemplate(title: string): string {
  const starters = PLOT_SECTIONS.filter((section) =>
    (STARTERS as readonly string[]).includes(section.key)
  );
  const names = PLOT_SECTIONS.map((section) => section.heading).join("・");

  const lines = [
    `# ${title}`,
    "",
    "<!--",
    "このファイルは自由に書けます。見出しも順番も、好きに決めてかまいません。",
    "下の見出しは消してよく、思いついたことだけ書き並べても大丈夫です。",
    "",
    "AIに「本文からプロットを起こす」を頼んだとき、次の見出しがあれば",
    "**その場所へ**書き足します。無ければ末尾へ足します。",
    "既に書いてあるところは、確認せずに置き換えません。",
    "",
    `  ${names}`,
    "-->",
    "",
  ];

  for (const section of starters) {
    lines.push(`## ${section.heading}`);
    if (section.hint) lines.push(`<!-- ${section.hint} -->`);
    if (section.list) lines.push("- ");
    lines.push("");
  }

  return lines.join("\n");
}
