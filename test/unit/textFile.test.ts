import iconv from "iconv-lite";
import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  decodeBytes,
  writeTextFilePreservingFormat,
} from "../../src/core/textFile";
import { Uri, workspace } from "./support/vscodeStub";

const path = "C:\\novels\\001.txt";
const fileKey = (filePath: string): string => filePath.toLowerCase();
const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);
const bom = (bytes: Uint8Array): Uint8Array => {
  const result = new Uint8Array(3 + bytes.length);
  result.set([0xef, 0xbb, 0xbf]);
  result.set(bytes, 3);
  return result;
};
const shiftJis = (text: string): Uint8Array => iconv.encode(text, "shift_jis");

describe("本文形式を保持した保存", () => {
  const files = new Map<string, Uint8Array>();
  let savedBytes: Uint8Array | undefined;
  let rename: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    files.clear();
    savedBytes = undefined;
    workspace.textDocuments = [];
    rename = vi.fn(async (from: { fsPath: string }, to: { fsPath: string }) => {
      const bytes = files.get(fileKey(from.fsPath));
      if (!bytes) throw new Error("一時ファイルがありません");
      savedBytes = bytes;
      files.set(fileKey(to.fsPath), bytes);
      files.delete(fileKey(from.fsPath));
    });
    workspace.fs = {
      readFile: vi.fn(async (uri: { fsPath: string }) => {
        const bytes = files.get(fileKey(uri.fsPath));
        if (!bytes) throw new Error("ファイルがありません");
        return bytes;
      }),
      writeFile: vi.fn(async (uri: { fsPath: string }, bytes: Uint8Array) => {
        files.set(fileKey(uri.fsPath), bytes);
      }),
      rename,
      delete: vi.fn(async (uri: { fsPath: string }) => {
        files.delete(fileKey(uri.fsPath));
      }),
    };
  });

  test.each([
    ["UTF-8 LF", utf8("灯\n澪\n"), "utf8", "\n", true],
    ["UTF-8 BOM CRLF", bom(utf8("灯\r\n澪")), "utf8-bom", "\r\n", false],
    ["Shift_JIS CR", shiftJis("灯\r澪\r"), "shift_jis", "\r", true],
  ])("%sを往復して同じバイト列を保存する", async (_label, bytes, encoding, eol, hasTrailingNewline) => {
    const original = decodeBytes(bytes);
    files.set(fileKey(path), bytes);

    const result = await writeTextFilePreservingFormat(
      path,
      original.text,
      original,
      original.hash
    );

    expect(original.encoding).toBe(encoding);
    expect(original.eol).toBe(eol);
    expect(original.hasTrailingNewline).toBe(hasTrailingNewline);
    expect(result).toEqual({ ok: true });
    expect(savedBytes).toEqual(bytes);
  });

  test.each([
    ["ハッシュ不一致", "modified_externally"],
    ["未保存バッファ", "unsaved_changes"],
    ["現在の競合マーカー", "conflict_markers"],
    ["出力の競合マーカー", "conflict_markers"],
    ["Shift_JIS不能文字", "encoding_error"],
  ])("%sでは元ファイルへ書かない", async (label, reason) => {
    expect(await runGuardCase(label)).toEqual({ ok: false, reason });
    expect(rename).not.toHaveBeenCalled();
  });

  test("ハッシュなしの保存要求では元ファイルへ書かない", async () => {
    const original = decodeBytes(shiftJis("灯\n澪\n"));
    files.set(fileKey(path), shiftJis("灯\n澪\n"));

    const result = await writeTextFilePreservingFormat(
      path,
      original.text,
      original,
      undefined as never
    );

    expect(result).toEqual({ ok: false, reason: "modified_externally" });
    expect(rename).not.toHaveBeenCalled();
  });

  test("ドライブ文字の大文字小文字が違う未保存バッファでは元ファイルへ書かない", async () => {
    const original = decodeBytes(shiftJis("灯\n澪\n"));
    files.set(fileKey(path), shiftJis("灯\n澪\n"));
    workspace.textDocuments = [{
      uri: Uri.file(path),
      isDirty: true,
      getText: () => "灯\n澪\n",
    }];

    const result = await writeTextFilePreservingFormat(
      path,
      original.text,
      original,
      original.hash
    );

    expect(result).toEqual({ ok: false, reason: "unsaved_changes" });
    expect(rename).not.toHaveBeenCalled();
  });

  async function runGuardCase(label: string) {
    const original = decodeBytes(shiftJis("灯\n澪\n"));
    files.set(fileKey(path), shiftJis("灯\n澪\n"));

    switch (label) {
      case "ハッシュ不一致":
        files.set(fileKey(path), shiftJis("灯\n碧\n"));
        return writeTextFilePreservingFormat(path, original.text, original, original.hash);
      case "未保存バッファ":
        workspace.textDocuments = [{
          uri: { fsPath: path },
          isDirty: true,
          getText: () => "灯\n澪\n",
        }];
        return writeTextFilePreservingFormat(path, original.text, original, original.hash);
      case "現在の競合マーカー":
        files.set(fileKey(path), utf8("<<<<<<< HEAD\n灯\n=======\n澪\n>>>>>>> origin/main\n"));
        return writeTextFilePreservingFormat(path, original.text, original, original.hash);
      case "出力の競合マーカー":
        return writeTextFilePreservingFormat(
          path,
          "<<<<<<< HEAD\n灯\n=======\n澪\n>>>>>>> origin/main\n",
          original,
          original.hash
        );
      case "Shift_JIS不能文字":
        return writeTextFilePreservingFormat(path, "灯😀\n澪\n", original, original.hash);
      default:
        throw new Error(`未対応のテストケースです: ${label}`);
    }
  }
});
