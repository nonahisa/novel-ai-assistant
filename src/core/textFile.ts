import * as vscode from "vscode";
import * as path from "./paths";
import { sha256Bytes, sha256Text } from "./hash";
import iconv = require("iconv-lite");
import { diffArrays } from "diff";
import {
  AtomicWriteFileError,
  atomicWriteFile,
  createManagedRecoveryPath,
  pruneManagedRecoveries,
} from "./atomicWrite";

export type Encoding = "utf8" | "utf8-bom" | "shift_jis";
export type Eol = "\n" | "\r\n" | "\r";
export type WriteTextFailureReason =
  | "modified_externally"
  | "path_conflict"
  | "conflict_markers"
  | "unsaved_changes"
  | "encoding_error";

export type WriteTextFileResult =
  | { ok: true }
  | {
      ok: false;
      reason: WriteTextFailureReason;
      detail?: string;
      recoveryPaths?: string[];
    };

/**
 * 読み込んだファイルの内容と、書き戻しに必要な形式情報。
 *
 * 本文ファイルは外部ツールでも編集されるため、
 * 元の文字コード・改行コードを保持して書き戻す必要がある。
 * これを怠ると誤字を1文字直しただけで全行が変更扱いになり、
 * Gitの差分が壊れ、外部ツール側で文字化けする。
 */
export interface TextFileContent {
  /** 改行をLFに正規化した本文 */
  text: string;
  encoding: Encoding;
  eol: Eol;
  /** 末尾に改行があったか */
  hasTrailingNewline: boolean;
  /** 読み込み時点の内容ハッシュ（上書き事故の検証に使う） */
  hash: string;
  /** Gitの競合マーカーが含まれているか */
  hasConflictMarkers: boolean;
}

/** 競合マーカーの検出パターン */
const CONFLICT_PATTERN = /^(<{7}|={7}|>{7})(\s|$)/m;

export async function readTextFile(
  filePath: string
): Promise<TextFileContent> {
  const bytes = await vscode.workspace.fs.readFile(path.toUri(filePath));
  return decodeBytes(bytes);
}

export function decodeBytes(bytes: Uint8Array): TextFileContent {
  const hash = hashBytes(bytes);
  const { raw, encoding } = decodeWithDetection(bytes);

  const eol: Eol = raw.includes("\r\n")
    ? "\r\n"
    : raw.includes("\r")
      ? "\r"
      : "\n";

  const text = raw.replace(/\r\n?/g, "\n");
  const hasTrailingNewline = text.endsWith("\n");

  return {
    text,
    encoding,
    eol,
    hasTrailingNewline,
    hash,
    hasConflictMarkers: CONFLICT_PATTERN.test(text),
  };
}

function decodeWithDetection(bytes: Uint8Array): {
  raw: string;
  encoding: Encoding;
} {
  // BOM付きUTF-8
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xef &&
    bytes[1] === 0xbb &&
    bytes[2] === 0xbf
  ) {
    return {
      raw: new TextDecoder("utf-8").decode(bytes.slice(3)),
      encoding: "utf8-bom",
    };
  }

  try {
    // fatal:true で不正なUTF-8を検出する
    return {
      raw: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      encoding: "utf8",
    };
  } catch {
    // なろう・カクヨムの古いDLファイルはShift_JISの場合がある
    try {
      return {
        raw: new TextDecoder("shift_jis").decode(bytes),
        encoding: "shift_jis",
      };
    } catch {
      return {
        raw: new TextDecoder("utf-8").decode(bytes),
        encoding: "utf8",
      };
    }
  }
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
  expectedHash: string
): Promise<WriteTextFileResult> {
  const uri = path.toUri(filePath);

  if (hasUnsavedChanges(filePath)) {
    return { ok: false, reason: "unsaved_changes" };
  }

  if (CONFLICT_PATTERN.test(newText)) {
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
    original.eol
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
  return { ok: true };
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
 */
function encodePreservingUnchangedBytes(
  originalBytes: Uint8Array,
  normalizedText: string,
  encoding: Encoding,
  preferredEol: Eol
): Uint8Array | undefined {
  const tokenized = tokenizeOriginalBytes(originalBytes, encoding);
  if (tokenized.text === normalizedText) {
    return originalBytes.slice();
  }

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
        output.push(tokenized.tokens[originalIndex + index].bytes);
      }
    }
    originalIndex += count;
  }

  return concatenateBytes(tokenized.prefix, output);
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

export function hashBytes(bytes: Uint8Array): string {
  return sha256Bytes(bytes);
}

export function hashText(text: string): string {
  return sha256Text(text);
}

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
    (d) => sameFilePath(d.uri.fsPath, filePath)
  );
  if (!doc) return undefined;
  return doc.getText();
}

/** 未保存の変更があるか */
export function hasUnsavedChanges(filePath: string): boolean {
  const doc = vscode.workspace.textDocuments.find(
    (d) => sameFilePath(d.uri.fsPath, filePath)
  );
  return doc?.isDirty ?? false;
}

export function sameFilePath(left: string, right: string): boolean {
  return path.normalizeForComparison(left) === path.normalizeForComparison(right);
}
