import { parseCollectedFile } from "./collectedFile";
import { parseEpisodeMetadata } from "./metadataParser";
import { mergeAdjacentChunks, splitIntoChunks, type Chunk } from "./chunker";

/**
 * 1ファイル分の本文を、AIへ送るチャンクに切る（設計書6.23）。
 *
 * ## なぜ共通にするか
 *
 * 全話が1ファイルに入った形（合本）は、走査（`scanner.ts`）では**1件の話**
 * になる（`chapterStart`＝中の最小話数、`chapterEnd`＝最大話数）。その1件の
 * テキストを丸ごと `splitIntoChunks` へ流すと、**全チャンクの話数が合本の
 * 先頭の話数（ふつう1）になる**。伏線の候補は内訳（`ChunkSegment`）の話数から
 * 話を決めるので、合本の作品では候補が全部「第1話で張られています」になる
 * （作者の報告、2026-09-12）。
 *
 * 正しい切り方は人物抽出・誤字脱字検知が既に持っていたが、**同じ手当てを
 * 各機能が写しで持つ**形になっていた。写しは片方だけが直され、片方は
 * 取り残される（実際に伏線・推敲・矛盾検知の3つが取り残された）。
 * 切り方はここ1か所に置き、各機能は「競合マーカーなら飛ばす」「読めなければ
 * 数える」「見出しの一覧を作る」といった、その機能にしか要らないものだけを持つ。
 */

/** 走査が返す話の範囲。合本では中の最小〜最大になっている */
export interface EpisodeChapterRange {
  chapterStart: number | null;
  chapterEnd: number | null;
}

/**
 * 1ファイルから取り出した、話1つ分の本文。
 *
 * ばらのファイルなら1件、合本なら中の話の数だけ返る。
 */
export interface EpisodeBodySource {
  filePath: string;
  /** 頭書き・後書き・リアクションを外した本文 */
  body: string;
  chapterStart: number | null;
  chapterEnd: number | null;
  /**
   * この本文が、元ファイルの何行目から始まるか（0始まり）。
   *
   * **本文だけを切り出すと、行番号が元ファイルとずれる。** 誤字脱字と推敲は
   * AIに「何行目」を言わせ、その値で本文の位置を決めるので、戻せないと
   * **別の行を書き換える**ことになる。チャンクの `startLine` へ足して返す。
   */
  lineOffset: number;
  /** 合本の中の1話か。まとめ方（下の `chunksOfSources`）を分けるのに使う */
  insideCollected: boolean;
}

export interface EpisodeChunkOptions {
  /** 1チャンクの目安文字数 */
  maxChars: number;
  /**
   * 合本の中の話を、何字までまとめ直すか。0・未指定ならまとめない。
   *
   * **話ごとに分けたぶん、送る単位まで小さくしない。** 合本の中の話は
   * もともと1つのファイルの続きで、分けたのは話数を付けるためであって、
   * 呼び出しを増やすためではない。実データ（219話・70万字）では、
   * 6,000字でまとめると174回になり、分ける前の41回から4倍以上に増える。
   * 話数はまとめても内訳（`segments`）に残るので、詰め直してよい。
   *
   * **ばらのファイルはここでまとめない。** ファイルをまたぐまとめは
   * 呼び出し側が全ファイル分を集めてから行う（二重に詰めないため）。
   */
  mergeChars?: number;
}

/**
 * 1ファイルを、話ごとの本文へ分ける。
 *
 * 合本なら中の話ごとに（話数はタイトルから読んだ値を使う）、
 * そうでなければ頭書きを外した本文を1本返す。
 */
export function episodeBodySources(
  filePath: string,
  rawText: string,
  episode: EpisodeChapterRange
): EpisodeBodySource[] {
  const collected = parseCollectedFile(rawText);
  if (collected) {
    const sources: EpisodeBodySource[] = [];
    // **前から順に探す。** 同じ本文が二度出てくる合本でも、2話目の位置を
    // 1話目の位置と取り違えない
    let searchFrom = 0;
    for (const inner of collected) {
      if (!inner.body.trim()) continue;
      const located = locateBody(rawText, inner.body, searchFrom);
      searchFrom = located.nextSearchIndex;
      sources.push({
        filePath,
        body: inner.body,
        // 合本の中の1話は、始まりも終わりも同じ話数である
        chapterStart: inner.chapter,
        chapterEnd: inner.chapter,
        lineOffset: located.line,
        insideCollected: true,
      });
    }
    return sources;
  }

  const body = parseEpisodeMetadata(rawText).body;
  if (!body.trim()) return [];
  const located = locateBody(rawText, body, 0);
  return [
    {
      filePath,
      body,
      chapterStart: episode.chapterStart,
      chapterEnd: episode.chapterEnd,
      lineOffset: located.line,
      insideCollected: false,
    },
  ];
}

/**
 * 話ごとの本文を、チャンクに切る。
 *
 * **合本の中の話だけを、ここでまとめ直す**（`mergeChars`）。ばらのファイルを
 * ここでまとめると、呼び出し側のまとめと二重になる。
 */
export function chunksOfSources(
  sources: readonly EpisodeBodySource[],
  options: EpisodeChunkOptions
): Chunk[] {
  const mergeChars = options.mergeChars ?? 0;
  const out: Chunk[] = [];
  /** まとめ待ちの、合本の中の話（同じファイルの続きのあいだだけ溜める） */
  let collected: Chunk[] = [];
  let collectedFile: string | null = null;

  const flushCollected = () => {
    if (collected.length === 0) return;
    out.push(
      ...(mergeChars > 0
        ? mergeAdjacentChunks(collected, { maxChars: mergeChars })
        : collected)
    );
    collected = [];
    collectedFile = null;
  };

  for (const source of sources) {
    const chunks = withLineOffset(
      splitIntoChunks(
        source.filePath,
        source.body,
        source.chapterStart,
        source.chapterEnd,
        { maxChars: options.maxChars }
      ),
      source.lineOffset
    );
    if (!source.insideCollected) {
      flushCollected();
      out.push(...chunks);
      continue;
    }
    if (collectedFile !== null && collectedFile !== source.filePath) {
      // 別の合本へ移った。ファイルをまたいでまとめない
      flushCollected();
    }
    collectedFile = source.filePath;
    collected.push(...chunks);
  }
  flushCollected();
  return out;
}

/**
 * 1ファイル分のテキストから、チャンクを作る。
 *
 * `episodeBodySources` と `chunksOfSources` を続けて呼ぶだけの入口。
 * 本文を先に集めてから切りたい機能（誤字脱字・推敲は、指示の字数を測って
 * からでないとチャンクの大きさを決められない）は、2つを別々に呼ぶ。
 */
export function chunksOfEpisodeFile(
  filePath: string,
  rawText: string,
  episode: EpisodeChapterRange,
  options: EpisodeChunkOptions
): Chunk[] {
  return chunksOfSources(
    episodeBodySources(filePath, rawText, episode),
    options
  );
}

/**
 * 切り出した本文が、元ファイルの何行目から始まるかを探す。
 *
 * 投稿サイトのダウンロードファイルは、本文の前に頭書き（【タイトル】など）が
 * ある。本文だけを切り出すと行番号がその分ずれるので、ずれ幅を返す。
 *
 * 見つからなければ0を返す（**ずらさない**）。取り違えた位置へずらすより、
 * ずらさないほうが害が小さい。
 *
 * @param fromIndex ここから後ろを探す。合本で同じ本文が二度出るときに、
 *   前の話の位置を返さないために使う
 */
export function locateBody(
  rawText: string,
  body: string,
  fromIndex: number
): { line: number; nextSearchIndex: number } {
  const normalized = rawText.replace(/\r\n?/g, "\n");
  const index = normalized.indexOf(body, fromIndex);
  if (index === -1) return { line: 0, nextSearchIndex: fromIndex };
  const line = normalized.slice(0, index).split("\n").length - 1;
  return { line, nextSearchIndex: index + body.length };
}

/** AIが返した、本文の中での行の範囲（1始まり） */
export interface IssueLineRange {
  lineStart: number;
  lineEnd: number;
}

/**
 * 話ごとに送った指摘の行番号を、元ファイルの行へ戻す。
 *
 * **チャンクを使わない機能のための口である。** 逸脱検知は1話まるごとを
 * 1回で送るのでチャンク（`locateChunkLine`）を通らないが、合本の中の話と
 * 頭書きのあるファイルでは、**送った本文の1行目がファイルの先頭ではない。**
 * 戻さないと「該当箇所へ移動」が別の話の行を開く。
 *
 * @param lineOffset `EpisodeBodySource.lineOffset`（0始まり）。
 *   本文がファイルの先頭から始まるなら0で、そのときは何も変わらない
 */
export function shiftLines(
  range: IssueLineRange,
  lineOffset: number
): IssueLineRange {
  return {
    lineStart: range.lineStart + lineOffset,
    lineEnd: range.lineEnd + lineOffset,
  };
}

/**
 * チャンクの行番号を、元ファイルのものへ直す。
 *
 * **内訳（`segments`）の行番号も一緒に直す。** まとめたあとに
 * `locateChunkLine` が見るのは内訳のほうで、片方だけ直すと
 * 指摘が頭書きの行数ぶんずれた行を指す。
 */
function withLineOffset(chunks: Chunk[], lineOffset: number): Chunk[] {
  if (lineOffset === 0) return chunks;
  return chunks.map((chunk) => ({
    ...chunk,
    startLine: chunk.startLine + lineOffset,
    segments: chunk.segments?.map((segment) => ({
      ...segment,
      startLine: segment.startLine + lineOffset,
    })),
  }));
}
