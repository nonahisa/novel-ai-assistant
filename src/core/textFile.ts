import * as vscode from "vscode";
import { fromUri } from "./paths";
import * as path from "./paths";
import { hashBytes } from "./hash";
import { decodeBytes, hasConflictMarkers } from "./textDecode";
import type { Encoding, TextFileContent } from "./textDecode";
import iconv = require("iconv-lite");
import { diffArrays } from "diff";
import {
  AtomicWriteFileError,
  atomicWriteFile,
  createManagedRecoveryPath,
  pruneManagedRecoveries,
} from "./atomicWrite";
import type { Eol } from "../models/types";

// バイト列の読み方（文字コード・改行・ハッシュ）は `textDecode.ts` にある
// ——`vscode` の要らない部分なので、外から呼ぶ束（設計書6.87.8）が
// 同じ判定を通せるように分けてある。**使う側はこれまでどおりここを指す**
export { decodeBytes };
export type { Encoding, TextFileContent };
// 改行コードの型は `models` に置いてある（走査の結果も持つため）。
// ここからは、これまでどおりの名前で再輸出する
export type { Eol };

export async function readTextFile(
  filePath: string
): Promise<TextFileContent> {
  const bytes = await vscode.workspace.fs.readFile(path.toUri(filePath));
  return decodeBytes(bytes);
}

export type WriteTextFailureReason =
  | "modified_externally"
  | "path_conflict"
  | "conflict_markers"
  | "unsaved_changes"
  | "encoding_error";

export type WriteTextFileResult =
  /**
   * 書けた。`recoveryPath` は書き換える前の本文を退避した先
   * （`.novelai-recovery` の中の `.bak`）。**「元に戻す」を出すのに要る**——
   * この関数は「削除→作り直し」で書くため、VS Codeの取り消し履歴には
   * 載らず Ctrl+Z では戻せない（設計書6.12.5）。
   */
  | { ok: true; recoveryPath?: string }
  | {
      ok: false;
      reason: WriteTextFailureReason;
      detail?: string;
      recoveryPaths?: string[];
    };

export interface WriteTextFileOptions {
  /**
   * **書かなかった行の改行コードまで、`original.eol` に揃え直す。**
   *
   * 既定（`false`）は、これまでどおり**変わらなかったところの元バイトを
   * そのまま置く**——1文字直しただけで全行が変更扱いになるのを防ぐための
   * 決まりで（設計書5.4.2）、そこには改行のバイトも含まれる。つまり
   * **本文が同じなら、`eol` に別の値を渡しても1バイトも変わらない。**
   *
   * 「改行コードを揃える」（`features/eolUnify.ts`）だけは、変えたいものが
   * その改行そのものなので、ここを `true` にして通る。**本文の文字は
   * 1文字も変わらない**（改行以外のバイトは元のまま置く）。
   */
  rewriteEol?: boolean;
}

/**
 * 読み込み時と同じ形式で書き戻す。
 *
 * @param expectedHash 読み込み時のハッシュ。ディスク上の現在の内容と
 *   一致しない場合は書き込まず `{ ok: false, reason: "modified_externally" }` を返す
 *   （外部編集による上書き事故の防止）。
 */
export async function writeTextFilePreservingFormat(
  filePath: string,
  newText: string,
  original: Pick<TextFileContent, "encoding" | "eol" | "hasTrailingNewline">,
  expectedHash: string,
  options: WriteTextFileOptions = {}
): Promise<WriteTextFileResult> {
  const uri = path.toUri(filePath);

  if (hasUnsavedChanges(filePath)) {
    return { ok: false, reason: "unsaved_changes" };
  }

  if (hasConflictMarkers(newText)) {
    return { ok: false, reason: "conflict_markers" };
  }

  let current: Uint8Array;
  try {
    current = await vscode.workspace.fs.readFile(uri);
  } catch {
    // ファイルが消えている場合も外部変更として扱う
    return { ok: false, reason: "modified_externally" };
  }

  if (decodeBytes(current).hasConflictMarkers) {
    return { ok: false, reason: "conflict_markers" };
  }

  if (hashBytes(current) !== expectedHash) {
    return { ok: false, reason: "modified_externally" };
  }

  let out = newText.replace(/\r\n?/g, "\n");

  // 末尾改行の有無を元に合わせる
  if (original.hasTrailingNewline && !out.endsWith("\n")) {
    out += "\n";
  } else if (!original.hasTrailingNewline) {
    out = out.replace(/\n+$/, "");
  }

  const bytes = encodePreservingUnchangedBytes(
    current,
    out,
    original.encoding,
    original.eol,
    options.rewriteEol === true
  );
  if (!bytes) {
    return { ok: false, reason: "encoding_error" };
  }

  /**
   * 公開FS APIには「期待した版なら置換」を一命令で行う原子的CASが無い
   * （`atomicWrite.ts` の `replaceGuarded` は、そのため正規パスへは触れず
   * 必ず失敗する）。人物設定など既存レコードの更新と同じ
   * 「①今の原稿を回復先へコピー → ②元ファイルを削除 → ③新しい内容で作り直す」
   * の手順で書き戻す。
   *
   * **退避は `rename` ではなく「コピー＋削除」で行う。** `rename` で退避すると、
   * そのファイルがエディターで開いている場合にVS Codeが開いたタブを
   * リネーム先（回復フォルダの中の `.bak` ファイル）へ追従させてしまい、
   * 開いていたタブが本文と無関係な回復ファイルを指したまま取り残される
   * （実機で発覚、2026-08-12・2026-08-13）。`delete` はリネームと違い
   * 「追従先」が無いため、この事故が起きない。
   */
  let recoveryPath: string;
  try {
    recoveryPath = await createManagedRecoveryPath(filePath);
  } catch (error) {
    return {
      ok: false,
      reason: "path_conflict",
      detail: `回復先を準備できませんでした: ${describeError(error)}`,
    };
  }

  let recheck: Uint8Array;
  try {
    // 退避の直前にもう一度ハッシュを確かめる。ここまでの間に
    // 外部から書き換えられている可能性がわずかに残るため
    recheck = await vscode.workspace.fs.readFile(uri);
    if (hashBytes(recheck) !== expectedHash) {
      return { ok: false, reason: "modified_externally" };
    }
  } catch {
    return { ok: false, reason: "modified_externally" };
  }

  try {
    // 今の原稿を回復先へコピーする（まだ元ファイルには触れない）
    await atomicWriteFile(recoveryPath, recheck, { mode: "create" });
  } catch (error) {
    const detail =
      error instanceof AtomicWriteFileError
        ? error.message
        : describeError(error);
    return {
      ok: false,
      reason: "path_conflict",
      detail: `回復先へコピーできませんでした: ${detail}`,
    };
  }

  try {
    await vscode.workspace.fs.delete(uri, { useTrash: false });
  } catch {
    // 削除できなければ原稿本体にはまだ触れていない。回復先のコピーだけ残るが実害はない
    return { ok: false, reason: "modified_externally" };
  }

  try {
    await atomicWriteFile(filePath, bytes, { mode: "create" });
  } catch (error) {
    // 新しい内容の配置に失敗しても、元の原稿は退避先にそのまま残っている
    const detail =
      error instanceof AtomicWriteFileError
        ? error.message
        : describeError(error);
    return {
      ok: false,
      reason: "path_conflict",
      detail: `元の原稿は「${recoveryPath}」に退避されています。${detail}`,
      recoveryPaths: [recoveryPath],
    };
  }

  await pruneManagedRecoveries(filePath);
  // 退避先を呼び出し側へ返す。いま作ったものが最新なので、
  // pruneManagedRecoveries（5世代まで残す）で消えることはない
  return { ok: true, recoveryPath };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface EncodedToken {
  text: string;
  bytes: Uint8Array;
}

/**
 * 編集されていない文字の元バイト列を再利用する。
 * CP932には同じ文字へ復号される複数の符号があるため、全文再エンコードでは
 * 無変更箇所まで別バイトへ正規化されてしまう。
 *
 * @param rewriteEol 変わらなかった改行も `preferredEol` へ置き直すか。
 *   **既定は false**——改行のバイトも「変わらなかったところ」なので、
 *   そのまま置く（1文字直しただけで全行が変更扱いになるのを防ぐ）。
 */
function encodePreservingUnchangedBytes(
  originalBytes: Uint8Array,
  normalizedText: string,
  encoding: Encoding,
  preferredEol: Eol,
  rewriteEol = false
): Uint8Array | undefined {
  const tokenized = tokenizeOriginalBytes(originalBytes, encoding);
  if (tokenized.text === normalizedText && !rewriteEol) {
    return originalBytes.slice();
  }

  /** 変わらなかった1文字ぶんのバイト。改行だけは目標の形へ置き直せる */
  const keep = (token: EncodedToken): Uint8Array =>
    rewriteEol && token.text === "\n" ? eolBytes(preferredEol) : token.bytes;

  const desiredTokens = Array.from(normalizedText);
  const changes = diffArrays(
    tokenized.tokens.map((token) => token.text),
    desiredTokens
  );
  const output: Uint8Array[] = [];
  let originalIndex = 0;

  for (const change of changes) {
    if (change.added) {
      const encoded = encodeFragment(
        change.value.join("").replace(/\n/g, preferredEol),
        encoding
      );
      if (!encoded) return undefined;
      output.push(encoded);
      continue;
    }

    const count = change.value.length;
    if (!change.removed) {
      for (let index = 0; index < count; index += 1) {
        output.push(keep(tokenized.tokens[originalIndex + index]));
      }
    }
    originalIndex += count;
  }

  return concatenateBytes(tokenized.prefix, output);
}

/** 改行コードのバイト列。UTF-8でもShift_JISでも同じ（ASCIIの範囲） */
function eolBytes(eol: Eol): Uint8Array {
  if (eol === "\r\n") return new Uint8Array([0x0d, 0x0a]);
  if (eol === "\r") return new Uint8Array([0x0d]);
  return new Uint8Array([0x0a]);
}

function tokenizeOriginalBytes(
  bytes: Uint8Array,
  encoding: Encoding
): { prefix: Uint8Array; tokens: EncodedToken[]; text: string } {
  const bodyStart = encoding === "utf8-bom" ? 3 : 0;
  const prefix = bytes.slice(0, bodyStart);
  const tokens: EncodedToken[] = [];
  let offset = bodyStart;

  while (offset < bytes.length) {
    const first = bytes[offset];
    if (first === 0x0d) {
      const length = bytes[offset + 1] === 0x0a ? 2 : 1;
      tokens.push({ text: "\n", bytes: bytes.slice(offset, offset + length) });
      offset += length;
      continue;
    }
    if (first === 0x0a) {
      tokens.push({ text: "\n", bytes: bytes.slice(offset, offset + 1) });
      offset += 1;
      continue;
    }

    const length = encoding === "shift_jis"
      ? shiftJisCharacterLength(first)
      : utf8CharacterLength(first);
    const raw = bytes.slice(offset, Math.min(offset + length, bytes.length));
    const text = encoding === "shift_jis"
      ? iconv.decode(raw, "shift_jis")
      : new TextDecoder("utf-8").decode(raw);
    tokens.push({ text, bytes: raw });
    offset += raw.length;
  }

  return {
    prefix,
    tokens,
    text: tokens.map((token) => token.text).join(""),
  };
}

function shiftJisCharacterLength(first: number): number {
  return (first >= 0x81 && first <= 0x9f) || (first >= 0xe0 && first <= 0xfc)
    ? 2
    : 1;
}

function utf8CharacterLength(first: number): number {
  if ((first & 0x80) === 0) return 1;
  if ((first & 0xe0) === 0xc0) return 2;
  if ((first & 0xf0) === 0xe0) return 3;
  if ((first & 0xf8) === 0xf0) return 4;
  return 1;
}

function encodeFragment(text: string, encoding: Encoding): Uint8Array | undefined {
  if (encoding === "shift_jis") {
    const encoded = iconv.encode(text, "shift_jis");
    // 代替文字への置換を許すと、保存成功に見えて本文を壊してしまう。
    return iconv.decode(encoded, "shift_jis") === text ? encoded : undefined;
  }
  const body = new TextEncoder().encode(text);
  return body;
}

/**
 * 新しいファイルとして書き出すためのバイト列を作る。
 *
 * 競合の「両方を残す」（設計書5.5.4）で、別環境の版を
 * 別ファイルへ残すときに使う。**元のファイルと同じ文字コード・
 * 改行コードで書く。** 片方だけUTF-8/LFになると、あとで見比べる
 * ときに全行が変更扱いになって差分が読めなくなる。
 *
 * Shift_JISで表せない文字が混ざっていたら undefined を返す。
 * 代替文字に置き換えて「保存できた」ことにすると本文が壊れる。
 */
export function encodeForNewFile(
  text: string,
  original: Pick<TextFileContent, "encoding" | "eol" | "hasTrailingNewline">
): Uint8Array | undefined {
  let normalized = text.replace(/\r\n?/g, "\n");
  if (original.hasTrailingNewline && !normalized.endsWith("\n")) {
    normalized += "\n";
  } else if (!original.hasTrailingNewline) {
    normalized = normalized.replace(/\n+$/, "");
  }

  const body = encodeFragment(
    normalized.replace(/\n/g, original.eol),
    original.encoding
  );
  if (!body) return undefined;
  if (original.encoding !== "utf8-bom") return body;

  const withBom = new Uint8Array(body.length + 3);
  withBom.set([0xef, 0xbb, 0xbf]);
  withBom.set(body, 3);
  return withBom;
}

function concatenateBytes(
  prefix: Uint8Array,
  parts: Uint8Array[]
): Uint8Array {
  const length = parts.reduce((sum, part) => sum + part.length, prefix.length);
  const result = new Uint8Array(length);
  result.set(prefix);
  let offset = prefix.length;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

/**
 * 内容のハッシュは `hash.ts` へ移した（設計書6.87.3）。
 *
 * **ここに置いたままだと、`hashText` を1つ借りるだけの `chunker.ts` が
 * `vscode` 依存になる。** 呼び出し側（`textFile.hashText` と書いている
 * 箇所）は変えなくてよいように、ここから再輸出する。
 */
export { hashBytes, hashText } from "./hash";

/** 現在ディスク上にあるファイルのハッシュを取得する */
export async function currentFileHash(
  filePath: string
): Promise<string | undefined> {
  try {
    const bytes = await vscode.workspace.fs.readFile(
      path.toUri(filePath)
    );
    return hashBytes(bytes);
  } catch {
    return undefined;
  }
}

/**
 * エディタで開いている未保存の内容を優先して取得する。
 * 文字数計測では書きかけの内容を反映する必要があるため。
 */
export function getOpenDocumentText(filePath: string): string | undefined {
  const doc = vscode.workspace.textDocuments.find(
    (d) => sameFilePath(fromUri(d.uri), filePath)
  );
  if (!doc) return undefined;
  return doc.getText();
}

/** 未保存の変更があるか */
export function hasUnsavedChanges(filePath: string): boolean {
  const doc = vscode.workspace.textDocuments.find(
    (d) => sameFilePath(fromUri(d.uri), filePath)
  );
  return doc?.isDirty ?? false;
}

export function sameFilePath(left: string, right: string): boolean {
  return path.normalizeForComparison(left) === path.normalizeForComparison(right);
}
