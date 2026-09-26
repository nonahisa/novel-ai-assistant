import type { EpisodeFile } from "../models/types";
import { parseEpisodeMetadata } from "./metadataParser";
import { parseCollectedFile, type CollectedEpisode } from "./collectedFile";
import { blankMemoLines } from "./sceneMemo";
import type { ExcerptSource } from "./mentionExcerpts";
import { episodeLabel } from "./episodeLabel";

/**
 * 1ファイルの本文を、出典ラベル付きのテキストへ割る（`loadExcerptSources` の中身）。
 *
 * **`core/manuscriptSources.ts` から切り出したのは、MCP の束からも同じものを
 * 通すため**（2026-09-26、矛盾検知の過去の場面を製品と揃えたとき）。あちらは
 * 作品の走査（`scanner.ts`）と読み込み（`textFile.ts`）が `vscode` を読むので、
 * MCP からは呼べない。読んだあとの割り方だけをここに置く。
 *
 * **`vscode` を持ち込まない**（`test/unit/cross/mcpReach.test.ts` が見張る）。
 */
export type ExcerptEpisode = Pick<
  EpisodeFile,
  | "filePath"
  | "fileName"
  | "metaTitle"
  | "subtitle"
  | "kind"
  | "chapterStart"
  | "chapterEnd"
>;

export function excerptSourcesOfEpisode(
  episode: ExcerptEpisode,
  rawText: string
): ExcerptSource[] {
  // 合本は話ごとの出典にする。1つの塊にすると
  // 「どの話に書いてあったか」を示せない
  const collected = parseCollectedFile(rawText);
  if (collected) {
    const sources: ExcerptSource[] = [];
    for (const inner of collected) {
      const body = blankMemoLines(inner.body);
      if (!body.trim()) continue;
      sources.push({
        label: collectedEpisodeLabel(episode, inner),
        text: body,
        chapter: inner.chapter,
        filePath: episode.filePath,
      });
    }
    return sources;
  }

  const body = blankMemoLines(parseEpisodeMetadata(rawText).body);
  if (!body.trim()) return [];
  return [
    {
      label: episodeLabel(episode),
      text: body,
      chapter: episodeChapter(episode),
      filePath: episode.filePath,
    },
  ];
}

/**
 * 合本の中の1話の出典名。
 *
 * 話数が読み取れなければファイル内の並び順で示す。
 * **並び順を話数として出さない**（「プロローグ」を第1話と呼んでしまうため）。
 */
export function collectedEpisodeLabel(
  file: Pick<EpisodeFile, "fileName">,
  inner: CollectedEpisode
): string {
  const chapter =
    inner.chapter !== null ? `第${inner.chapter}話` : `${file.fileName}の${inner.order}番目`;
  return inner.title ? `${chapter} ${inner.title}` : chapter;
}

/**
 * その話が「第何話」かを返す。決められなければ null。
 *
 * **本編（と、種別を読めなかったもの）だけを数える。** プロローグ・
 * 幕間・エピローグは `chapterStart` に番号が入っていても「第N話」では
 * ないので（`episodeLabel.ts` の `chapterPart` が「プロローグ1」と
 * 書き分けている）、話数として扱うと本編の第1話と前後を比べてしまう。
 *
 * 範囲を持つ話は**終わりの話数**を返す（`ExcerptSource.chapter` の注釈）。
 */
function episodeChapter(
  episode: Pick<EpisodeFile, "kind" | "chapterStart" | "chapterEnd">
): number | null {
  if (episode.kind !== "本編" && episode.kind !== "不明") return null;
  return episode.chapterEnd ?? episode.chapterStart;
}
