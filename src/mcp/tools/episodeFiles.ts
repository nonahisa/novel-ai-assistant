import * as fs from "node:fs";
import * as nodePath from "node:path";
import type { EpisodeFile } from "../../models/types";
import { emptyCounts } from "../../core/charCount";
import { countEpisodeChars } from "../../core/episodeCharCount";
import { parseEpisodeFileName } from "../../core/episodeParser";
import { parseEpisodeMetadata } from "../../core/metadataParser";
import { parseCollectedFile } from "../../core/collectedFile";
import { isWorkInfoFile } from "../../core/workInfoFile";
import { decodeBytes } from "../../core/textDecode";
import { compareEpisodes } from "../../core/episodeOrder";
import { listBodyFiles, resolveInsideFolder } from "./shared";

/**
 * 製品の走査（`core/scanner.ts` の `scanWork`）と同じ形の話の一覧を、Node の `fs` で組む
 * （MCP の読む口 `novel.read`。2026-10-16）。
 *
 * **年表と再開の1枚は `EpisodeFile` を受け取る。** `novel.scan` が返す軽い形
 * （`ScannedEpisode`）では足りない——話の種類・日付の名前・合本の範囲・字数・
 * 競合の跡が要る。`scanWork` は `vscode` を通るので束へ持ち込めないため、
 * **走査が使っているのと同じ部品**（ファイル名の解析・頭書き・合本・数え方・並べ方）を
 * ここで直に通す。写すのは「どのファイルを読むか」だけである。
 *
 * 製品との違い（どれも外部AIが読む材料の差で、作者の原稿には触れない）：
 * - 歩くのは `listBodyFiles`（本文フォルダーの直下の .txt/.md）。MCP のほかの道具と同じ
 * - ルビを字数から外すかの設定は VS Code の中にあるので、既定（外す）で数える
 * - 改行コードとシーンメモの印は持たない（読む口では使わない）
 */

export interface McpEpisodeFiles {
  /** 話数順（製品の走査と同じ並び）。`filePath` は絶対パス */
  episodes: EpisodeFile[];
  /** 読めた本文（絶対パス → 文字列）。競合の跡が残るファイルは入らない */
  texts: Map<string, string>;
  /** 読めなかったファイル（作品フォルダーからの相対） */
  unreadable: string[];
}

export function readEpisodeFiles(folder: string): McpEpisodeFiles {
  const episodes: EpisodeFile[] = [];
  const texts = new Map<string, string>();
  const unreadable: string[] = [];

  for (const relative of listBodyFiles(folder)) {
    const filePath = resolveInsideFolder(folder, relative);
    const fileName = nodePath.basename(filePath);
    const ext = nodePath.extname(fileName).toLowerCase();

    let text: string;
    let hasConflictMarkers: boolean;
    try {
      const decoded = decodeBytes(fs.readFileSync(filePath));
      text = decoded.text;
      hasConflictMarkers = decoded.hasConflictMarkers;
    } catch {
      // **読めないファイルで止めない**（製品の走査と同じ）。黙って落とさず数える
      unreadable.push(relative);
      continue;
    }

    // 作品情報（カクヨムの `about.txt`）は話ではない（`workInfoFile.ts`）
    if (isWorkInfoFile(fileName, text)) continue;

    const parsed = parseEpisodeFileName(fileName);
    const meta = parseEpisodeMetadata(text);
    const collected = parseCollectedFile(text);
    const collectedChapters = (collected ?? [])
      .map((episode) => episode.chapter)
      .filter((chapter): chapter is number => chapter !== null);

    episodes.push({
      filePath,
      fileName,
      ext,
      chapterStart:
        collectedChapters.length > 0 ? Math.min(...collectedChapters) : parsed.chapterStart,
      chapterEnd:
        collectedChapters.length > 0 ? Math.max(...collectedChapters) : parsed.chapterEnd,
      subtitle: parsed.subtitle ?? meta.title,
      kind: parsed.kind,
      isInitialName: parsed.isInitialName,
      date: parsed.date,
      dateSeq: parsed.dateSeq,
      // **競合の跡が残るものは数えない**（製品と同じ。両方の版が混ざった字数を進捗に見せない）
      counts: hasConflictMarkers
        ? emptyCounts()
        : countEpisodeChars(text, { ext, excludeRuby: true }, { collected, metaBody: meta.body }),
      hasMetadata: meta.hasMetadata,
      metaTitle: meta.title,
      declaredCharCount: meta.declaredCharCount,
      metaUpdatedAt: meta.updatedAt,
      hasConflictMarkers,
      collectedCount: collected ? collected.length : null,
      memoBadge: "",
      eol: null,
      hasMixedEol: false,
    });
    if (!hasConflictMarkers) texts.set(filePath, text);
  }

  episodes.sort(compareEpisodes);
  return { episodes, texts, unreadable };
}
