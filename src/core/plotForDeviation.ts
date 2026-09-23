/**
 * 逸脱検知（P-11）へ渡すプロットの切り詰め（設計書6.77の第2段、6.87.8）。
 *
 * **`core` へ置いたのは、製品と外から呼ぶ口の両方が同じものを通るため。**
 * 製品（`features/checkDeviations.ts`）はここで切ってから送るのに、
 * MCP の道具（`mcp/tools/episode.ts`）はプロットの全文をそのまま渡しており、
 * 76,471字のプロットでも切らず、切ったことも知らせていなかった
 * （MCP で測って分かった。2026-09-17）。**迂回した経路で測ると、製品に無い
 * 不具合を見つけたことになる**（CLAUDE.md の「繰り返し起きた失敗」5番）。
 *
 * **`vscode` を持ち込まない。** ここは外から呼ぶ束の起点でもある
 * （`scripts/coreEntries.mjs`。`test/unit/cross/mcpReach.test.ts` が見張る）。
 */

/**
 * プロットにまわしてよい字数の頭打ち。
 *
 * **プロットは話の数だけ繰り返し送られる。** 19話の作品なら19回、同じ
 * プロットが入力に積まれるので、ここだけ無上限だと送る量が話数ぶんに
 * 膨らむ。世界観（`worldviewSelect.ts`）と値は揃えてあるが、**寄せない**
 * ——どれだけまわしてよいかは用途ごとの判断である。
 *
 * モデルの上限に対する割合で縮める側は `features/checkDeviations.ts` の
 * `plotMaxChars()` が持つ（コンテキスト長は MCP の口では分からないので、
 * 外から呼ぶときはこの頭打ちだけが効く）。
 */
export const PLOT_MAX_CHARS = 30_000;

export interface TrimmedPlot {
  /** 実際に送るプロット */
  text: string;
  /** 送る字数。**切っていなくても入る**（記録と案内で使う） */
  usedChars: number;
  trimmed: boolean;
}

/**
 * プロットを上限まで切る。
 *
 * **切るのは末尾から**（＝残すのは先頭）。プロットは冒頭に設定・あらすじの
 * 骨子が来る書式（`plotTemplate.ts`）で、末尾ほど細部になる。逸脱の判定に
 * 効くのは骨格のほうである。
 *
 * **行の途中では切らない。** 切れ端の一行が残ると、AIはそれを完結した
 * 一文として読み、書かれていない筋を読み取る。最後の改行まで戻す。
 * ただし改行が一つも無いプロットでは戻れないので、そのときは素直に
 * 上限で切る（空を返すと、照らし合わせる相手が消える）。
 *
 * **上限内なら1バイトも変えない。** ここが1文字でも変わると、大多数の
 * 作品で送る内容が変わってしまう。
 */
export function trimPlotForDeviation(
  plot: string,
  maxChars: number = PLOT_MAX_CHARS
): TrimmedPlot {
  if (plot.length <= maxChars) {
    return { text: plot, usedChars: plot.length, trimmed: false };
  }
  const head = plot.slice(0, maxChars);
  const lastBreak = head.lastIndexOf("\n");
  const text = lastBreak > 0 ? head.slice(0, lastBreak) : head;
  return { text, usedChars: text.length, trimmed: true };
}

/**
 * 切ったことを伝える一文（完了報告・ログ・MCP の返り値で同じ言い方をする）。
 *
 * **黙って切らない。** プロットの末尾を落として問うているのに、作者からは
 * 「その部分については何も指摘が無かった」と見える。
 */
export function describePlotTrim(
  usedChars: number,
  totalChars: number
): string {
  return (
    `プロットが長いため先頭 ${usedChars.toLocaleString("ja-JP")}字だけを使いました` +
    `（全体 ${totalChars.toLocaleString("ja-JP")}字）`
  );
}
