import * as nodePath from "path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { FileSystemError, workspace } from "../support/vscodeStub";
import { installFakeDisk, openFakeDocument, type FakeDisk } from "../support/openDocumentFake";
import { applyChatEdit } from "../../../src/features/applyChatEdit";
import { applyRenameToRecords, type PendingRename } from "../../../src/features/nameRename";
import { buildRenameMapping } from "../../../src/core/nameRename";
import type { WorkEntry } from "../../../src/models/types";

/**
 * synopsis.md（作品紹介文・キャッチコピー・各話あらすじの読み物）を書く口も、plot.md と同じ口
 * （`rewriteMarkdownFile` → `writeTextFilePreferringOpenDocument`）を通る。
 *
 * それまでは相談パネル（`applyChatEdit.ts`）も名前の付け替え（`nameRename.ts`）も、
 * **読み込み時のハッシュを照合せず、未保存の変更も確かめずに**「退避 → 消して作り直す」で書いていた。
 * 開いたまま書きかけていれば、その分を巻き込むか、Ctrl+S が「ファイルのほうが新しい」で断られる。
 */

const work: WorkEntry = {
  id: "work_synopsis_open",
  title: "氷の街",
  folderPath: nodePath.join("C:", "novels", "work_synopsis_open"),
  registeredAt: "2026-10-16T00:00:00.000Z",
};
const synopsisFile = nodePath.join(work.folderPath, "設定", "synopsis.md");

let disk: FakeDisk;

beforeEach(() => {
  disk = installFakeDisk();
  // 人物・資料の台帳は置かない（名前の付け替えは synopsis.md だけを見る）
  (workspace.fs as unknown as { readDirectory: () => Promise<never> }).readDirectory =
    async () => {
      throw new FileSystemError("missing", "FileNotFound");
    };
  workspace.textDocuments.length = 0;
});

afterEach(() => {
  workspace.textDocuments.length = 0;
  workspace.applyEdit = async () => true;
});

describe("相談パネルの紹介文の書き込み（applyChatEdit）", () => {
  const initial = "# 氷の街\n\n古い紹介文\n";

  test("開いていれば、ディスクを消して作り直さず、文書へ当てて保存する", async () => {
    disk.write(synopsisFile, initial);
    const document = openFakeDocument(disk, synopsisFile, initial);

    await applyChatEdit(work, {
      target: { kind: "blurb" },
      content: "新しい紹介文",
      label: "紹介文を変える",
    });

    expect(disk.deleted).toEqual([]);
    expect(document.applied.join("")).not.toContain("# 氷の街");
    expect(document.save).toHaveBeenCalledTimes(1);
    expect(disk.read(synopsisFile)).toContain("新しい紹介文");
  });

  test("未保存の変更があれば書かずに止める", async () => {
    disk.write(synopsisFile, initial);
    const document = openFakeDocument(disk, synopsisFile, initial + "書きかけ", { dirty: true });

    await expect(
      applyChatEdit(work, {
        target: { kind: "blurb" },
        content: "新しい紹介文",
        label: "紹介文を変える",
      })
    ).rejects.toThrow(/保存していない/);
    expect(document.applied).toEqual([]);
    expect(disk.read(synopsisFile)).toBe(initial);
  });

  test("開いていなければ、改行を保ってディスクへ書く", async () => {
    disk.write(synopsisFile, initial.replace(/\n/g, "\r\n"));

    await applyChatEdit(work, {
      target: { kind: "blurb" },
      content: "新しい紹介文",
      label: "紹介文を変える",
    });

    const after = disk.read(synopsisFile) ?? "";
    expect(after).toContain("新しい紹介文");
    expect(after.replace(/\r\n/g, "")).not.toContain("\n");
  });

  test("無ければ作る", async () => {
    await applyChatEdit(work, {
      target: { kind: "catchphrase" },
      content: "氷の下で",
      label: "キャッチコピーを足す",
    });

    expect(disk.read(synopsisFile)).toContain("氷の下で");
  });
});

describe("名前の付け替えの synopsis.md（applyRenameToRecords）", () => {
  const OLD = "真田幸村";
  const NEW = "源義経";
  const initial = `# 氷の街\n\n${OLD}が城を守る。\n`;
  const pending: PendingRename = {
    characterId: "char_001",
    oldName: OLD,
    newName: NEW,
    newReading: null,
    mapping: buildRenameMapping({ name: OLD }, NEW, null),
    createdAt: "2026-10-16T00:00:00.000Z",
  };

  test("開いていれば、文書へ当てて保存する", async () => {
    disk.write(synopsisFile, initial);
    const document = openFakeDocument(disk, synopsisFile, initial);

    const result = await applyRenameToRecords(work, pending);

    expect(result.synopsisDocUpdated).toBe(true);
    expect(disk.deleted).not.toContain(synopsisFile);
    expect(document.save).toHaveBeenCalledTimes(1);
    expect(disk.read(synopsisFile)).toBe(`# 氷の街\n\n${NEW}が城を守る。\n`);
  });

  test("未保存の変更があれば書かずに、失敗として返す", async () => {
    disk.write(synopsisFile, initial);
    const document = openFakeDocument(disk, synopsisFile, initial + "書きかけ", { dirty: true });

    const result = await applyRenameToRecords(work, pending);

    expect(result.synopsisDocUpdated).toBe(false);
    expect(result.failures.join("\n")).toMatch(/synopsis\.md.*保存していない/);
    expect(document.applied).toEqual([]);
    expect(disk.read(synopsisFile)).toBe(initial);
  });

  test("無ければ作らない", async () => {
    const result = await applyRenameToRecords(work, pending);

    expect(result.synopsisDocUpdated).toBe(false);
    expect(disk.read(synopsisFile)).toBeUndefined();
  });
});
