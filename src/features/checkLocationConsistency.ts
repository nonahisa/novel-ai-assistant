import type { WorkEntry } from "../models/types";
import { locationFileName } from "../models/location";
import * as path from "../core/paths";
import { readWorkConfig, workPaths } from "../core/workRegistry";
import { createLocationStore } from "../core/abilityStore";
import { scanWork } from "../core/scanner";
import { readTextFile } from "../core/textFile";
import { logFailure, logStep, useLogFile } from "../core/logger";
import { isSameLocation } from "../core/locationCompare";
import {
  buildLocationResolver,
  regionStatement,
  findLocationInconsistencies,
  placeLocationInconsistencies,
  recordIssueOf,
  type EpisodeText,
  type LocationContradictionIssue,
  type LocationRecordIssue,
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
  /**
   * 本文のどこにも置けなかった食い違い（設計書6.93.9 の順6）。提案パネルに
   * 「場所の資料を開く」行として並べる（中身は操作ログにも残す）
   */
  recordIssues: LocationRecordIssue[];
  /**
   * `issues`・`recordIssues` の各行が、照合（`findLocationInconsistencies`）の
   * 何番目の食い違いか。場所の略図の赤い線から、提案パネルの同じ行を引く
   */
  issueSources: number[];
  recordSources: number[];
  /** 本文のどこにも置けなかった食い違いの数 */
  unplacedCount: number;
  /** 読めなかった場所のファイルの数（照合の外に置いたことを黙らない） */
  unreadableLocations: number;
  /**
   * 位置関係（関係の欄か、台帳の場所を指す地域の欄）を持つ場所の数。
   * 0 なら照らす材料が無い——「食い違い0件」と言うと、照らして無かったと読まれる
   */
  locationsWithRelations: number;
  /** 場所の置き場そのものを読めなかったときの理由（照合は走っていない） */
  loadError?: string;
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
    recordIssues: [],
    issueSources: [],
    recordSources: [],
    unplacedCount: 0,
    unreadableLocations: 0,
    locationsWithRelations: 0,
  };
  let loaded: Awaited<ReturnType<ReturnType<typeof createLocationStore>["loadAll"]>>;
  try {
    loaded = await createLocationStore(work).loadAll();
  } catch (error) {
    // 照合は付け足しの段なので、読めなくても矛盾検知そのものは止めない
    const detail = error instanceof Error ? error.message : String(error);
    logFailure("矛盾検知：場所の位置関係の照合（場所の読み込み）", { 詳細: detail });
    return { ...empty, loadError: detail };
  }
  const resolver = buildLocationResolver(loaded.records);
  const locationsWithRelations = loaded.records.filter(
    (location) =>
      (location.relations?.length ?? 0) > 0 || regionStatement(location, resolver) !== null
  ).length;
  const found = findLocationInconsistencies(loaded.records);
  if (found.length === 0) {
    return { ...empty, unreadableLocations: loaded.errors.length, locationsWithRelations };
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
  // 開く資料のファイルは、保存と同じ決まり（`locationFileName`）で置き場から組む
  const directory = path.join(
    workPaths(work, await readWorkConfig(work)).settings,
    "locations"
  );
  const byId = new Map(loaded.records.map((location) => [location.id, location]));
  const recordIssues = placed.unplaced.map((inconsistency) =>
    recordIssueOf(inconsistency, (locationId) => {
      const location = byId.get(locationId);
      return path.join(directory, location ? locationFileName(location) : `${locationId}.json`);
    })
  );
  return {
    issues: placed.issues,
    recordIssues,
    issueSources: placed.issueSources,
    recordSources: placed.unplaced.map((inconsistency) => found.indexOf(inconsistency)),
    unplacedCount: placed.unplaced.length,
    unreadableLocations: loaded.errors.length,
    locationsWithRelations,
  };
}

/**
 * 完了の通知に並べる、位置関係の照合の内訳。
 *
 * **矛盾検知の終わりと単独の照合で同じ言い方にする**（2か所に書くと片方だけ
 * 直る）。`lead` は矛盾検知の側だけ「うち」——AI の指摘と同じ一覧の中の数だから。
 */
export function describeLocationRun(
  run: LocationContradictionRun,
  lead: "うち" | ""
): string[] {
  const parts: string[] = [];
  if (run.issues.length > 0) {
    parts.push(`${lead}場所の位置関係（機械で照合） ${run.issues.length}件`);
  }
  // 本文に置けなかった食い違い（作者が書いた関係どうし）は黙らない
  if (run.recordIssues.length > 0) {
    parts.push(`本文の根拠が無い位置関係の食い違い ${run.recordIssues.length}件（場所の資料を開く行）`);
  }
  if (run.unreadableLocations > 0) {
    parts.push(
      `読めなかった場所のファイル ${run.unreadableLocations}件（位置関係の照合の外）`
    );
  }
  return parts;
}
