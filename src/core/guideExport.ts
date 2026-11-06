/**
 * 使い方の答えの材料を、外（Discord のボット）へ渡す口（2026-11-06。作者の依頼「質問回答の原稿は、
 * 可能な限りディスコードと連携」）。
 *
 * ボットは製品のコードを esbuild で束ねて、使い方の答えの原稿（メニューの場所の図・手順書き）を
 * 製品と同じ関数で作る。**名前と形をここ1か所に集める**——ボットが個々のファイルの名前を
 * 直に拾うと、こちらで名前を変えた日にボットだけが黙って壊れる。形は
 * `test/unit/core/guideExport.test.ts` が見張る。
 *
 * **`vscode` に依らない**（`scripts/coreEntries.mjs` の起点に入れ、`bundleCore.mjs` と
 * `mcpReach.test.ts` が見張る）。
 */
import { ENTRANCE_SHOTS } from "./entranceShots";
import { procedureActionLookup } from "./featureGuide";
import {
  MENU_PATH_START,
  guideMenuEntries,
  menuPathLine,
  menuPathsOf,
  renderMenuPathText,
} from "./menuPath";
import { PROCEDURES, proceduresForMode, renderProcedure } from "./procedures";

/**
 * ボットへ渡す名前の一覧（並びもここが正）。足すときは末尾へ——前からの9つの並びはボットとの約束
 */
export const GUIDE_EXPORT_NAMES = [
  "menuPathsOf",
  "renderMenuPathText",
  "menuPathLine",
  "MENU_PATH_START",
  "guideMenuEntries",
  "PROCEDURES",
  "proceduresForMode",
  "renderProcedure",
  "procedureActionLookup",
  "ENTRANCE_SHOTS",
] as const;

export function guideExport() {
  return {
    menuPathsOf,
    renderMenuPathText,
    menuPathLine,
    MENU_PATH_START,
    guideMenuEntries,
    PROCEDURES,
    proceduresForMode,
    renderProcedure,
    procedureActionLookup,
    ENTRANCE_SHOTS,
  } satisfies Record<(typeof GUIDE_EXPORT_NAMES)[number], unknown>;
}

export type GuideExport = ReturnType<typeof guideExport>;
