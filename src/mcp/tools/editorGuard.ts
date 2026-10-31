import fs from "node:fs";
import nodePath from "node:path";
import { AIWRITER_DIR } from "../../models/types";
import { EDITING_SITE_FILE, EDITOR_SHARE_MANIFEST_FILE } from "../../core/editingRepo";
import {
  describeMcpBlocked,
  workModeFromMarks,
  type FolderMarkState,
  type WorkFolderMode,
} from "../../core/editorMode";
import { isMcpToolAllowedForEditor } from "../../core/mcpEditorPolicy";
import { folderOf } from "./permission";
import { McpToolError } from "./shared";

/**
 * 編集用の写しでは、書く道具を道具が動く前に断る（設計書6.87.25・5.6.5。
 * 作者の指示 2026-10-31「MCPサーバの穴ふさぎは実行してください」）。
 *
 * 画面は設定 `novelai.mode` で編集者モードを知るが、MCP サーバーは VS Code の外で
 * 動くのでそれを確実には読めない。**作品フォルダーの印**で決める（`workModeFromMarks`）。
 *
 * **転送層の1か所で確かめる**（`server.ts` の `tool()`。許可の確かめ `permission.ts` の直後）。
 * 道具ごとに書くと、新しい道具を足した人が忘れる——忘れた道具は、編集部の側から
 * 作者の資料を書き換える。
 */

/** 印1つの様子を読む。ファイルでない物が置かれている・読めないときは `unreadable` */
function markState(target: string): FolderMarkState {
  try {
    return fs.statSync(target).isFile() ? "present" : "unreadable";
  } catch (error) {
    // **無いのは普通。** 作者の作品はほとんどがここ
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR" ? "absent" : "unreadable";
  }
}

/** 作品フォルダーの印から、編集用の写しかを読む */
export function readWorkFolderMode(folder: string): WorkFolderMode {
  const root = nodePath.join(nodePath.resolve(folder), AIWRITER_DIR);
  return workModeFromMarks({
    editorCopy: markState(nodePath.join(root, EDITOR_SHARE_MANIFEST_FILE)),
    authorSite: markState(nodePath.join(root, EDITING_SITE_FILE)),
  });
}

export class EditorModeBlockedError extends McpToolError {
  constructor(tool: string, mode: WorkFolderMode) {
    super(describeMcpBlocked(tool, mode));
  }
}

/**
 * 編集用の写し（か、確かめられない作品）で、表が許さない呼び出しなら断る。
 *
 * **作者の作品では印を読むだけで何もしない**——今までの動きを変えない。
 * `folder` を取らない道具は、どの作品か分からないので印を読まずに通す
 * （そうした道具は表でも作品のファイルを書かないものだけにしてある）。
 */
export function assertEditorModeAllows(args: unknown, tool: string): void {
  const folder = folderOf(args);
  if (!folder) return;
  const mode = readWorkFolderMode(folder);
  if (mode === "author") return;
  if (isMcpToolAllowedForEditor(tool, args)) return;
  throw new EditorModeBlockedError(tool, mode);
}
