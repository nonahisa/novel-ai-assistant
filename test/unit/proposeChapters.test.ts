import * as path from "path";
import { beforeEach, describe, expect, test } from "vitest";
import { FileSystemError, Uri, workspace } from "./support/vscodeStub";
import { ChapterStore } from "../../src/core/chapterStore";
import type { WorkEntry } from "../../src/models/types";
import {
  ChapterProposalApplier,
  describeChapterProposal,
} from "../../src/features/proposeChapters";

/**
 * 章立ての提案を承認したときの書き込み（設計書6.66.4）。
 *
 * **承認した1件だけが台帳へ入る。** AIが出した提案は、作者が押すまで
 * どこにも書かれない。書き込みは `ChapterStore` だけを通し、
 * **外で台帳が変わっていれば止まる**（ハッシュ照合）。
 */

const work: WorkEntry = {
  id: "work_test",
  title: "氷の街",
  folderPath: path.join("C:", "novels", "work"),
  registeredAt: "2026-09-04T00:00:00.000Z",
};

const chaptersPath = Uri.file(
  path.join(work.folderPath, "設定", "章立て.json")
).fsPath;

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

describe("提案の承認と台帳への書き込み", () => {
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

  function saved(): Array<{ name: string; startEpisodePath: string }> {
    const bytes = disk.get(chaptersPath);
    if (!bytes) return [];
    return (
      JSON.parse(new TextDecoder().decode(bytes)) as {
        chapters: Array<{ name: string; startEpisodePath: string }>;
      }
    ).chapters;
  }

  async function applierOf(): Promise<ChapterProposalApplier> {
    const store = new ChapterStore(work);
    return new ChapterProposalApplier(store, await store.load());
  }

  test("承認した1件だけが台帳に入る", async () => {
    const applier = await applierOf();

    expect(
      await applier.apply({
        name: "出立の章",
        startEpisodePath: "本文/001.txt",
      })
    ).toEqual({ ok: true });

    expect(saved()).toEqual([
      { name: "出立の章", startEpisodePath: "本文/001.txt" },
    ]);
  });

  test("続けて承認したものは足される（前の1件を消さない）", async () => {
    const applier = await applierOf();
    await applier.apply({ name: "出立の章", startEpisodePath: "本文/001.txt" });
    await applier.apply({ name: "王都の章", startEpisodePath: "本文/006.txt" });

    expect(saved().map((entry) => entry.name)).toEqual([
      "出立の章",
      "王都の章",
    ]);
  });

  test("既にその話から始まる章があれば、改名になる（二重に作らない）", async () => {
    disk.set(
      chaptersPath,
      utf8(
        JSON.stringify({
          schemaVersion: "1",
          chapters: [{ name: "第一章", startEpisodePath: "本文/001.txt" }],
        })
      )
    );

    const applier = await applierOf();
    expect(
      await applier.apply({
        name: "出立の章",
        startEpisodePath: "本文/001.txt",
      })
    ).toEqual({ ok: true });

    expect(saved()).toEqual([
      { name: "出立の章", startEpisodePath: "本文/001.txt" },
    ]);
  });

  test("台帳が外で変わっていたら、上書きせずに止める", async () => {
    disk.set(
      chaptersPath,
      utf8(
        JSON.stringify({
          schemaVersion: "1",
          chapters: [{ name: "第一章", startEpisodePath: "本文/001.txt" }],
        })
      )
    );
    const applier = await applierOf();

    // 提案を眺めているあいだに、別の端末（または作者の手編集）で変わった
    const outside = utf8(
      JSON.stringify({
        schemaVersion: "1",
        chapters: [{ name: "作者が手で書いた章", startEpisodePath: "本文/001.txt" }],
      })
    );
    disk.set(chaptersPath, outside);

    const result = await applier.apply({
      name: "出立の章",
      startEpisodePath: "本文/001.txt",
    });
    expect(result.ok).toBe(false);
    expect(result.reason ?? "").toContain("章");
    expect(disk.get(chaptersPath)).toEqual(outside);
  });

  test("外で変わって止まったあとは、読み直して次の承認から通る（D）", async () => {
    disk.set(
      chaptersPath,
      utf8(
        JSON.stringify({
          schemaVersion: "1",
          chapters: [{ name: "第一章", startEpisodePath: "本文/001.txt" }],
        })
      )
    );
    const applier = await applierOf();

    // 提案を眺めているあいだに、別の端末で章が1つ足された
    disk.set(
      chaptersPath,
      utf8(
        JSON.stringify({
          schemaVersion: "1",
          chapters: [
            { name: "第一章", startEpisodePath: "本文/001.txt" },
            { name: "別の端末で足した章", startEpisodePath: "本文/010.txt" },
          ],
        })
      )
    );

    const first = await applier.apply({
      name: "王都の章",
      startEpisodePath: "本文/006.txt",
    });
    expect(first.ok).toBe(false);
    // **読み直したことを伝える**（作者が「もう一度押せばよい」と分かる）
    expect(first.reason ?? "").toContain("もう一度");

    // **AIを呼び直させない。** 同じパネルの同じ提案が、次の承認で通る
    const second = await applier.apply({
      name: "王都の章",
      startEpisodePath: "本文/006.txt",
    });
    expect(second).toEqual({ ok: true });
    expect(saved().map((entry) => entry.name)).toEqual([
      "第一章",
      "別の端末で足した章",
      "王都の章",
    ]);
  });
});

describe("提案パネルに出す1件の文言", () => {
  test("どの話から始まるかと理由を並べる", () => {
    const lines = describeChapterProposal({
      label: "第6話",
      reason: "舞台が王都へ移る",
    });
    expect(lines[0]).toContain("第6話");
    expect(lines.join("\n")).toContain("舞台が王都へ移る");
  });

  test("既にある章と同じ開始話なら、改名だと伝える", () => {
    const lines = describeChapterProposal({
      label: "第1話",
      reason: "",
      existingName: "第一章",
    });
    expect(lines.join("\n")).toContain("第一章");
    expect(lines.join("\n")).toContain("名前");
  });

  test("理由が空なら、その行を出さない（空の行を並べない）", () => {
    const lines = describeChapterProposal({ label: "第1話", reason: "" });
    expect(lines).toHaveLength(1);
  });
});
