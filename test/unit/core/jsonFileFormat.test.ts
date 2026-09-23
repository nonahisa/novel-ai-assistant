import { describe, expect, test } from "vitest";
import {
  detectJsonFileFormat,
  formatJsonForFile,
  NEW_JSON_FILE_FORMAT,
} from "../../../src/core/jsonFileFormat";

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

describe("設定資料のJSONの改行の形", () => {
  test("CRLF と末尾の改行の有無を読み取る", () => {
    expect(detectJsonFileFormat(bytes('{\r\n  "a": 1\r\n}\r\n'))).toEqual({
      useCrlf: true,
      finalNewline: true,
    });
    expect(detectJsonFileFormat(bytes('{\r\n  "a": 1\r\n}'))).toEqual({
      useCrlf: true,
      finalNewline: false,
    });
    expect(detectJsonFileFormat(bytes('{\n  "a": 1\n}\n'))).toEqual({
      useCrlf: false,
      finalNewline: true,
    });
  });

  test("CRLF で書いても、値の中の改行は書き換えない", () => {
    // 値の中の改行は `\n` と書かれるので、行の区切りだけが CRLF になる
    const text = formatJsonForFile(
      { note: "一行目\n二行目" },
      { useCrlf: true, finalNewline: true }
    );
    expect(text).toBe('{\r\n  "note": "一行目\\n二行目"\r\n}\r\n');
    expect(JSON.parse(text)).toEqual({ note: "一行目\n二行目" });
  });

  test("新しく作る形は、これまでの書き方（LF・末尾に改行）と同じ", () => {
    const value = { id: "abil_001", name: "灯火" };
    expect(formatJsonForFile(value, NEW_JSON_FILE_FORMAT)).toBe(
      `${JSON.stringify(value, null, 2)}\n`
    );
  });
});
