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
 * 守りが印を読む作品フォルダー。
 *
 * **`setup.request` は作品を `path` で受ける**（`folder` は許可の鍵なので、まだ登録して
 * いない場所で必ず断られるのを避けて名前を変えてある。`setupRequest.ts`）。許可とは
 * 違い、ここは `path` も作品として読む——読まないと、編集用の写しへ外部AIの許可や
 * 登録を頼めてしまう。ほかの道具の `path` は作品を指さないので見ない。
 */
function workFolderOf(args: unknown, tool: string): string | undefined {
  const folder = folderOf(args);
  if (folder || tool !== "setup.request") return folder;
  const target =
    typeof args === "object" && args !== null && !Array.isArray(args)
      ? (args as Record<string, unknown>).path
      : undefined;
  return typeof target === "string" && target.trim() ? target : undefined;
}

/**
 * 編集用の写し（か、確かめられない作品）で、表が許さない呼び出しなら断る。
 *
 * **作者の作品では印を読むだけで何もしない**——今までの動きを変えない。
 * 作品を指さない呼び出し（`folder` も、`setup.request` の `path` も無い）は、
 * どの作品か分からないので印を読まずに通す。
 */
export function assertEditorModeAllows(args: unknown, tool: string): void {
  const folder = workFolderOf(args, tool);
  if (!folder) return;
  const mode = readWorkFolderMode(folder);
  if (mode === "author") return;
  if (isMcpToolAllowedForEditor(tool, args)) return;
  throw new EditorModeBlockedError(tool, mode);
}
