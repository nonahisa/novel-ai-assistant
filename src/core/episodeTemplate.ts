import { formatChapterNumber, nextUntitledName } from "./episodeParser";
import type { WorkFormatKey } from "./workFormat";
import { kindEpisodeTemplate, type WorkKindKey } from "./workKind";

/**
 * 新しい話（メモ・投稿）を作るときの、最初の中身（設計書6.70・6.109）。
 *
 * **小説は空で作る。これまでの振る舞いで、そこは変えない。** 白紙に何かが
 * 書かれていると、作者はまずそれを消すところから始めることになる。
 * 台本・漫画の原作・エッセイ・歌詞は、**形そのものを知らせるほうが早い**
 * ——柱・ト書き・台詞が並んでいれば、どこに何を書くかが1画面で分かる。
 *
 * **形式ではなく種類で決める**（0.81.0〜。雛形の中身は `core/workKind.ts`）。
 *
 * VS Code APIに依存しない（作る側＝`novelai.addEpisode` と
 * 新規作品の第1話が、同じ中身を使うために切り出してある）。
 */
export function newEpisodeTemplate(kind?: WorkKindKey): string {
  return kindEpisodeTemplate(kind);
}

/**
 * 新しく作るファイルの拡張子（設計書6.70）。
 *
 * ふだんは作者の設定（`novelai.episodeFileExtension`）に従う。
 * **創作メモ集だけ `.md` にする**——メモは見出しや箇条書きで書き散らす
 * 場所で、Markdownの記法が効いたほうが読み返しやすい。設定のほうは
 * 「原稿（話）をどの形で書くか」の話であって、メモの話ではない。
 */
export function newEpisodeExtension(
  format: WorkFormatKey | undefined,
  configured: string
): string {
  return format === "memo" ? ".md" : configured;
}

/**
 * その作品の**最初の1件**のファイル名（設計書6.70）。
 *
 * 小説・脚本・SNS記事は、これまでどおり番号（`001.txt`）から始める。
 * **創作メモ集は題名で並ぶ**ので「無題」から始め、あとで書きながら
 * 名前を付け替えてもらう（番号の無いファイルが普通のタイプである）。
 */
export function firstEpisodeFileName(
  format: WorkFormatKey | undefined,
  naming: { digits: number; extension: string }
): string {
  const extension = newEpisodeExtension(format, naming.extension);
  if (format === "memo") return nextUntitledName([], "無題", extension);
  return `${formatChapterNumber(1, naming.digits)}${extension}`;
}
