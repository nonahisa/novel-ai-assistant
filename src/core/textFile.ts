import * as vscode from "vscode";
import * as crypto from "crypto";
import iconv = require("iconv-lite");
import { AtomicWriteFileError, atomicWriteFile } from "./atomicWrite";

export type Encoding = "utf8" | "utf8-bom" | "shift_jis";
export type Eol = "\n" | "\r\n" | "\r";
export type WriteTextFailureReason =
  | "modified_externally"
  | "conflict_markers"
  | "unsaved_changes"
  | "encoding_error";

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
  const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(filePath));
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
): Promise<{ ok: true } | { ok: false; reason: WriteTextFailureReason }> {
  const uri = vscode.Uri.file(filePath);

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

  if (original.eol !== "\n") {
    out = out.replace(/\n/g, original.eol);
  }

  const bytes = encodeText(out, original.encoding);
  if (!bytes) {
    return { ok: false, reason: "encoding_error" };
  }

  try {
    await atomicWriteFile(filePath, bytes, {
      mode: "replace",
      expectedHash,
    });
  } catch (error) {
    if (error instanceof AtomicWriteFileError) {
      return { ok: false, reason: "modified_externally" };
    }
    throw error;
  }
  return { ok: true };
}

function encodeText(text: string, encoding: Encoding): Uint8Array | undefined {
  if (encoding === "shift_jis") {
    const encoded = iconv.encode(text, "shift_jis");
    // 代替文字への置換を許すと、保存成功に見えて本文を壊してしまう。
    return iconv.decode(encoded, "shift_jis") === text ? encoded : undefined;
  }
  const body = new TextEncoder().encode(text);
  if (encoding === "utf8-bom") {
    const bom = new Uint8Array([0xef, 0xbb, 0xbf]);
    const out = new Uint8Array(bom.length + body.length);
    out.set(bom, 0);
    out.set(body, bom.length);
    return out;
  }
  return body;
}

export function hashBytes(bytes: Uint8Array): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

export function hashText(text: string): string {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

/** 現在ディスク上にあるファイルのハッシュを取得する */
export async function currentFileHash(
  filePath: string
): Promise<string | undefined> {
  try {
    const bytes = await vscode.workspace.fs.readFile(
      vscode.Uri.file(filePath)
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

function sameFilePath(left: string, right: string): boolean {
  const normalizedLeft = vscode.Uri.file(left).fsPath;
  const normalizedRight = vscode.Uri.file(right).fsPath;

  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}
