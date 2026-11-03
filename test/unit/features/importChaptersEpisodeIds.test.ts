import * as path from "path";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { EpisodeFile, WorkEntry } from "../../../src/models/types";
import { env, Uri, window, workspace } from "../support/vscodeStub";
import { memoryFs } from "../support/memoryDisk";

/**
 * ヘルパーの章立て（`novelai-chapters`）の行の話の番号を、投稿の記録へ写す（設計書6.68.8）。
 *
 * 取りこぼしを埋めるのは、**章立てが前と同じ・章の見出しが無い**など、章立ての取り込みが
 * 何もせずに終わる回である。その回でも番号は入る。別の番号がある話は訊いてから替え、
 * 投稿の記録の無い話には付けない。原稿は1バイトも変わらない。
 */

const scanned: EpisodeFile[] = [];
vi.mock("../../../src/core/scanner", () => ({
  scanWork: async () => ({
    episodes: scanned,
    stats: {},
    manuscriptDir: "",
    workInfoFiles: [],
    timing: {},
  }),
}));
vi.mock("../../../src/core/workFormatStore", () => ({
  readWorkFormat: async () => undefined,
}));

const { importChaptersFromHelper } = await import("../../../src/features/importChaptersFromBackup");

const work: WorkEntry = {
  id: "work_chapter_ids",
  title: "架空の灯台守",
  folderPath: path.join("C:", "novels", "chapterIds"),
  registeredAt: "2026-11-03T00:00:00.000Z",
};
const ledgerPath = Uri.file(path.join(work.folderPath, "設定", "投稿状態.json")).fsPath;
const disk = new Map<string, Uint8Array>();
const informed: string[] = [];
const warned: string[] = [];
let warningAnswer: string | undefined;
const changed: string[] = [];

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function episodeFile(fileName: string, n: number, subtitle: string): EpisodeFile {
  const filePath = path.join(work.folderPath, "本文", fileName);
  disk.set(Uri.file(filePath).fsPath, utf8(`${subtitle}の本文。`));
  return {
    filePath,
    fileName,
    ext: ".txt",
    chapterStart: n,
    chapterEnd: n,
    subtitle,
    kind: "本編",
    isInitialName: false,
    counts: { gross: 0, net: 0, lines: 0, paragraphs: 0, manuscriptLines: 0 },
    hasMetadata: false,
    metaTitle: null,
    declaredCharCount: null,
    metaUpdatedAt: null,
    hasConflictMarkers: false,
    collectedCount: null,
  };
}

function readPosts(): Array<Record<string, unknown>> {
  const bytes = disk.get(ledgerPath);
  if (!bytes) throw new Error("台帳が書かれていません");
  return (JSON.parse(new TextDecoder().decode(bytes)) as { posts: Array<Record<string, unknown>> }).posts;
}

function chaptersEnvelope(): string {
  return JSON.stringify({
    "novelai-chapters": 1,
    site: "kakuyomu",
    workId: "16816927859",
    readAt: "2026-11-03T09:00:00.000+09:00",
    // 章の見出しが無い作品（章立ての取り込みは「見出しが見つからない」で何もしない）
    episodes: [
      { heading: "１話　潮の匂い", part: null, episodeId: "101" },
      { heading: "２話　古い地図", part: null, episodeId: "102" },
      { heading: "３話　嵐の夜", part: null, episodeId: "103" },
    ],
  });
}

const deps = {
  listWorks: () => [work],
  afterChange: (entry: WorkEntry) => {
    changed.push(entry.id);
  },
};

beforeEach(() => {
  disk.clear();
  scanned.length = 0;
  informed.length = 0;
  warned.length = 0;
  changed.length = 0;
  warningAnswer = undefined;
  workspace.textDocuments = [];
  workspace.fs = memoryFs(disk);
  Object.assign(window, {
    showInformationMessage: async (message: string) => {
      informed.push(message);
      return undefined;
    },
    showWarningMessage: async (message: string) => {
      warned.push(message);
      return warningAnswer;
    },
    showErrorMessage: async () => undefined,
  });
  scanned.push(
    episodeFile("001_潮の匂い.txt", 1, "潮の匂い"),
    episodeFile("002_古い地図.txt", 2, "古い地図"),
    episodeFile("003_嵐の夜.txt", 3, "嵐の夜")
  );
  disk.set(
    ledgerPath,
    utf8(
      JSON.stringify({
        schemaVersion: "1",
        sites: [{ site: "kakuyomu", newEpisodeUrl: "https://kakuyomu.jp/my/works/16816927859/episodes/new" }],
        siteProfiles: [{ site: "kakuyomu", workId: "16816927859" }],
        posts: [
          { episodePath: "本文/001_潮の匂い.txt", site: "kakuyomu", postedAt: "2026-11-01T00:00:00.000Z" },
          {
            episodePath: "本文/002_古い地図.txt",
            site: "kakuyomu",
            postedAt: "2026-11-02T00:00:00.000Z",
            siteEpisodeId: "999",
          },
        ],
        rankings: [],
      })
    )
  );
  env.clipboard.text = chaptersEnvelope();
});

describe("章立ての話の番号", () => {
  test("章立てが何もしない回でも、番号の無い話へ入れる。別の番号は訊いて、答えなければ替えない", async () => {
    const manuscripts = [...disk].filter(([key]) => key !== ledgerPath);

    await importChaptersFromHelper(deps);

    const posts = readPosts();
    expect(posts.find((p) => p.episodePath === "本文/001_潮の匂い.txt")?.siteEpisodeId).toBe("101");
    expect(posts.find((p) => p.episodePath === "本文/002_古い地図.txt")?.siteEpisodeId).toBe("999");
    // 投稿の記録が無い3話には付けない（記録を作らない）
    expect(posts).toHaveLength(2);
    expect(warned.some((message) => message.includes("別の話の番号"))).toBe(true);
    expect(informed.some((message) => message.includes("投稿の記録が無い1話"))).toBe(true);
    expect(changed).toEqual([work.id]);
    for (const [key, bytes] of manuscripts) expect(disk.get(key)).toBe(bytes);
  });

  test("「替える」と答えれば替える", async () => {
    warningAnswer = "届いた番号に替える";
    await importChaptersFromHelper(deps);
    expect(readPosts().find((p) => p.episodePath === "本文/002_古い地図.txt")?.siteEpisodeId).toBe("102");
  });

  test("全部記録済みなら台帳は1バイトも変わらない", async () => {
    await importChaptersFromHelper(deps);
    const before = disk.get(ledgerPath);
    await importChaptersFromHelper(deps);
    expect(disk.get(ledgerPath)).toBe(before);
  });
});
