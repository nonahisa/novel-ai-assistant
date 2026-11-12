import iconv from "iconv-lite";
import { beforeEach, describe, expect, test } from "vitest";
import {
  convertTextFileToUtf8,
  decodeBytes,
  setBodyWriteGuard,
} from "../../../src/core/textFile";
import { Uri, workspace } from "../support/vscodeStub";
import { memoryFs } from "../support/memoryDisk";

/**
 * 原稿を UTF-8 にする書き込み（設計書5.4.2、0.149.0。実装ルール1）。
 *
 * 書き方は本文の書き戻しと同じ「控えへ写す → 消す → 作り直す」で、関所（校閲中・未保存・
 * 競合の印・ハッシュの照合）も同じものを通ることを確かめる。
 */
const FILE = Uri.file("C:\\novels\\作品\\001.txt").fsPath;
const sjis = (text: string): Uint8Array => iconv.encode(text, "shift_jis");
const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

describe("原稿を UTF-8 にする書き込み", () => {
  const disk = new Map<string, Uint8Array>();

  beforeEach(() => {
    disk.clear();
    workspace.textDocuments = [];
    workspace.fs = memoryFs(disk, { readDirectory: "nested" });
    setBodyWriteGuard(undefined);
  });

  function recoveryCopies(): Uint8Array[] {
    return [...disk.entries()]
      .filter(([key]) => key.includes(".novelai-recovery"))
      .map(([, bytes]) => bytes);
  }

  test("書ける：本文と改行はそのまま UTF-8 になり、元の Shift_JIS のバイトは控えに残る", async () => {
    const before = sjis("灯は言った。\r\n「①から」\r\n");
    disk.set(FILE, before);

    const result = await convertTextFileToUtf8(FILE, decodeBytes(before).hash, { bom: false });

    expect(result.ok).toBe(true);
    expect(disk.get(FILE)).toEqual(utf8("灯は言った。\r\n「①から」\r\n"));
    expect(recoveryCopies()).toEqual([before]);
    if (result.ok) expect(result.recoveryPath).toContain(".novelai-recovery");
  });

  test("BOM 付きにもできる", async () => {
    const before = sjis("灯\n");
    disk.set(FILE, before);
    await convertTextFileToUtf8(FILE, decodeBytes(before).hash, { bom: true });
    expect(decodeBytes(disk.get(FILE) ?? new Uint8Array()).encoding).toBe("utf8-bom");
  });

  test("読んだあとに変わっていたら書かない（控えも作らない）", async () => {
    const before = sjis("灯\n");
    disk.set(FILE, sjis("灯と澪\n"));
    const result = await convertTextFileToUtf8(FILE, decodeBytes(before).hash, { bom: false });
    expect(result).toEqual({ ok: false, reason: "modified_externally" });
    expect(disk.get(FILE)).toEqual(sjis("灯と澪\n"));
    expect(recoveryCopies()).toEqual([]);
  });

  test("開いたまま保存していない変更があれば書かない", async () => {
    const before = sjis("灯\n");
    disk.set(FILE, before);
    workspace.textDocuments = [{ uri: { fsPath: FILE }, isDirty: true, getText: () => "灯と\n" }];
    const result = await convertTextFileToUtf8(FILE, decodeBytes(before).hash, { bom: false });
    expect(result).toEqual({ ok: false, reason: "unsaved_changes" });
    expect(disk.get(FILE)).toEqual(before);
  });

  test("競合の印が残っていれば書かない", async () => {
    const before = sjis("<<<<<<< HEAD\n灯\n=======\n澪\n>>>>>>> b\n");
    disk.set(FILE, before);
    const result = await convertTextFileToUtf8(FILE, decodeBytes(before).hash, { bom: false });
    expect(result).toEqual({ ok: false, reason: "conflict_markers" });
    expect(disk.get(FILE)).toEqual(before);
  });

  test("編集部が校閲中の話は書かない（本文の書き込みの関所を通る）", async () => {
    const before = sjis("灯\n");
    disk.set(FILE, before);
    setBodyWriteGuard(async () => "校閲中です");
    const result = await convertTextFileToUtf8(FILE, decodeBytes(before).hash, { bom: false });
    expect(result).toEqual({ ok: false, reason: "editor_locked", detail: "校閲中です" });
    expect(disk.get(FILE)).toEqual(before);
  });

  test("Shift_JIS として読めないバイトがある話・すでに UTF-8 の話は書かない", async () => {
    const broken = new Uint8Array([...sjis("灯"), 0xa0, 0x0a]);
    disk.set(FILE, broken);
    const result = await convertTextFileToUtf8(FILE, decodeBytes(broken).hash, { bom: false });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("encoding_error");
    expect(disk.get(FILE)).toEqual(broken);

    const already = utf8("灯\n");
    disk.set(FILE, already);
    const again = await convertTextFileToUtf8(FILE, decodeBytes(already).hash, { bom: false });
    expect(again.ok).toBe(false);
    expect(disk.get(FILE)).toEqual(already);
    expect(recoveryCopies()).toEqual([]);
  });
});
