import iconv from "iconv-lite";
import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  currentFileHash,
  decodeBytes,
  getOpenDocumentText,
  hashText,
  readTextFile,
  writeTextFilePreservingFormat,
} from "../../src/core/textFile";
import { FileSystemError, Uri, workspace } from "./support/vscodeStub";

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
  const directories = new Set<string>();
  let savedBytes: Uint8Array | undefined;
  let rename: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    files.clear();
    directories.clear();
    directories.add("c:\\novels");
    savedBytes = undefined;
    workspace.textDocuments = [];
    rename = vi.fn(
      async (
        from: { fsPath: string },
        to: { fsPath: string },
        options?: { overwrite?: boolean }
      ) => {
        const bytes = files.get(fileKey(from.fsPath));
        if (!bytes) throw new FileSystemError("missing", "FileNotFound");
        if (!options?.overwrite && files.has(fileKey(to.fsPath))) {
          throw new FileSystemError("exists", "FileExists");
        }
        savedBytes = bytes;
        files.set(fileKey(to.fsPath), bytes);
        files.delete(fileKey(from.fsPath));
      }
    );
    workspace.fs = {
      createDirectory: vi.fn(async (uri: { fsPath: string }) => {
        directories.add(fileKey(uri.fsPath));
      }),
      readDirectory: vi.fn(async (uri: { fsPath: string }) => {
        const directory = fileKey(uri.fsPath);
        if (!directories.has(directory)) {
          throw new FileSystemError("missing", "FileNotFound");
        }
        return [...files.keys()]
          .filter((filePath) => filePath.slice(0, filePath.lastIndexOf("\\")) === directory)
          .map((filePath) => [filePath.slice(filePath.lastIndexOf("\\") + 1), 1]);
      }),
      readFile: vi.fn(async (uri: { fsPath: string }) => {
        const bytes = files.get(fileKey(uri.fsPath));
        if (!bytes) throw new FileSystemError("missing", "FileNotFound");
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

  test("VS Codeのファイルシステムから本文と形式情報を読み込む", async () => {
    const bytes = bom(utf8("灯\r\n澪"));
    files.set(fileKey(path), bytes);

    const result = await readTextFile(path);

    expect(result).toMatchObject({
      text: "灯\n澪",
      encoding: "utf8-bom",
      eol: "\r\n",
      hasTrailingNewline: false,
    });
  });

  test("元に末尾改行がある場合は修正文にも末尾改行を復元する", async () => {
    const originalBytes = utf8("灯\n澪\n");
    const original = decodeBytes(originalBytes);
    files.set(fileKey(path), originalBytes);

    const result = await writeTextFilePreservingFormat(
      path,
      "灯\n翠",
      original,
      original.hash
    );

    expect(result).toEqual({ ok: true });
    expect(new TextDecoder().decode(savedBytes)).toBe("灯\n翠\n");
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

  test("一時書き込み中の外部編集を上書きも削除もしない", async () => {
    const originalBytes = utf8("灯\n澪\n");
    const changedByAuthor = utf8("灯\n碧\n");
    const original = decodeBytes(originalBytes);
    files.set(fileKey(path), originalBytes);
    workspace.fs.writeFile = vi.fn(
      async (uri: { fsPath: string }, bytes: Uint8Array) => {
        files.set(fileKey(uri.fsPath), bytes);
        files.set(fileKey(path), changedByAuthor);
      }
    );

    const result = await writeTextFilePreservingFormat(
      path,
      "灯\n翠\n",
      original,
      original.hash
    );

    expect(result).toEqual({ ok: false, reason: "modified_externally" });
    expect(files.get(fileKey(path))).toEqual(changedByAuthor);
  });

  test("回復が必要な競合では詳細と回復パスを返す", async () => {
    const originalBytes = utf8("灯\n澪\n");
    const original = decodeBytes(originalBytes);
    files.set(fileKey(path), originalBytes);
    workspace.fs.readFile = vi.fn(async (uri: { fsPath: string }) => {
      if (uri.fsPath.endsWith(".bak")) {
        throw new FileSystemError("backup denied", "NoPermissions");
      }
      const bytes = files.get(fileKey(uri.fsPath));
      if (!bytes) throw new FileSystemError("missing", "FileNotFound");
      return bytes;
    });

    const result = await writeTextFilePreservingFormat(
      path,
      "灯\n翠\n",
      original,
      original.hash
    );

    expect(result).toMatchObject({
      ok: false,
      reason: "path_conflict",
      detail: expect.stringContaining("手動"),
      recoveryPaths: expect.arrayContaining([expect.stringContaining(".bak")]),
    });
  });

  test("保存対象が消えている場合は外部変更として扱う", async () => {
    const original = decodeBytes(utf8("灯\n澪\n"));

    const result = await writeTextFilePreservingFormat(
      path,
      original.text,
      original,
      original.hash
    );

    expect(result).toEqual({ ok: false, reason: "modified_externally" });
    expect(rename).not.toHaveBeenCalled();
  });

  test("原子的保存の想定外エラーは隠さず伝播する", async () => {
    const originalBytes = utf8("灯\n澪\n");
    const original = decodeBytes(originalBytes);
    files.set(fileKey(path), originalBytes);
    workspace.fs.writeFile = vi.fn(async () => {
      throw new Error("write failed");
    });

    await expect(
      writeTextFilePreservingFormat(path, original.text, original, original.hash)
    ).rejects.toThrow("write failed");
  });

  test("文字列ハッシュは既知のSHA-256値を返す", () => {
    expect(hashText("灯")).toBe(
      "28656d470286ce04758c3e218418bfa33ccbe2c5d24fb6bbfbc981044ec2c3cc"
    );
  });

  test("現在ファイルのハッシュを返し読めない場合は未取得にする", async () => {
    files.set(fileKey(path), utf8("灯"));

    await expect(currentFileHash(path)).resolves.toBe(
      "28656d470286ce04758c3e218418bfa33ccbe2c5d24fb6bbfbc981044ec2c3cc"
    );
    await expect(currentFileHash("C:\\novels\\missing.txt")).resolves.toBeUndefined();
  });

  test("開いている文書の未保存本文を返し閉じた文書は未取得にする", () => {
    workspace.textDocuments = [{
      uri: Uri.file(path),
      isDirty: true,
      getText: () => "執筆中の本文",
    }];

    expect(getOpenDocumentText(path)).toBe("執筆中の本文");
    expect(getOpenDocumentText("C:\\novels\\missing.txt")).toBeUndefined();
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
