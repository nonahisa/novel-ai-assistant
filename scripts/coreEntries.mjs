// 外から呼ぶ束（MCP サーバー）の起点。**ここが唯一の定義**（設計書6.87.3）。
//
// `scripts/bundleCore.mjs`（束ねられるかを機械で確かめる）と
// `test/unit/mcpReach.test.ts`（`vscode` へ届かないかを見る）の両方が
// ここを読む。**写すと、片方だけ増えて検査が素通りする。**
import fs from "node:fs";
import path from "node:path";

/**
 * `core` 側の起点——**検算と、材料の組み立て**。
 *
 * ここに挙げたものが、外から呼びたい「判断」の入口である。
 * 増やすときは、`vscode` を持ち込まない形で書けるものだけにする。
 */
export const CORE_ENTRY_NAMES = [
  "proofreadValidation",
  "contradictionValidation",
  "contradictionMaterial",
  "foreshadowValidation",
  "deviationValidation",
  "characterExtractionValidation",
  "settingsExtractionValidation",
  "storyFactValidation",
  "chunker",
  "episodeChunks",
  "guideSelect",
  "settingsSummary",
  "collectedFile",
  "episodeLabel",
];

/** `src/prompts/*.ts` は全部。プロンプトの組み立ては丸ごと外へ出す */
export function promptEntryFiles(src) {
  const dir = path.join(src, "prompts");
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".ts"))
    .sort()
    .map((name) => path.join(dir, name));
}

export function coreEntryFiles(src) {
  return CORE_ENTRY_NAMES.map((name) => path.join(src, "core", `${name}.ts`));
}

/** 束ねる／たどる起点の全部（プロンプト＋検算・材料） */
export function allEntryFiles(src) {
  return [...promptEntryFiles(src), ...coreEntryFiles(src)];
}
