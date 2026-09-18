/**
 * 前提（設計書6.94）が**揃っているか**の判定。**読んだものを渡してもらう。**
 *
 * ## なぜ `prerequisiteGate.ts` から切り出すか
 *
 * 揃っているかを見る規則そのもの——「モブだけの人物一覧は設定資料と
 * 数えない」「見出しだけのプロットは無いと数える」——は、ファイルの
 * 読み方とは関係のない話である。ところが関門（`features/prerequisiteGate.ts`）
 * は `vscode.workspace.fs` で読むので、**規則までが `vscode` の中に
 * 閉じ込められていた。**
 *
 * 外部AIの口（MCPの束）は `vscode` を静的に import できない
 * （`mcpReach.test.ts`）。写しを作れば、片方だけが古くなる——
 * **画面では止まるのにMCPでは通る**、あるいはその逆が起きる。
 * だから規則だけをここへ出し、読む仕事は呼ぶ側（画面は
 * `vscode.workspace.fs`、MCPは Node の `fs`）に残す。
 *
 * ここに `vscode` を持ち込まない。
 */

import { isBlankPlotSection, parsePlotMarkdown } from "./plotDoc";

/**
 * 設定資料があるか。
 *
 * **矛盾検知と同じ数え方にする**（`features/checkContradictions.ts` の
 * `collectSettings`）。人物（モブを除く）・場所・世界観のどれかがあれば
 * 照らし合わせる相手になる。**別の数え方をすると、「関門は通ったのに
 * 機能が走らない」「関門で止められたのに機能なら走れた」が起きる。**
 */
export function hasSettingsRecords(input: {
  /** 人物。**モブは数えない**（名前の無い通行人は照合の相手にならない） */
  readonly characters: readonly { readonly isMob?: boolean }[];
  readonly locationCount: number;
  readonly worldCount: number;
}): boolean {
  return (
    input.characters.some((character) => !character.isMob) ||
    input.locationCount > 0 ||
    input.worldCount > 0
  );
}

/** 各話あらすじがあるか。1件でもあれば材料になる */
export function hasSynopsisEpisodes(count: number): boolean {
  return count > 0;
}

/**
 * プロットに中身があるか。
 *
 * **見出しだけの雛形は「無い」と数える**（`features/checkDeviations.ts` の
 * `loadPlot` と同じ）。照らし合わせる相手にならないからである。
 *
 * @param text `設定/plot.md` の中身。ファイルが無ければ `undefined`
 */
export function hasWrittenPlot(text: string | undefined): boolean {
  if (text === undefined) return false;
  const sections = parsePlotMarkdown(text).sections;
  return Object.values(sections).some((body) => !isBlankPlotSection(body));
}

/**
 * 単話プロットが1つでもあるか。
 *
 * **この判定は粗い。1つでもあれば通す**（6.94.6 の承知のうえの割り切り）。
 * どの話を検査するかは前提を見たあとに決まるので、ここでは「第何話ぶんが
 * 要るか」がまだ分からない。素通りしたあとは機能の側が
 * 「第3話の単話プロットがまだありません。」と正しく断る。
 *
 * @param fileNames 単話プロットの置き場（`設定/episode-plots/`）にある名前
 */
export function hasEpisodePlotFile(fileNames: readonly string[]): boolean {
  return fileNames.some((name) => name.endsWith(".md"));
}
