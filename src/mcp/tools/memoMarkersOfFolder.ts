import * as fs from "node:fs";
import * as nodePath from "node:path";
import { AIWRITER_DIR, CONFIG_FILE } from "../../models/types";
import { resolveMemoMarkers, type MemoMarkers } from "../../core/memoMarkers";

/**
 * 作品フォルダーのメモの印（設計書6.40.8）。**MCP の側の読み口はここ1か所。**
 *
 * 拡張機能の側（`core/memoMarkerStore.ts`）は `vscode` 越しに読むので、MCP からは呼べない。
 * 読み方の決まりは同じ関数（`resolveMemoMarkers`）を通す——設定ファイルが無ければ既定
 * （`//` と `／／`）、壊れていれば投げる（直さずに止める。黙って既定にすると、作者が選んだ
 * 印の行が外部の AI へ本文として渡る）。
 */
export function memoMarkersOfFolder(folder: string): MemoMarkers {
  const file = nodePath.join(nodePath.resolve(folder), AIWRITER_DIR, CONFIG_FILE);
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return resolveMemoMarkers(undefined);
    throw error;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text.replace(/^﻿/, ""));
  } catch (error) {
    throw new Error(
      `作品の設定（${AIWRITER_DIR}/${CONFIG_FILE}）が JSON として読めません（直さずに止めました）：${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
  const value = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>).memoMarkers : undefined;
  return resolveMemoMarkers(value);
}
