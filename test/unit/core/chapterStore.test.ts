import * as path from "path";
import { beforeEach, describe, expect, test } from "vitest";
import { ChapterStore, ChapterStoreError } from "../../src/core/chapterStore";
import { emptyChapterSet } from "../../src/models/chapter";
import type { WorkEntry } from "../../src/models/types";
import { FileSystemError, Uri, workspace } from "./support/vscodeStub";

/**
 * 章の台帳の保存（設計書6.66.1）。
 *
 * `設定/章立て.json` は**作者が手で開いて直すJSON**であり、別の端末から
 * 同期でも降ってくる。開いたまま外で直されたら、**上書きせずに止める**
 * ——人物・設定資料・本の設計図と同じ約束をここでも守る。
 */

const work: WorkEntry = {
  id: "work_test",
  title: "氷の街",
  folderPath: path.join("C:", "novels", "work"),
  registeredAt: "2026-09-03T00:00:00.000Z",
};

const chaptersPath = diskPath(
  path.join(work.folderPath, "設定", "章立て.json")
);

function diskPath(filePath: string): string {
  return Uri.file(filePath).fsPath;
}

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

describe("章の台帳の読み書き", () => {
  const disk = new Map<string, Uint8Array>();

  beforeEach(() => {
    disk.clear();
    workspace.textDocuments = [];
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
      rename: async (
        from: { fsPath: string },
        to: { fsPath: string },
        options?: { overwrite?: boolean }
      ) => {
        const bytes = disk.get(from.fsPath);
        if (!bytes) throw new FileSystemError("missing", "FileNotFound");
        if (!options?.overwrite && disk.has(to.fsPath)) {
          throw new FileSystemError("exists", "FileExists");
        }
        disk.set(to.fsPath, bytes);
        disk.delete(from.fsPath);
      },
      delete: async (uri: { fsPath: string }) => {
        disk.delete(uri.fsPath);
      },
      stat: async (uri: { fsPath: string }) => {
        if (!disk.has(uri.fsPath)) {
          throw new FileSystemError("missing", "FileNotFound");
        }
        return { type: 1, ctime: 0, mtime: 0, size: 0 };
      },
    } as unknown as typeof workspace.fs;
  });

  function written(): { chapters: Array<Record<string, string>> } {
    const bytes = disk.get(chaptersPath);
    if (!bytes) throw new Error("章立て.json が書かれていません");
    return JSON.parse(new TextDecoder().decode(bytes)) as {
      chapters: Array<Record<string, string>>;
    };
  }

  test("まだ無ければ、章が1つも無い台帳として読める", async () => {
    const store = new ChapterStore(work);
    expect(await store.load()).toEqual(emptyChapterSet());
  });

  test("自分で保存したものは、続けて保存できる", async () => {
    const store = new ChapterStore(work);
    const set = await store.load();

    await store.save({
      ...set,
      chapters: [{ name: "第一章", startEpisodePath: "本文/001.txt" }],
    });
    expect(written().chapters).toHaveLength(1);

    // 保存で覚え直しているので、2度目も通る
    await store.save({
      ...set,
      chapters: [
        { name: "第一章", startEpisodePath: "本文/001.txt" },
        { name: "第二章", startEpisodePath: "本文/006.txt" },
      ],
    });
    expect(written().chapters).toHaveLength(2);
  });

  test("読み込んだあとに外で変わっていたら、上書きせずに止める", async () => {
    disk.set(
      chaptersPath,
      utf8(
        JSON.stringify({
          chapters: [{ name: "第一章", startEpisodePath: "本文/001.txt" }],
        })
      )
    );
    const store = new ChapterStore(work);
    const set = await store.load();

    const outside = utf8(
      JSON.stringify({
        chapters: [{ name: "作者が手で書いた章", startEpisodePath: "本文/001.txt" }],
      })
    );
    disk.set(chaptersPath, outside);

    await expect(
      store.save({
        ...set,
        chapters: [{ name: "画面から", startEpisodePath: "本文/001.txt" }],
      })
    ).rejects.toMatchObject({ kind: "modified_externally" });
    expect(disk.get(chaptersPath)).toEqual(outside);
  });

  test("読み込みのときに無かったファイルが、外で作られていたら止める", async () => {
    const store = new ChapterStore(work);
    const set = await store.load();

    const outside = utf8(JSON.stringify({ chapters: [] }));
    disk.set(chaptersPath, outside);

    await expect(store.save(set)).rejects.toMatchObject({
      kind: "modified_externally",
    });
    expect(disk.get(chaptersPath)).toEqual(outside);
  });

  test("壊れたJSONは修復しない（読めないと言って止まる）", async () => {
    disk.set(chaptersPath, utf8("{ chapters: 壊れている"));
    const store = new ChapterStore(work);

    await expect(store.load()).rejects.toMatchObject({ kind: "invalid_json" });
    // 読めていないので、保存もさせない（作者の書いたものを消さない）
    await expect(store.save(emptyChapterSet())).rejects.toBeInstanceOf(
      ChapterStoreError
    );
    expect(new TextDecoder().decode(disk.get(chaptersPath))).toBe(
      "{ chapters: 壊れている"
    );
  });

  test("形は合っていても値が不正なら止める", async () => {
    disk.set(
      chaptersPath,
      utf8(JSON.stringify({ chapters: [{ name: "", startEpisodePath: "a" }] }))
    );

    await expect(new ChapterStore(work).load()).rejects.toMatchObject({
      kind: "invalid_json",
    });
  });

  test("同じ話から始まる章は保存させない", async () => {
    const store = new ChapterStore(work);
    const set = await store.load();

    await expect(
      store.save({
        ...set,
        chapters: [
          { name: "第一章", startEpisodePath: "本文/001.txt" },
          { name: "序の章", startEpisodePath: "本文/001.txt" },
        ],
      })
    ).rejects.toMatchObject({ kind: "duplicate_start" });
    expect(disk.has(chaptersPath)).toBe(false);
  });

  test("エディタに未保存の変更があれば書き込まない", async () => {
    const store = new ChapterStore(work);
    const set = await store.load();
    workspace.textDocuments = [
      {
        uri: { fsPath: chaptersPath },
        isDirty: true,
        getText: () => "",
      },
    ];

    await expect(
      store.save({
        ...set,
        chapters: [{ name: "第一章", startEpisodePath: "本文/001.txt" }],
      })
    ).rejects.toMatchObject({ kind: "unsaved_changes" });
    expect(disk.has(chaptersPath)).toBe(false);
  });

  test("読み込む前には保存しない", async () => {
    const store = new ChapterStore(work);
    await expect(store.save(emptyChapterSet())).rejects.toBeInstanceOf(
      ChapterStoreError
    );
    expect(disk.has(chaptersPath)).toBe(false);
  });

  test("保存したJSONは、そのまま読み直せる", async () => {
    const store = new ChapterStore(work);
    const set = await store.load();
    await store.save({
      ...set,
      chapters: [{ name: "第一章　出立", startEpisodePath: "本文/001.txt" }],
    });

    const reopened = await new ChapterStore(work).load();
    expect(reopened.chapters).toEqual([
      { name: "第一章　出立", startEpisodePath: "本文/001.txt" },
    ]);
  });
});
