import * as fs from "node:fs";
import * as nodePath from "node:path";
import {
  hasEpisodePlotFile,
  hasSettingsRecords,
  hasSynopsisEpisodes,
  hasWrittenPlot,
} from "../../core/prerequisiteCheck";
import { EPISODE_PLOTS_DIR } from "../../core/resumeSheet";
import type { Prerequisite } from "../../core/prerequisites";
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

function hasEpisodePlots(folder: string): boolean {
  const settings = settingsDirOf(folder);
  if (!settings) return false;
  const directory = nodePath.join(settings, EPISODE_PLOTS_DIR);
  // 置き場そのものが無い＝1つも作っていない（画面の関門と同じ扱い）
  if (!fs.existsSync(directory)) return false;
  return hasEpisodePlotFile(
    fs
      .readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
  );
}
