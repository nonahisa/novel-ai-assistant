import * as path from "path";
import { beforeEach, describe, expect, test } from "vitest";
import {
  PHOTO_REQUEST_MAX_CHARS,
  formatPhotoRequestFile,
} from "../../../src/core/photoTranscribeRequest";
import {
  readPhotoRequest,
  savePhotoRequest,
} from "../../../src/core/photoTranscribeRequestStore";
import { IGNORED_PATHS } from "../../../src/core/workRegistry";
import type { WorkEntry } from "../../../src/models/types";
import { FileSystemError, Uri, workspace } from "../support/vscodeStub";

/**
 * 写真の書き起こしの「AIへの頼み」の置き場（設計書6.117.7。作者の裁定、2026-10-12 夜）。
 *
 * 置き場は作品フォルダーの `.aiwriter/photo-transcribe-request.json`。
 * **作者の文を消さない**のが一番の約束——壊れたファイル・競合の印の入ったファイル・
 * 同期で書き換わったファイルは、上書きしない。
 */

function workAt(id: string, folder: string): WorkEntry {
  return {
    id,
    title: id,
    folderPath: path.join("C:", "novels", folder),
    registeredAt: "2026-10-12T00:00:00.000Z",
  };
}

const workA = workAt("work_a", "a");
const workB = workAt("work_b", "b");

function fileOf(work: WorkEntry): string {
  return Uri.file(path.join(work.folderPath, ".aiwriter", "photo-transcribe-request.json")).fsPath;
}

describe("頼みの置き場（作品フォルダーのファイル）", () => {
  const disk = new Map<string, Uint8Array>();
  const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
  const onDisk = (work: WorkEntry): string | undefined => {
    const bytes = disk.get(fileOf(work));
    return bytes ? new TextDecoder().decode(bytes) : undefined;
  };

  beforeEach(() => {
    disk.clear();
    workspace.fs = {
      createDirectory: async () => undefined,
      readFile: async (uri: { fsPath: string }) => {
        const bytes = disk.get(uri.fsPath);
        if (!bytes) throw new FileSystemError("missing", "FileNotFound");
        return bytes;
      },
      writeFile: async (uri: { fsPath: string }, bytes: Uint8Array) => {
        disk.set(uri.fsPath, bytes);
      },
      rename: async (from: { fsPath: string }, to: { fsPath: string }) => {
        const bytes = disk.get(from.fsPath);
        if (!bytes) throw new FileSystemError("missing", "FileNotFound");
        disk.set(to.fsPath, bytes);
        disk.delete(from.fsPath);
      },
      delete: async (uri: { fsPath: string }) => {
        if (!disk.has(uri.fsPath)) throw new FileSystemError("missing", "FileNotFound");
        disk.delete(uri.fsPath);
      },
    } as unknown as typeof workspace.fs;
  });

  test("同期から外していない（2台で同じ頼みを使う。作者の裁定、2026-10-12 夜）", () => {
    const rel = ".aiwriter/photo-transcribe-request.json";
    expect(IGNORED_PATHS.some((rule) => rel === rule || rel.startsWith(rule))).toBe(false);
    // `.aiwriter/` ごと外していないことも見る（外していれば上の判定も意味がない）
    expect(IGNORED_PATHS).not.toContain(".aiwriter/");
  });

  test("ファイルが無ければ空の頼み", async () => {
    expect(await readPhotoRequest(workA)).toEqual({ ok: true, text: "" });
  });

  test("覚えた頼みは作品フォルダーのファイルに入り、読み戻せる（改行もそのまま）", async () => {
    const text = "旧字体はそのまま。\nルビの小さい字は（）に入れる。";
    expect(await savePhotoRequest(workA, "", text)).toEqual({ ok: true, text });
    expect(onDisk(workA)).toBe(formatPhotoRequestFile(text));
    expect(await readPhotoRequest(workA)).toEqual({ ok: true, text });
  });

  test("作品ごとに分かれる（ほかの作品へ漏れない）", async () => {
    await savePhotoRequest(workA, "", "Aの頼み");
    await savePhotoRequest(workB, "", "Bの頼み");
    expect(await readPhotoRequest(workA)).toEqual({ ok: true, text: "Aの頼み" });
    expect(await readPhotoRequest(workB)).toEqual({ ok: true, text: "Bの頼み" });
  });

  test("空にしたらファイルを消す。もともと無ければそのまま", async () => {
    await savePhotoRequest(workA, "", "頼み");
    expect(await savePhotoRequest(workA, "頼み", "  \n ")).toEqual({ ok: true, text: "" });
    expect(onDisk(workA)).toBeUndefined();
    expect(await savePhotoRequest(workA, "", "")).toEqual({ ok: true, text: "" });
    expect(await readPhotoRequest(workA)).toEqual({ ok: true, text: "" });
  });

  test("上限を超えた頼みは覚えない（前の頼みが残る）", async () => {
    await savePhotoRequest(workA, "", "前の頼み");
    const saved = await savePhotoRequest(workA, "前の頼み", "あ".repeat(PHOTO_REQUEST_MAX_CHARS + 1));
    expect(saved.ok).toBe(false);
    if (saved.ok) return;
    expect(saved.kind).toBe("over");
    expect(await readPhotoRequest(workA)).toEqual({ ok: true, text: "前の頼み" });
  });

  test("ちょうど上限までは覚える", async () => {
    const text = "あ".repeat(PHOTO_REQUEST_MAX_CHARS);
    expect((await savePhotoRequest(workA, "", text)).ok).toBe(true);
  });

  test("壊れた JSON は読めないと言い、上書きもしない", async () => {
    const broken = '{ "request": "作者の頼み"';
    disk.set(fileOf(workA), encode(broken));
    const read = await readPhotoRequest(workA);
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.kind).toBe("broken");
    const saved = await savePhotoRequest(workA, "", "新しい頼み");
    expect(saved.ok).toBe(false);
    if (saved.ok) return;
    expect(saved.kind).toBe("broken");
    expect(onDisk(workA)).toBe(broken);
  });

  test("空にしようとしても、壊れたファイルは消さない", async () => {
    const broken = "{";
    disk.set(fileOf(workA), encode(broken));
    expect((await savePhotoRequest(workA, "", "")).ok).toBe(false);
    expect(onDisk(workA)).toBe(broken);
  });

  test("競合マーカーが入っていたら、理由を返して読まず、上書きもしない", async () => {
    const conflicted = [
      "<<<<<<< HEAD",
      '{ "version": 1, "request": "旧字体はそのまま" }',
      "=======",
      '{ "version": 1, "request": "ルビは（）に" }',
      ">>>>>>> origin/main",
      "",
    ].join("\n");
    disk.set(fileOf(workA), encode(conflicted));
    const read = await readPhotoRequest(workA);
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.kind).toBe("conflict");
    expect(read.reason).toContain("同期で2つの版が混ざった");
    const saved = await savePhotoRequest(workA, "旧字体はそのまま", "第三の頼み");
    expect(saved.ok).toBe(false);
    expect(onDisk(workA)).toBe(conflicted);
  });

  test("画面を開いたあとに別のパソコンの頼みが同期で届いていたら、古い画面の文で上書きしない", async () => {
    // この画面が開いたときは「旧字体はそのまま」だった
    await savePhotoRequest(workA, "", "旧字体はそのまま");
    // その後、別のパソコンで書き換えた頼みが同期で届いた
    disk.set(fileOf(workA), encode(formatPhotoRequestFile("ルビは（）に入れる")));
    const saved = await savePhotoRequest(workA, "旧字体はそのまま", "旧字体はそのまま。踊り字も");
    expect(saved.ok).toBe(false);
    if (saved.ok) return;
    expect(saved.kind).toBe("changed");
    expect(saved.reason).toContain("開き直すと");
    expect(await readPhotoRequest(workA)).toEqual({ ok: true, text: "ルビは（）に入れる" });
  });

  test("届いた頼みと同じ文なら、食い違いではないので通す（書き直さない）", async () => {
    disk.set(fileOf(workA), encode(formatPhotoRequestFile("ルビは（）に入れる")));
    expect(await savePhotoRequest(workA, "", "ルビは（）に入れる")).toEqual({
      ok: true,
      text: "ルビは（）に入れる",
    });
  });

  test("空になっていた（相手が消した）ところへ古い画面の文を書き戻さない", async () => {
    await savePhotoRequest(workA, "", "旧字体はそのまま");
    disk.delete(fileOf(workA));
    const saved = await savePhotoRequest(workA, "旧字体はそのまま", "旧字体はそのまま。踊り字も");
    expect(saved.ok).toBe(false);
    if (saved.ok) return;
    expect(saved.kind).toBe("changed");
    expect(onDisk(workA)).toBeUndefined();
  });
});
