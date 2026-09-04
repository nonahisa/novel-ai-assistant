import type { EpisodeFile } from "../models/types";
import { parseCollectedFile } from "./collectedFile";
import {
  bookHeading,
  collectedBookHeading,
  episodeTitle,
  formatChapterLabel,
  isCollectedFile,
  type BookChapterHeading,
} from "./episodeLabel";
import {
  isEpisodeSeparatorLine,
  parseEpisodeMetadata,
} from "./metadataParser";
import type { WorkFormatKey } from "./workFormat";

/**
 * 1つの原稿ファイルから、本に入る章を取り出す（設計書6.65.15）。
 *
 * **合本は話ごとに割って、1話＝1章にする。** 書き出し（`exportEpub`）は
 * 長いあいだ `parseEpisodeMetadata` だけを通っており、合本のファイルは
 * 区切り行（`------- エピソード2開始 -------`）も【エピソードタイトル】も
 * 【後書き】【リアクション】も、まるごと本文として本に入っていた。
 * 割り方は `collectedFile.ts` が既に持っているので、書き出しはそれを
 * 通すだけでよい。
 *
 * **合本かどうかは、この作品で既に決まっている判定に従う**
 * （`episodeLabel.ts` の `isCollectedFile`＝2話以上）。区切りが1本だけの
 * ファイルは「1話ぶんのダウンロード」であって合本ではなく、頭書きの
 * 落とし方は `parseEpisodeMetadata` が持っている（設計書6.65.15の段D）。
 * 境目を書き出し側で作り直すと、**単話の本が理由もなく変わる**。
 *
 * **原稿は読むだけ。** ここは受け取った文字列を切り分けるだけの純粋な
 * 関数で、ファイルには触れない。
 */

export interface BookChapterSplit extends BookChapterHeading {
  /** 本に組む本文（頭書き・後書き・区切りを外したもの） */
  body: string;
  /**
   * 合本の中の何番目の話か（区切り行の番号）。単話のファイルは null。
   *
   * 挿絵・改ページの指定は**ファイル単位**なので、合本では最初の話にだけ
   * 効かせる（下の `exportEpub` の判断）。その見分けにここを使う。
   */
  insideOrder: number | null;
}

export function bookChaptersOf(
  episode: EpisodeFile,
  rawText: string,
  format?: WorkFormatKey
): BookChapterSplit[] {
  const collected = parseCollectedFile(rawText);
  if (collected && isCollectedFile(collected.length)) {
    const chapters: BookChapterSplit[] = [];
    for (const inner of collected) {
      // **白紙の章を本へ入れない。** 区切りだけがあって本文の無い塊は、
      // 開いても何も書いていないページになる（`loadExcerptSources` と同じ扱い）
      if (!inner.body.trim()) continue;
      chapters.push({
        ...collectedBookHeading(episode, inner, format),
        body: inner.body,
        insideOrder: inner.order,
      });
    }
    // **1章も取れなかったら、割る前へ倒す**（0.32.6のレビュー）。
    // 区切りは2本以上あるのに【本文】ラベルがどこにも無い形があり、
    // 全話の body が空になるので上の「白紙は入れない」が全話に効いて、
    // **その原稿が本から丸ごと消えていた。** 頭書きが混ざるほうが、
    // 本文が消えるよりましである
    if (chapters.length > 0 || !hasWritingOutsideSeparators(rawText)) {
      return chapters;
    }
  }

  // 単話（区切りが無い／1本だけ）は、いままでどおり1ファイル＝1章。
  // **中身も見出しも1文字も変えない**
  const numberLabel = formatChapterLabel(episode, format);
  return [
    {
      heading: bookHeading(episode, format),
      numberLabel,
      title: episodeTitle(episode, numberLabel),
      body: parseEpisodeMetadata(rawText).body,
      insideOrder: null,
    },
  ];
}

/**
 * 本に組む本文だけを、話ごとに取り出す。
 *
 * 段落の一覧（EPUBエディターの位置指定）が使う。**組むときと同じ切り分けを
 * 通す**——別々に切ると、画面で指した段落と挿絵の入る場所がずれる
 * （設計書6.65.10）。
 */
export function bookChapterBodies(rawText: string): string[] {
  const collected = parseCollectedFile(rawText);
  if (collected && isCollectedFile(collected.length)) {
    const bodies = collected
      .map((inner) => inner.body)
      .filter((body) => body.trim() !== "");
    // 割れなかったときの倒し方は `bookChaptersOf` と揃える。
    // **別々に切ると、画面で指した段落と挿絵の入る場所がずれる**
    if (bodies.length > 0 || !hasWritingOutsideSeparators(rawText)) {
      return bodies;
    }
  }
  return [parseEpisodeMetadata(rawText).body];
}

/**
 * 区切り行を除いて、何か書かれているか。
 *
 * **「割れなかった」と「本当に空」を分ける。** 区切り行しか無いファイルを
 * 単話へ倒すと、白紙のページが本に入る（それは従来どおり0章＋通知でよい）。
 */
function hasWritingOutsideSeparators(rawText: string): boolean {
  return rawText
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .some((line) => line.trim() !== "" && !isEpisodeSeparatorLine(line));
}
