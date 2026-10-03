import * as fs from "node:fs";
import * as nodePath from "node:path";
import { hashBytes } from "../../core/hash";
import { decodeBytes, hasConflictMarkers, type TextFileContent } from "../../core/textDecode";
import { encodePreservingFormat } from "../../core/textEncodePreserving";
import { pruneRecoveries, recoveryPathFor } from "./recoveryFile";

/**
 * MCP から本文（.txt/.md）を書き戻す（出先の原稿箱 6.115 の取り込み）。
 *
 * **製品の `writeTextFilePreservingFormat`（`core/textFile.ts`）と同じ手順・同じ判断**：
 *
 * 1. 書く中身に競合マーカーがあれば書かない
 * 2. いまのファイルを読み、競合マーカーがあれば書かない
 * 3. **読み込み時のハッシュ（`expectedHash`）と違えば書かない**（外で直された）
 * 4. バイト列は `core/textEncodePreserving.ts` で作る（文字コード・改行・末尾改行・
 *    変わらなかったところの元バイトを保つ）——**ここは製品と同じ関数**
 * 5. 「回復先へコピー → 退避の直前にもう一度ハッシュ → 元を消す → 新しく作る」
 *    （既存ファイルを上書きしない。`replaceGuarded` を使わない理由は `textFile.ts`）
 *
 * 製品の関数は `vscode.workspace.fs` を通るので、Node の別プロセスからは呼べない。
 * **違うのは I/O だけ**で、判断はすべて同じ部品を通す。
 *
 * **製品と違って確かめられないことが1つある**：VS Code で開いている未保存の
 * 書きかけ（`hasUnsavedChanges`）は、別プロセスからは見えない。書いたあとに
 * 作者が保存すると、VS Code が「ディスクの方が新しい」と知らせる。
 */

export type BodyWriteFailure =
  | "modified_externally"
  | "conflict_markers"
  | "encoding_error"
  | "path_conflict";

export type BodyWriteResult =
  | { ok: true; recoveryPath: string; hash: string }
  | { ok: false; reason: BodyWriteFailure; detail?: string };

export function writeBodyPreservingFormat(
  absolutePath: string,
  newText: string,
  original: Pick<TextFileContent, "encoding" | "eol" | "hasTrailingNewline">,
  expectedHash: string
): BodyWriteResult {
  if (hasConflictMarkers(newText)) {
    return { ok: false, reason: "conflict_markers" };
  }

  let current: Uint8Array;
  try {
    current = fs.readFileSync(absolutePath);
  } catch {
    // ファイルが消えている場合も外部変更として扱う（製品と同じ）
    return { ok: false, reason: "modified_externally" };
  }
  if (decodeBytes(current).hasConflictMarkers) {
    return { ok: false, reason: "conflict_markers" };
  }
  if (hashBytes(current) !== expectedHash) {
    return { ok: false, reason: "modified_externally" };
  }

  const bytes = encodePreservingFormat(current, newText, original);
  if (!bytes) return { ok: false, reason: "encoding_error" };

  const recoveryPath = recoveryPathFor(absolutePath);
  try {
    fs.mkdirSync(nodePath.dirname(recoveryPath), { recursive: true });
  } catch (error) {
    return { ok: false, reason: "path_conflict", detail: `回復先を準備できませんでした: ${describe(error)}` };
  }

  // 退避の直前にもう一度ハッシュを確かめる（ここまでの間に外で書き換えられたとき）
  let recheck: Uint8Array;
  try {
    recheck = fs.readFileSync(absolutePath);
  } catch {
    return { ok: false, reason: "modified_externally" };
  }
  if (hashBytes(recheck) !== expectedHash) {
    return { ok: false, reason: "modified_externally" };
  }

  try {
    // 今の原稿を回復先へコピーする（まだ元ファイルには触れない）。`wx`＝在れば失敗
    fs.writeFileSync(recoveryPath, recheck, { flag: "wx" });
  } catch (error) {
    return { ok: false, reason: "path_conflict", detail: `回復先へコピーできませんでした: ${describe(error)}` };
  }

  try {
    fs.unlinkSync(absolutePath);
  } catch {
    // 消せなければ原稿本体にはまだ触れていない
    return { ok: false, reason: "modified_externally" };
  }

  try {
    fs.writeFileSync(absolutePath, bytes, { flag: "wx" });
  } catch (error) {
    return {
      ok: false,
      reason: "path_conflict",
      detail: `元の原稿は「${recoveryPath}」に退避されています。${describe(error)}`,
    };
  }

  pruneRecoveries(absolutePath);
  return { ok: true, recoveryPath, hash: hashBytes(bytes) };
}

/** 失敗の理由を作者に読める日本語へ（製品の `describeWriteFailure` と同じ言い方に寄せる） */
export function describeBodyWriteFailure(result: Extract<BodyWriteResult, { ok: false }>): string {
  switch (result.reason) {
    case "modified_externally":
      return "パソコンの本文が変わっています（読んだあとに書き換えられました）。";
    case "conflict_markers":
      return "Gitの競合マーカーが残っているため、書きませんでした。先に解消してください。";
    case "encoding_error":
      return "この文字コード（Shift_JIS）で表せない文字が含まれているため、書きませんでした。";
    case "path_conflict":
      return `書き込めませんでした。${result.detail ?? ""}`.trim();
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 本文を読む（バイト列と解釈）。`decodeBytes` は製品と同じもの */
export function readBodyFile(absolutePath: string): { bytes: Uint8Array; content: TextFileContent } {
  const bytes = fs.readFileSync(absolutePath);
  return { bytes, content: decodeBytes(bytes) };
}
