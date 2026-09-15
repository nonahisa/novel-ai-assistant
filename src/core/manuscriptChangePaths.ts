import { AIWRITER_DIR, DEFAULT_SETTINGS_DIR } from "../models/types";

/**
 * 同期で入れ替わったファイルのうち、**本文だけ**を選ぶ（設計書5.5.8）。
 *
 * **作者の実機報告（2026-09-15）**：何も触っていないのに
 * 「13作品で本文が更新されました（合計169件）。設定資料の抽出をやり直すと、
 * 増えた内容を取り込めます」と出る。
 *
 * 数えていたのは `git diff --name-only` の**全ファイル**で、
 * **執筆量の記録（`.aiwriter/stats/<端末>.json`）まで「本文」と呼んでいた。**
 * あの案内は「抽出をやり直すと増えた内容を取り込める」と続くので、
 * **本文が増えたときにだけ意味がある**——管理ファイルが変わっただけで
 * 勧めるのは、作者にAIの費用と時間を使わせることになる。
 *
 * VS Code APIに依存しない（単体テストの対象）。
 */

/** 本文として扱う拡張子。**それ以外は数えない** */
const BODY_EXTENSIONS = [".txt", ".md"];

/**
 * 作品フォルダーからの相対パスが、本文か。
 *
 * **除くもの**
 *
 * - `.aiwriter/` の中（執筆量の記録・履歴・キャッシュ・承認待ち）
 * - `設定/` の中（設定資料そのもの。**抽出の結果であって材料ではない**）
 * - `.txt` / `.md` 以外（画像・JSON・PDF）
 *
 * **本文フォルダーの名前は見ない。** 作者は `本文/` を使わずに直下へ
 * 置くこともできる（`scanner.ts` がそう扱う）ので、名前で絞ると
 * その作品の本文が1つも数えられなくなる。
 */
export function isBodyChangePath(relative: string): boolean {
  const normalized = relative.replace(/\\/g, "/");
  if (!normalized || normalized.startsWith("/")) return false;

  const segments = normalized.split("/");
  if (segments.includes(AIWRITER_DIR)) return false;
  if (segments.includes(DEFAULT_SETTINGS_DIR)) return false;
  // 回復用の控え（`.novelai-recovery/`）など、点で始まる置き場も外す
  if (segments.some((part) => part.startsWith("."))) return false;

  const lower = normalized.toLowerCase();
  return BODY_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

/** 入れ替わったファイルから、本文だけを残す */
export function bodyChangePaths(files: readonly string[]): string[] {
  return files.filter(isBodyChangePath);
}
