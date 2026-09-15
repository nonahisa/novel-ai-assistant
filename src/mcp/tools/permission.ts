import fs from "node:fs";
import nodePath from "node:path";
import { AIWRITER_DIR } from "../../models/types";
import {
  DENIED,
  EXTERNAL_ACCESS_DENIED_MESSAGE,
  EXTERNAL_PERMISSION_FILE,
  SAMPLING_NOT_PERMITTED,
  parseExternalAccessPermission,
  type ExternalAccessPermission,
} from "../../core/externalAccessPermission";
import { McpToolError } from "./shared";

/**
 * 外部AIにこの作品を読ませてよいかを、道具が動く前に確かめる（設計書6.87.10）。
 *
 * **既定は拒否。** 印（`.aiwriter/external-access.json`）が無ければ断る。
 *
 * **転送層の1か所で確かめる。** 道具ごとに書くと、新しい道具を足した人が
 * 忘れる——そして**忘れた道具は、許可なしで原稿を読む**。
 * `test/unit/mcpAccessLog.test.ts` が、素通りする道具が無いことを見張る。
 */

export function readExternalAccessPermission(
  folder: string
): ExternalAccessPermission {
  const target = nodePath.join(
    nodePath.resolve(folder),
    AIWRITER_DIR,
    EXTERNAL_PERMISSION_FILE
  );
  try {
    return parseExternalAccessPermission(fs.readFileSync(target, "utf8"));
  } catch {
    // 印が無い＝まだ意思確認していない＝拒否
    return DENIED;
  }
}

/**
 * 断るときに投げる。
 *
 * **断り方が大事。** ただ失敗を返すと、呼んだ側は不具合と区別が付かず、
 * 作者にも何も伝わらない。**どうすれば許可できるか**を返事に書く。
 */
export class ExternalAccessDeniedError extends McpToolError {
  constructor() {
    super(EXTERNAL_ACCESS_DENIED_MESSAGE);
  }
}

/**
 * 作品を触る道具かどうかを見て、触るなら許可を確かめる。
 *
 * @returns 断ったなら true（呼び出し側が記録を残す）
 */
export function assertExternalAccessAllowed(args: unknown): void {
  const folder = folderOf(args);
  // 作品を指していない道具（`mcp.version`・`ollama.generate`）は素通り。
  // **原稿を読まないので、許可の対象が無い**
  if (!folder) return;
  if (!readExternalAccessPermission(folder).allowed) {
    throw new ExternalAccessDeniedError();
  }
}

export function folderOf(args: unknown): string | undefined {
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    return undefined;
  }
  const folder = (args as Record<string, unknown>).folder;
  return typeof folder === "string" && folder.trim() ? folder : undefined;
}

/**
 * 考えさせること（sampling）が許されているか（設計書6.87.12）。
 *
 * **読ませる許可とは別に確かめる**（作者の指示、2026-09-16
 * 「ここでも、初期は閉鎖で解放するときは外部に情報を出す旨警告を表示」）。
 *
 * **作品が分からない呼び出しは断る。** どの作品への許可かを確かめようが
 * ないので、**迷ったら断る**側に倒す。
 */
export function assertSamplingAllowed(folder: string | undefined): void {
  if (!folder) {
    throw new McpToolError(
      "どの作品への操作か分からないため、考えさせること（sampling）は断りました。folder を渡してください。"
    );
  }
  if (!readExternalAccessPermission(folder).sampling) {
    throw new McpToolError(SAMPLING_NOT_PERMITTED);
  }
}
