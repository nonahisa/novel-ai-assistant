import iconv = require("iconv-lite");
import { diffArrays } from "diff";
import type { Encoding, TextFileContent } from "./textDecode";
import type { Eol } from "../models/types";

/**
 * 本文を書き戻すときの**バイト列の作り方**（設計書5.4.2）。`vscode` に触らない。
 *
 * `textFile.ts` の `writeTextFilePreservingFormat` から切り出した（2026-10-03、
 * 出先の原稿箱 6.115 の取り込み `outbox.import` を足すとき）。MCP サーバーは
 * Node の別プロセスで `vscode` を読めないので、**書き方の判断（末尾改行・
 * 文字コード・変わらなかったところの元バイト）はここ1か所に置き、
 * 読み書きの I/O だけを呼ぶ側が持つ**。写しを作ると、片方だけ直る日が来る。
 */

export interface EncodePreservingOptions {
  /** 書かなかった行の改行コードまで `original.eol` に揃え直す（`WriteTextFileOptions` と同じ意味） */
  rewriteEol?: boolean;
}

/**
 * いまのバイト列 `currentBytes` を元に、`newText` を同じ形式のバイト列にする。
 *
 * - 末尾改行の有無は `original` に合わせる
 * - 変わらなかった文字は元のバイトをそのまま置く（CP932 の別符号・改行のバイトを保つ）
 *
 * @returns 表せない文字（Shift_JIS に無い字）があれば `undefined`。
 *   代替文字に置き換えて「書けた」ことにすると本文が壊れる
 */
export function encodePreservingFormat(
  currentBytes: Uint8Array,
  newText: string,
  original: Pick<TextFileContent, "encoding" | "eol" | "hasTrailingNewline">,
  options: EncodePreservingOptions = {}
): Uint8Array | undefined {
  let out = newText.replace(/\r\n?/g, "\n");

  // 末尾改行の有無を元に合わせる
  if (original.hasTrailingNewline && !out.endsWith("\n")) {
    out += "\n";
  } else if (!original.hasTrailingNewline) {
    out = out.replace(/\n+$/, "");
  }

  return encodePreservingUnchangedBytes(
    currentBytes,
    out,
    original.encoding,
    original.eol,
    options.rewriteEol === true
  );
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
      const encoded = encodeTextFragment(
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

/**
 * 文字列の一部を、その文字コードのバイト列にする。
 * **Shift_JIS で表せない字があれば `undefined`**（代替文字への置換を許すと、
 * 保存成功に見えて本文を壊してしまう）。
 */
export function encodeTextFragment(
  text: string,
  encoding: Encoding
): Uint8Array | undefined {
  if (encoding === "shift_jis") {
    const encoded = iconv.encode(text, "shift_jis");
    return iconv.decode(encoded, "shift_jis") === text ? encoded : undefined;
  }
  return new TextEncoder().encode(text);
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
