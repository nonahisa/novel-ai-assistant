import fs from "node:fs";
import nodePath from "node:path";
import { AIWRITER_DIR } from "../../models/types";
import {
  DENIED,
  EXTERNAL_PERMISSION_FILE,
  externalAccessDeniedMessage,
  isSamplingAllowed,
  isToolAllowed,
  parseExternalAccessPermission,
  permissionKeyOf,
  samplingNotPermittedMessage,
  type ExternalAccessPermission,
} from "../../core/externalAccessPermission";
import { FEATURE_LABELS, type FeatureName } from "../../core/mcpFeatures";
import { getExternalClientName } from "./accessLog";
import { McpToolError } from "./shared";

/**
 * 外部AIにこの作品を触らせてよいかを、道具が動く前に確かめる
 * （設計書6.87.10、6.87.14）。
 *
 * **既定は拒否。** 印（`.aiwriter/external-access.json`）が無ければ断る。
 *
 * **許可は接続元ごと・道具ごと**（作者の指示、2026-09-16）。`typo.run` を
 * 許したことは `settings.run` を許したことにならないし、Claude Code へ
 * 許したことは別のクライアントへ許したことにならない。
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
  constructor(options: { client: string; tool: string; legacy: boolean }) {
    super(externalAccessDeniedMessage(options));
  }
}

/**
 * 作品を触る道具かどうかを見て、触るなら許可を確かめる。
 *
 * @param tool 道具の名前。**鍵はここと `feature` から決まる**
 *   （`permissionKeyOf`。0.66.7 で道具を束ねたため）
 */
export function assertExternalAccessAllowed(args: unknown, tool: string): void {
  const folder = folderOf(args);
  // 作品を指していない道具（`mcp.version`・`ollama.generate`）は素通り。
  // **原稿を読まないので、許可の対象が無い**
  if (!folder) return;

  const key = accessKeyOf(args, tool);
  const permission = readExternalAccessPermission(folder);
  const client = getExternalClientName();
  if (!isToolAllowed(permission, client, key)) {
    throw new ExternalAccessDeniedError({
      client,
      tool: describeKey(key),
      legacy: permission.legacy,
    });
  }
}

/**
 * その呼び出しの許可の鍵（0.66.7）。
 *
 * **記録する側（`accessLog.ts`）も同じものを使う。** 別々に決めると、
 * **断られた鍵と作者が許可する鍵がずれて、いくら許可しても通らない。**
 */
export function accessKeyOf(args: unknown, tool: string): string {
  return permissionKeyOf(tool, fieldOf(args, "feature"));
}

/** 断り文句と画面に出す呼び名。`feature` は日本語を添える */
export function describeKey(key: string): string {
  const label = FEATURE_LABELS[key as FeatureName];
  return label ? `${label}（feature: ${key}）` : key;
}

export function folderOf(args: unknown): string | undefined {
  const folder = fieldOf(args, "folder");
  return typeof folder === "string" && folder.trim() ? folder : undefined;
}

function fieldOf(args: unknown, name: string): unknown {
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    return undefined;
  }
  return (args as Record<string, unknown>)[name];
}

/**
 * 考えさせること（sampling）が許されているか（設計書6.87.12）。
 *
 * **道具の許可とは別に確かめる**（作者の指示、2026-09-16
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
  const client = getExternalClientName();
  if (!isSamplingAllowed(readExternalAccessPermission(folder), client)) {
    throw new McpToolError(samplingNotPermittedMessage(client));
  }
}
