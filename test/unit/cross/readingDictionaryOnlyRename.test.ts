import * as path from "path";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { FileType, Uri, window, workspace } from "../support/vscodeStub";
import { memoryFs } from "../support/memoryDisk";
import type { WorkEntry } from "../../../src/models/types";
import { RenameDriftChecker } from "../../../src/features/episodeRenameWatch";
import { PostingStore } from "../../../src/core/postingStore";
import {
  loadReadingDictionary,
  readingDictionaryExists,
  saveReadingDictionary,
} from "../../../src/core/readingDictionaryStore";

const logged = vi.hoisted(() => [] as string[]);
vi.mock("../../../src/core/logger", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../../src/core/logger")>();
  return {
    ...original,
    logLine: (message: string) => void logged.push(message),
    logFailure: (context: string, detail: Record<string, unknown>) =>
      void logged.push(`${context} ${JSON.stringify(detail)}`),
  };
});

/**
 * 読みの辞書しか無い話を、OS・git pull で改名したとき（設計書6.68.2。作者の答え 2026-11-05）。
 *
 * 4つの台帳に載っていない話は、開いたときの確かめの対象外で、辞書が古い名前のまま残った。
 * 作者の答えは「黙って付け替える」——問いは増やさず、作品のログに件数を残す。
 * 4つの台帳にも載っている話は、今までどおり問いに入れ、答えに辞書が従う。
 */

const work: WorkEntry = {
  id: "work_test",
  title: "氷の街",
  folderPath: path.join("C:", "novels", "work"),
  registeredAt: "2026-09-03T00:00:00.000Z",
};

function diskPath(...parts: string[]): string {
  return Uri.file(path.join(work.folderPath, ...parts)).fsPath;
}

const encoder = new TextEncoder();
const memento = { get: <T>(_key: string, fallback: T) => fallback, update: async () => undefined };

async function seedDictionary(fileName: string, reading: string): Promise<void> {
  const episodePath = diskPath("本文", fileName);
  const loaded = await loadReadingDictionary(work, episodePath);
  await saveReadingDictionary(
    work,
    episodePath,
    { ...loaded.file, entries: [{ word: "十分", quote: "十分に", reading, source: "author" }] },
    loaded.hash
  );
}

async function readingOf(fileName: string): Promise<string | undefined> {
  const dict = await loadReadingDictionary(work, diskPath("本文", fileName));
  return dict.file.entries[0]?.reading;
}

describe("読みの辞書だけの話を外で改名したとき", () => {
  const disk = new Map<string, Uint8Array>();
  let asked = 0;

  beforeEach(() => {
    disk.clear();
    logged.length = 0;
    asked = 0;
    workspace.textDocuments = [];
    workspace.fs = memoryFs(disk, {
      methods: ["createDirectory", "readFile", "writeFile", "rename", "delete", "stat", "readDirectory"],
      folderStat: { type: FileType.Directory, ctime: 0, mtime: 0, size: 0 },
      readDirectory: "nested",
    });
    window.showInformationMessage = (async () => {
      asked++;
      return "付け替える";
    }) as typeof window.showInformationMessage;
  });

  function checker(current: string[]): RenameDriftChecker {
    return new RenameDriftChecker({
      memento,
      listEpisodePaths: async () => current.map((name) => diskPath("本文", name)),
    });
  }

  test("訊かずに新しい名前へ付け替え、件数をログに残す", async () => {
    await seedDictionary("003.txt", "じっぷん");
    disk.set(diskPath("本文", "003_湖畔の誓い.txt"), encoder.encode("本文です。"));

    await checker(["003_湖畔の誓い.txt"]).checkOnOpen(work);

    expect(asked).toBe(0);
    expect(await readingOf("003_湖畔の誓い.txt")).toBe("じっぷん");
    expect((await loadReadingDictionary(work, diskPath("本文", "003_湖畔の誓い.txt"))).file.episode).toBe(
      "本文/003_湖畔の誓い.txt"
    );
    expect(await readingDictionaryExists(work, diskPath("本文", "003.txt"))).toBe(false);
    expect(logged).toContain("読みの辞書1件を新しい名前へ付け替えました");
  });

  test("候補が2つに分かれるときは動かさない", async () => {
    await seedDictionary("003.txt", "じっぷん");
    disk.set(diskPath("本文", "003_a.txt"), encoder.encode("本文です。"));
    disk.set(diskPath("本文", "003_b.txt"), encoder.encode("本文です。"));

    await checker(["003_a.txt", "003_b.txt"]).checkOnOpen(work);

    expect(asked).toBe(0);
    expect(await readingDictionaryExists(work, diskPath("本文", "003.txt"))).toBe(true);
    expect(await readingDictionaryExists(work, diskPath("本文", "003_a.txt"))).toBe(false);
    expect(logged).toHaveLength(0);
  });

  test("新しい名前の話に別の辞書が既にあれば、候補にならず、どちらにも触れない", async () => {
    await seedDictionary("003.txt", "じっぷん");
    disk.set(diskPath("本文", "003_湖畔の誓い.txt"), encoder.encode("本文です。"));
    await seedDictionary("003_湖畔の誓い.txt", "こはん");

    await checker(["003_湖畔の誓い.txt"]).checkOnOpen(work);

    expect(await readingOf("003.txt")).toBe("じっぷん");
    expect(await readingOf("003_湖畔の誓い.txt")).toBe("こはん");
    expect(logged).not.toContain("読みの辞書1件を新しい名前へ付け替えました");
  });

  test("話数の無い名前は候補を探さない", async () => {
    await seedDictionary("幕間.txt", "じっぷん");
    disk.set(diskPath("本文", "幕間 湖畔.txt"), encoder.encode("本文です。"));

    await checker(["幕間 湖畔.txt"]).checkOnOpen(work);

    expect(await readingDictionaryExists(work, diskPath("本文", "幕間.txt"))).toBe(true);
    expect(logged).toHaveLength(0);
  });

  describe("4つの台帳にも載っている話", () => {
    async function seedPosting(): Promise<void> {
      await seedDictionary("003.txt", "じっぷん");
      const posting = new PostingStore(work);
      await posting.save({
        ...(await posting.load()),
        posts: [{ episodePath: "本文/003.txt", site: "kakuyomu", postedAt: "2026-11-01T00:00:00.000Z" }],
      });
      disk.set(diskPath("本文", "003_湖畔の誓い.txt"), encoder.encode("本文です。"));
    }

    test("問いに入り、［付け替えない］なら辞書も動かさない", async () => {
      await seedPosting();
      window.showInformationMessage = (async () => {
        asked++;
        return "付け替えない";
      }) as typeof window.showInformationMessage;

      await checker(["003_湖畔の誓い.txt"]).checkOnOpen(work);

      expect(asked).toBe(1);
      expect(await readingDictionaryExists(work, diskPath("本文", "003.txt"))).toBe(true);
      expect(await readingDictionaryExists(work, diskPath("本文", "003_湖畔の誓い.txt"))).toBe(false);
    });

    test("問いに入り、［付け替える］なら辞書も移る（黙っての付け替えとは別に数えない）", async () => {
      await seedPosting();

      await checker(["003_湖畔の誓い.txt"]).checkOnOpen(work);

      expect(asked).toBe(1);
      expect(await readingOf("003_湖畔の誓い.txt")).toBe("じっぷん");
      expect(logged).not.toContain("読みの辞書1件を新しい名前へ付け替えました");
    });
  });
});
