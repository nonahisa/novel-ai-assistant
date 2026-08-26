import type { EpisodeFile } from "../models/types";
import { nextChapterNumber, parseEpisodeFileName } from "./episodeParser";

/**
 * 「最新話を書く」で、どのファイルを開くかを決める（設計書6.25.5）。
 *
 * 作者の依頼（2026-08-27）：「下段に『最新話を書く』ボタンを追加してください」。
 *
 * ## 決め方
 *
 * | いまの状態 | どうするか |
 * |---|---|
 * | いちばん新しい話が**まだ白紙** | それを開く |
 * | いちばん新しい話に**本文がある** | 次の話を新しく作って開く |
 * | 話が1つも無い | 第1話を作って開く |
 *
 * 白紙のときに次を作らないのは、**押すたびに空のファイルが増える**のを
 * 避けるためである（続きを書こうとしただけで、書いていない話が溜まる）。
 *
 * ## ここは決めるだけ
 *
 * ファイルを作るのも開くのも呼び出し側が行う。**vscodeにもファイルにも
 * 触らない**ので、単体テストで固められる（5.5.14と同じ置き方）。
 */

export type LatestEpisodePlan =
  /** この話を開く（まだ白紙） */
  | { kind: "open"; episode: EpisodeFile }
  /** この名前で新しく作って開く */
  | { kind: "create"; fileName: string; chapter: number };

/**
 * 話を新しく作るときの名前の決まり。**`novelai.addEpisode` と揃える**
 * （揃えないと、同じ作品の中でファイル名の形が2種類できる）。
 */
export interface EpisodeNaming {
  /** 話数の桁数（設定 `novelai.episodeNumberDigits`） */
  digits: number;
  /** 拡張子（設定 `novelai.episodeFileExtension`） */
  extension: string;
}

/**
 * いちばん新しい話を選ぶ。
 *
 * **話数で見る。** ファイルの並び順や更新時刻では決めない——
 * 並び順は名前の付け方で変わり、更新時刻は同期で書き換わる（5.5.13で踏んだ）。
 * 話数が読めないファイル（「プロローグ」など）しか無いときは、
 * **最後のものを最新とみなす**（走査の並びは話数・名前の順である）。
 */
export function findLatestEpisode(
  episodes: readonly EpisodeFile[]
): EpisodeFile | undefined {
  if (episodes.length === 0) return undefined;

  const numbered = episodes.filter((episode) => episode.chapterEnd !== null);
  if (numbered.length === 0) return episodes[episodes.length - 1];

  return numbered.reduce((latest, episode) =>
    (episode.chapterEnd ?? 0) > (latest.chapterEnd ?? 0) ? episode : latest
  );
}

/**
 * 何を開くかを決める。
 *
 * @param isBlank いちばん新しい話が白紙か。**中身を読むのは呼び出し側**
 *   （ここはファイルに触らない）
 */
export function planLatestEpisode(
  episodes: readonly EpisodeFile[],
  isBlank: (episode: EpisodeFile) => boolean,
  naming: EpisodeNaming,
  formatName: (chapter: number, naming: EpisodeNaming) => string
): LatestEpisodePlan {
  const latest = findLatestEpisode(episodes);
  if (latest && isBlank(latest)) return { kind: "open", episode: latest };

  const chapter = nextChapterNumber(
    episodes.map((episode) => parseEpisodeFileName(episode.fileName))
  );
  return { kind: "create", fileName: formatName(chapter, naming), chapter };
}

/** 本文が空か。**空白と改行だけなら白紙とみなす** */
export function isBlankText(text: string): boolean {
  return text.trim() === "";
}

/**
 * 走査の結果から、白紙かを見る。
 *
 * **ファイルを読み直さない。** 走査（`scanWork`）が数えた文字数を使う。
 * 何十話もある作品で、押すたびに全部を読み直すのは重い。
 *
 * 総文字数（空白や記号を含む数え方）を見るのは、**空白だけのファイルを
 * 「書きかけ」として扱う**ためである。純文字数だと空白だけの話が白紙になり、
 * 押すたびにそこへ戻ってしまう。
 */
export function isBlankEpisode(episode: {
  counts: { gross: number };
}): boolean {
  return episode.counts.gross === 0;
}
