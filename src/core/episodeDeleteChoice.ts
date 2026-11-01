/**
 * 話の右クリックの「この話を削除」で訊く問い（作者の判断 2026-11-02）。
 *
 * ## なぜ1つにしたか
 *
 * これまでは「ファイルを削除」と「この話を削除（話数を詰める）」が並んでいた。
 * どちらも話を消すので、作者はどちらを押せばよいか迷う。**入口を1つにし、
 * 押してから「話数を詰める／詰めない（ファイルだけ消す）」を訊く。**
 * 消し方はどちらもごみ箱へ送る（元に戻せる）。
 *
 * 2つのコマンド（`novelai.deleteEpisodeFile`・`novelai.removeEpisodeAndRenumber`）は
 * 残す。相談からの操作（`chatEdit`）や試験が ID で呼んでいる。
 *
 * VS Code API に依存しない（問いの道を画面なしで確かめるため）。
 */

/**
 * 話数を詰められる話の `contextValue`（`workTypeContextValue("episode", …)`）。
 *
 * **「話の前に挿入」の右クリックと同じ条件**（package.json の `when`）。
 * 番号で数える形式の話だけが当たり、SNS記事・メモは外れる。片方だけ直すと、
 * 挿入できるのに詰められない話が出る（`episodeDeleteChoice.test.ts` が見る）。
 */
export const RENUMBERABLE_EPISODE_CONTEXT =
  /^episode-(novel|script|unset)(-(essay|lyrics))?$/;

/** その話で「話数を詰める」を選べるか */
export function canRenumberOnDelete(contextValue: string): boolean {
  return RENUMBERABLE_EPISODE_CONTEXT.test(contextValue);
}

/** 問いの選択肢（作者の指定の言葉） */
export const EPISODE_DELETE_CHOICES = {
  renumber: "話数を詰める",
  fileOnly: "詰めない（ファイルだけ消す）",
} as const;

export type EpisodeDeleteRoute = "renumber" | "fileOnly";

/** 押された選択肢から道を決める。閉じた・ほかの言葉なら undefined（何もしない） */
export function routeOfDeleteAnswer(
  answer: string | undefined
): EpisodeDeleteRoute | undefined {
  if (answer === EPISODE_DELETE_CHOICES.renumber) return "renumber";
  if (answer === EPISODE_DELETE_CHOICES.fileOnly) return "fileOnly";
  return undefined;
}
