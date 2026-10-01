import * as fs from "node:fs";
import * as nodePath from "node:path";
import {
  hasEpisodePlotFile,
  hasSettingsRecords,
  hasSynopsisEpisodes,
  hasWrittenPlot,
} from "../../core/prerequisiteCheck";
import {
  EPISODE_PLOTS_DIR,
  episodePlotChapterFromFileName,
} from "../../core/resumeSheet";
import {
  episodePlotShortfall,
  judgeEpisodePlotText,
} from "../../core/episodePlotDoc";
import type { PrerequisiteReasons } from "../../core/featurePrerequisites";
import type { Prerequisite } from "../../core/prerequisites";
import { DEFAULT_SETTINGS_DIR } from "../../models/types";
import { parseCharacter } from "../../models/character";
import { parseLocation } from "../../models/location";
import { parseWorldItem } from "../../models/world";
import { parseSynopsisSet } from "../../models/synopsis";
import {
  SETTINGS_SUBDIRS,
  SYNOPSES_FILE,
  readPlotMarkdown,
  readSettingsFile,
  readSettingsRecords,
  settingsDirOf,
} from "./shared";

/**
 * いま何が揃っているかを、作品フォルダーから見る（設計書6.94、0.67.3）。
 *
 * **画面の関門（`features/prerequisiteGate.ts`）と対になる。** あちらは
 * `vscode.workspace.fs` で読み、こちらは Node の `fs` で読む。**数え方
 * （規則）は `core/prerequisiteCheck.ts` に1つだけ置いて共用する**ので、
 * 「画面では止まるのにMCPでは通る」は起きない。
 *
 * **読むだけ**（6.87.7）。
 */

/**
 * 要るものだけ見る。
 *
 * **全部読まない。** 前提の無い feature まで、呼ぶたびに設定資料と
 * あらすじとプロットを読むことになる。
 */
export function presentPrerequisites(
  folder: string,
  kinds: Iterable<Prerequisite>
): ReadonlySet<Prerequisite> {
  const present = new Set<Prerequisite>();
  for (const kind of new Set(kinds)) {
    if (hasPrerequisite(folder, kind)) present.add(kind);
  }
  return present;
}

/**
 * 1つ見る。
 *
 * **読めなかったものは「揃っている」扱いにする**（6.94.6 の決まり）。
 * 読めないことを理由に断ると、壊れたJSONが1つある作品では**何も呼べなく
 * なる**。壊れていることは、機能の側が材料を読むときに正しく報告する。
 */
function hasPrerequisite(folder: string, kind: Prerequisite): boolean {
  try {
    if (kind === "settings") return hasSettings(folder);
    if (kind === "synopsis") return hasSynopsis(folder);
    if (kind === "plot") return hasWrittenPlot(readPlotMarkdown(folder));
    return hasEpisodePlots(folder);
  } catch {
    return true;
  }
}

function hasSettings(folder: string): boolean {
  return hasSettingsRecords({
    characters: readSettingsRecords(
      folder,
      SETTINGS_SUBDIRS.characters,
      parseCharacter
    ).records,
    locationCount: readSettingsRecords(
      folder,
      SETTINGS_SUBDIRS.locations,
      parseLocation
    ).records.length,
    worldCount: readSettingsRecords(
      folder,
      SETTINGS_SUBDIRS.world,
      parseWorldItem
    ).records.length,
  });
}

function hasSynopsis(folder: string): boolean {
  const raw = readSettingsFile(folder, SYNOPSES_FILE);
  if (raw === undefined) return false;
  // 壊れていれば「無い」ではなく**読めなかった**——上の catch で拾わせる
  return hasSynopsisEpisodes(parseSynopsisSet(raw).episodes.length);
}

/**
 * 単話プロットが揃っているか。
 *
 * **ファイルがあるだけでは揃っていない**（2026-10-01）。以前はファイルの
 * 有無だけを見ていたので、ひな形のままの単話プロットを「揃っている」と
 * 返し、続く `novel.prompt` が「展開がまだ書かれていません」と断る
 * 食い違いが起きた。**判定は prompt と同じ関数**（`episodePlotUnwrittenReason`）。
 *
 * **1つでも書かれていれば揃っている**（6.94.6 の粗さは変えない——どの話を
 * 見るかは前提を見たあとに決まる）。どの話が書かれているかは
 * `novel.scan` の `episodePlots` が1件ずつ返す。
 *
 * 画面の関門（`features/prerequisiteGate.ts`）も同じ判定を通す
 * （`core/episodePlotDoc.ts` の `judgeEpisodePlotText`・`episodePlotShortfall`）。
 */
function hasEpisodePlots(folder: string): boolean {
  return episodePlotShortfall(episodePlotEntries(folder)) === undefined;
}

/** 単話プロット1件の姿（`novel.scan` の `episodePlots`） */
export interface EpisodePlotEntry {
  /**
   * 作品フォルダーからの相対パス（区切りは `/`）。
   * **`novel.prompt` などの `options.plotPath` にそのまま渡せる**
   */
  plotPath: string;
  /** 話数。ファイル名（`第N話.md`）から読めなければ null（推測で埋めない） */
  chapter: number | null;
  /**
   * 展開が書かれているか（`novel.prompt` が通るか）。
   * 読めなかったものは null——書かれているかどうか分からない
   */
  written: boolean | null;
  /** 通らない理由（書かれていない・読めなかった） */
  reason?: string;
}

/**
 * 単話プロットの置き場にあるものを、話数の順に1件ずつ見る。
 *
 * **中身まで読む。** 置き場は作者が話ごとに作るもので、数も大きさも
 * 小さい（1話に1つ、数百字）。
 */
export function episodePlotEntries(folder: string): EpisodePlotEntry[] {
  const settings = settingsDirOf(folder);
  if (!settings) return [];
  const directory = nodePath.join(settings, EPISODE_PLOTS_DIR);
  // 置き場そのものが無い＝1つも作っていない（画面の関門と同じ扱い）
  if (!fs.existsSync(directory)) return [];
  const names = fs
    .readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    // 何を単話プロットと数えるかは画面の関門と同じ規則（`prerequisiteCheck.ts`）
    .filter((name) => hasEpisodePlotFile([name]));

  const entries = names.map((name): EpisodePlotEntry => {
    const plotPath = [DEFAULT_SETTINGS_DIR, EPISODE_PLOTS_DIR, name].join("/");
    const chapter = episodePlotChapterFromFileName(name);
    let text: string;
    try {
      // **prompt と同じ読み方をする**（`episode.ts` の `readEpisodePlotDoc`）。
      // 読み方が違うと、同じファイルで判定が割れる
      text = fs.readFileSync(nodePath.join(directory, name), "utf8");
    } catch (error) {
      return {
        plotPath,
        chapter,
        written: null,
        reason: `読めませんでした（${
          error instanceof Error ? error.message : String(error)
        }）。`,
      };
    }
    return { plotPath, chapter, ...judgeEpisodePlotText(text) };
  });

  // 話数の読めるものを先に小さい順、読めないものは名前順で後ろへ
  return entries.sort((a, b) => {
    if (a.chapter !== null && b.chapter !== null) return a.chapter - b.chapter;
    if (a.chapter !== null) return -1;
    if (b.chapter !== null) return 1;
    return a.plotPath.localeCompare(b.plotPath);
  });
}

// 判定は core に1つ（画面の関門と共通）。ここからも引き続き呼べるようにしておく
export { episodePlotShortfall };

/**
 * 揃っていない前提の理由（`novel.scan` と、機能の断り文句に添える）。
 *
 * **いまは単話プロットだけ。** ほかの3つは「ファイルが無い／中身が無い」の
 * どちらでも作る操作が同じなので、名前と作る操作で足りている。
 */
export function prerequisiteReasons(
  folder: string,
  kinds: Iterable<Prerequisite>
): PrerequisiteReasons {
  const reasons: Partial<Record<Prerequisite, string>> = {};
  for (const kind of new Set(kinds)) {
    if (kind !== "episodePlot") continue;
    try {
      const reason = episodePlotShortfall(episodePlotEntries(folder));
      if (reason) reasons.episodePlot = reason;
    } catch {
      // 理由が言えないだけで、判定そのものは `hasPrerequisite` が持つ
    }
  }
  return reasons;
}
