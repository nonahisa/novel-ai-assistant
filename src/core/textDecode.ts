import { hashBytes } from "./hash";
import { detectEol } from "./eolAudit";
import type { Eol } from "../models/types";

/**
 * バイト列を本文として読む部分だけ（設計書6.87.8 の7）。
 *
 * **`textFile.ts` から切り出したのは、あちらが `vscode.workspace.fs` を
 * 静的に import しているからである。** 外から呼ぶ束（MCP サーバー）は
 * Node の `fs` でバイト列を取り、その解釈——文字コードの判定・改行の判定・
 * ハッシュ——は製品と同じものを通す。判定を写すと、Shift_JIS の古い
 * ダウンロードファイルの読み方が製品とMCPで食い違う。
 *
 * 切り方は `hash.ts`（`textFile.ts` から `hashText` を出したとき）や
 * `pathText.ts`（`paths.ts` から `toUri` の要らない部分を出したとき）と
 * 同じ形で、**使う側の既定は今までどおり `textFile`**（そのまま再輸出する）。
 */

export type Encoding = "utf8" | "utf8-bom" | "shift_jis";
export type { Eol };

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
  /**
   * 1つのファイルの中で CRLF と LF（か CR）が混ざっているか（設計書5.4.2）。
   *
   * **`eol` だけでは分からない。** あちらは「最初に見つかった改行」なので、
   * 途中から別の改行になっていても CRLF のファイルに見える。混ざったまま
   * 外のツールで開くと、行の位置がずれる。
   */
  hasMixedEol: boolean;
}

/** 競合マーカーの検出パターン */
const CONFLICT_PATTERN = /^(<{7}|={7}|>{7})(\s|$)/m;

/**
 * Gitの競合マーカーを含むか。
 *
 * **書き込む前の本文にも掛ける**（`textFile.ts`）ので、パターンを
 * 写さずに済むよう関数にして出しておく。
 */
export function hasConflictMarkers(text: string): boolean {
  return CONFLICT_PATTERN.test(text);
}

export function decodeBytes(bytes: Uint8Array): TextFileContent {
  const hash = hashBytes(bytes);
  const { raw, encoding } = decodeWithDetection(bytes);

  // **`eol` の決め方は変えない**（多いほうではなく、最初に見つかったもの）。
  // ここを変えると、これまで書き戻してきた形が黙って変わる
  const { eol, hasMixedEol } = detectEol(raw);

  const text = raw.replace(/\r\n?/g, "\n");
  const hasTrailingNewline = text.endsWith("\n");

  return {
    text,
    encoding,
    eol,
    hasTrailingNewline,
    hash,
    hasConflictMarkers: CONFLICT_PATTERN.test(text),
    hasMixedEol,
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
