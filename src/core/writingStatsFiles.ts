import type { DeviceWritingStats } from "../models/writingStats";
import { parseDeviceWritingStats } from "./writingStats";

/**
 * 執筆量の記録ファイルの読み方（設計書5.5.6・6.3）。**VS Code にも Node にも依存しない。**
 *
 * 記録は `.aiwriter/stats/<環境名>.json` に環境ごとに1つずつある。読み方を
 * `WritingStatsStore`（vscode のファイル操作）から切り出したのは、MCP の読む口
 * （`novel.read` の `kind: writingStats`。設計書6.87.24）が Node の `fs` で
 * **同じ読み方**をするため——写すと、壊れた記録の扱いや並び順が片方だけ変わる日が来る。
 *
 * ファイルを開くのは呼ぶ側。ここは「名前と中身の組」を受け取って、記録の並びにするだけ。
 */

/** 記録の置き場（`.aiwriter/` の下）。作品フォルダー内・同期対象 */
export const WRITING_STATS_DIR = "stats";

/** 記録のファイルとして読む名前か（`.json` だけ。ほかは黙って飛ばす） */
export function isWritingStatsFileName(name: string): boolean {
  return name.endsWith(".json");
}

/**
 * 記録のファイル1つを読む。**壊れていれば undefined**（例外を投げない）。
 *
 * 同期対象なので競合マーカーが混ざることがあり、ここで投げると統計が二度と開けなくなる。
 */
export function parseWritingStatsFile(text: string): DeviceWritingStats | undefined {
  try {
    return parseDeviceWritingStats(JSON.parse(text));
  } catch {
    return undefined;
  }
}

/**
 * 全環境の記録を読む。**壊れた記録は黙って捨て、環境の名前の順に並べる**
 * （`WritingStatsStore.loadAll` と同じ）。
 */
export function collectWritingStats(
  files: Iterable<{ name: string; text: string }>
): DeviceWritingStats[] {
  const sets: DeviceWritingStats[] = [];
  for (const file of files) {
    if (!isWritingStatsFileName(file.name)) continue;
    const loaded = parseWritingStatsFile(file.text);
    if (loaded) sets.push(loaded);
  }
  return sets.sort((left, right) => left.deviceId.localeCompare(right.deviceId));
}
