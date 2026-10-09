import type { WorkEntry } from "../models/types";
import { createLocationStore } from "../core/abilityStore";
import { scanWork } from "../core/scanner";
import { readTextFile } from "../core/textFile";
import { logFailure, logStep, useLogFile } from "../core/logger";
import { isSameLocation } from "../core/locationCompare";
import {
  findLocationInconsistencies,
  placeLocationInconsistencies,
  type EpisodeText,
  type LocationContradictionIssue,
} from "../core/locationConsistency";

/**
 * 場所の位置関係の機械照合（設計書6.93.4）を、作品について走らせる。
 *
 * **判定は `core/locationConsistency.ts` だけが持つ。** ここは台帳と本文を
 * 読んで渡すだけ——MCP の `novel.detect`（feature: contradiction）も同じ判定を
 * 通る。AIは使わず、台帳も本文も書き換えない（読むだけ）。
 */
export interface LocationContradictionRun {
  issues: LocationContradictionIssue[];
  /** 本文のどこにも置けなかった食い違いの数（中身は操作ログ） */
  unplacedCount: number;
  /** 読めなかった場所のファイルの数（照合の外に置いたことを黙らない） */
  unreadableLocations: number;
}

export async function collectLocationContradictions(
  work: WorkEntry,
  /** 範囲で絞ったときの話のファイル。無ければ作品全体 */
  scopeFilePaths?: readonly string[]
): Promise<LocationContradictionRun> {
  // 記録はこの作品のログファイルへ（矛盾検知の本体と同じ所）
  useLogFile(work.folderPath);
  const empty: LocationContradictionRun = {
    issues: [],
    unplacedCount: 0,
    unreadableLocations: 0,
  };
  let loaded: Awaited<ReturnType<ReturnType<typeof createLocationStore>["loadAll"]>>;
  try {
    loaded = await createLocationStore(work).loadAll();
  } catch (error) {
    // 照合は付け足しの段なので、読めなくても矛盾検知そのものは止めない
    logFailure("矛盾検知：場所の位置関係の照合（場所の読み込み）", {
      詳細: error instanceof Error ? error.message : String(error),
    });
    return empty;
  }
  const found = findLocationInconsistencies(loaded.records);
  if (found.length === 0) {
    return { ...empty, unreadableLocations: loaded.errors.length };
  }

  // 置き場所を探すのは、食い違いが見つかったときだけ（全話を読むので）
  const episodes: EpisodeText[] = [];
  for (const episode of (await scanWork(work)).episodes) {
    try {
      const file = await readTextFile(episode.filePath);
      // 競合マーカーのある話は、どちらが本文か決められないので探さない
      if (file.hasConflictMarkers) continue;
      episodes.push({
        filePath: episode.filePath,
        text: file.text,
        chapterStart: episode.chapterStart,
        chapterEnd: episode.chapterEnd,
      });
    } catch (error) {
      logFailure("矛盾検知：場所の位置関係の照合（本文の読み込み）", {
        ファイル: episode.fileName,
        詳細: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // 範囲の話は、走査で得た綴りに揃えてから渡す。開いているエディターから
  // 来た道は、ドライブ文字の大小などが走査と違うことがある
  const scopeFiles = scopeFilePaths
    ? new Set(
        episodes
          .map((episode) => episode.filePath)
          .filter((filePath) =>
            scopeFilePaths.some((scoped) => isSameLocation(scoped, filePath))
          )
      )
    : undefined;
  const placed = placeLocationInconsistencies(found, episodes, { scopeFiles });
  logStep(
    `矛盾検知：場所の位置関係を機械で照合（食い違い ${found.length}件 / ` +
      `本文の行に置けた ${placed.issues.length}件 / 置けなかった ${placed.unplaced.length}件）`
  );
  for (const inconsistency of placed.unplaced) {
    // **黙って捨てない。** 根拠も話数も無い関係（作者が書いたもの）どうしの
    // 食い違いは、飛ぶ先の本文が無い。中身をログに残し、件数を完了の通知へ出す
    logStep(
      `矛盾検知：本文に置けなかった位置関係の食い違い：${inconsistency.summary}` +
        `（${inconsistency.statements.map((statement) => statement.text).join("／")}）`
    );
  }
  return {
    issues: placed.issues,
    unplacedCount: placed.unplaced.length,
    unreadableLocations: loaded.errors.length,
  };
}
