import * as vscode from "vscode";
import * as crypto from "crypto";

export type Encoding = "utf8" | "utf8-bom" | "shift_jis";
export type Eol = "\n" | "\r\n" | "\r";

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
 *   一致しない場合は書き込まず false を返す（外部編集による上書き事故の防止）。
 */
export async function writeTextFilePreservingFormat(
  filePath: string,
  newText: string,
  original: Pick<TextFileContent, "encoding" | "eol" | "hasTrailingNewline">,
  expectedHash?: string
): Promise<{ ok: true } | { ok: false; reason: "modified_externally" }> {
  const uri = vscode.Uri.file(filePath);

  if (expectedHash !== undefined) {
    try {
      const current = await vscode.workspace.fs.readFile(uri);
      if (hashBytes(current) !== expectedHash) {
        return { ok: false, reason: "modified_externally" };
      }
    } catch {
      // ファイルが消えている場合も外部変更として扱う
      return { ok: false, reason: "modified_externally" };
    }
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

  await vscode.workspace.fs.writeFile(uri, encodeText(out, original.encoding));
  return { ok: true };
}

function encodeText(text: string, encoding: Encoding): Uint8Array {
  if (encoding === "shift_jis") {
    // Node標準ではShift_JISのエンコードができない。
    // 元がShift_JISでも書き戻しはUTF-8とし、その旨を呼び出し側で通知する。
    // （文字化けを起こすより、明示的に形式が変わったと伝える方が安全）
    return new TextEncoder().encode(text);
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
    (d) => d.uri.fsPath === filePath
  );
  if (!doc) return undefined;
  return doc.getText();
}

/** 未保存の変更があるか */
export function hasUnsavedChanges(filePath: string): boolean {
  const doc = vscode.workspace.textDocuments.find(
    (d) => d.uri.fsPath === filePath
  );
  return doc?.isDirty ?? false;
}
