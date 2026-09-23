import * as path from "path";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { OutlineEpisode } from "../../../src/core/chapterOutline";
import type { EpisodeFile, WorkEntry } from "../../../src/models/types";
import { FileSystemError, Uri, window, workspace } from "../support/vscodeStub";
import { isConfirmPick, readConfirm } from "../support/confirmPicker";

/**
 * 既にある作品へ、バックアップの章立てだけを取り込む（残課題 B7。設計書6.66.6）。
 *
 * 確かめること：
 * - 章立てが空なら、確認のあと章だけが入る（**原稿のファイルは1バイトも変わらない**）
 * - 章立てが既にあれば**上書きしない**。押さなければ1文字も変えず、「足りない章だけ足す」
 *   では作者の章が名前ごと残る
 * - 話が合わなければ、台帳を作らずに止まる
 * - 新しく取り込んだ作品：合本のままなら立てず、分けたあとの形なら立てる
 *
 * 材料は作り物（題は架空）。
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

const { applyChapterOutline, placeImportedChapters } = await import(
  "../../../src/features/importChaptersFromBackup"
);

const SEP = (n: number) =>
  `------------------------- エピソード${n}開始 -------------------------`;

/** なろうの合本を分けた1話ぶん（区切り行が残る）。章の最初の話にだけ見出しが付く */
function episodeText(n: number, title: string, part?: [number, string]): string {
  return [
    SEP(n),
    ...(part ? [`【第${part[0]}章】`, part[1], ""] : []),
    "【エピソードタイトル】",
    `${n}話　${title}`,
    "",
    "【本文】",
    `${title}の本文。`,
    "",
  ].join("\r\n");
}

const TITLES = ["潮の匂い", "古い地図", "嵐の夜", "迷い船"];

/** バックアップの並び：1話と3話が章の始まり */
function outline(): OutlineEpisode[] {
  return TITLES.map((title, index) => ({
    label: `${index + 1}話　${title}`,
    number: index + 1,
    title,
    part: index < 2 ? "第一章『岬』" : "第二章『灯』",
  }));
}

const WORK_FOLDER = path.join("C:", "novels", "lighthouse");
const work: WorkEntry = {
  id: "work_lighthouse",
  title: "架空の灯台守",
  folderPath: WORK_FOLDER,
  registeredAt: "2026-09-24T00:00:00.000Z",
};

const disk = new Map<string, Uint8Array>();
const diskPath = (filePath: string) => Uri.file(filePath).fsPath;
const chaptersPath = diskPath(path.join(WORK_FOLDER, "設定", "章立て.json"));

function episodeFile(fileName: string, n: number | null, text: string): EpisodeFile {
  const filePath = path.join(WORK_FOLDER, fileName);
  disk.set(diskPath(filePath), new TextEncoder().encode(text));
  return {
    filePath,
    fileName,
    ext: ".txt",
    chapterStart: n,
    chapterEnd: n,
    subtitle: null,
    kind: "本編",
    isInitialName: false,
    counts: { net: 0, gross: 0, lines: 0, paragraphs: 0, manuscriptLines: 0 },
    hasMetadata: false,
    metaTitle: null,
    declaredCharCount: null,
    metaUpdatedAt: null,
    hasConflictMarkers: false,
    collectedCount: null,
  };
}

function putSplitWork(): void {
  scanned.push(
    episodeFile("episode_0001.txt", 1, episodeText(1, TITLES[0], [1, "第一章『岬』"])),
    episodeFile("episode_0002.txt", 2, episodeText(2, TITLES[1])),
    episodeFile("episode_0003.txt", 3, episodeText(3, TITLES[2], [2, "第二章『灯』"])),
    episodeFile("episode_0004.txt", 4, episodeText(4, TITLES[3]))
  );
}

function ledger(): { chapters: Array<{ name: string; startEpisodePath: string }> } | null {
  const bytes = disk.get(chaptersPath);
  return bytes ? JSON.parse(new TextDecoder().decode(bytes)) : null;
}

function putLedger(chapters: Array<{ name: string; startEpisodePath: string }>): void {
  disk.set(
    chaptersPath,
    new TextEncoder().encode(JSON.stringify({ schemaVersion: "1", chapters }, null, 2))
  );
}

/** 原稿（章立て以外）の中身の控え */
function manuscripts(): Map<string, string> {
  const copy = new Map<string, string>();
  for (const [key, bytes] of disk) {
    if (key === chaptersPath) continue;
    copy.set(key, new TextDecoder().decode(bytes));
  }
  return copy;
}

describe("「バックアップから章立て」", () => {
  let confirmText = "";
  let confirmButtons: readonly string[] = [];
  let answer: string | undefined;
  let warnings: string[] = [];

  beforeEach(() => {
    disk.clear();
    scanned.length = 0;
    confirmText = "";
    confirmButtons = [];
    answer = undefined;
    warnings = [];
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
        if (!disk.has(uri.fsPath)) throw new FileSystemError("missing", "FileNotFound");
        return { type: 1, ctime: 0, mtime: 0, size: 0 };
      },
    } as unknown as typeof workspace.fs;

    window.showQuickPick = (async (items: unknown, options?: unknown) => {
      if (!isConfirmPick(items)) return undefined;
      const list = items as Array<{ label: string; kind?: number; button?: string }>;
      const shown = readConfirm(list, options as { title?: string });
      confirmText = shown.flat;
      confirmButtons = shown.buttons;
      return list.find((item) => item.button === answer);
    }) as typeof window.showQuickPick;
    window.showInformationMessage = (async () =>
      undefined) as typeof window.showInformationMessage;
    window.showWarningMessage = (async (message: string, ...rest: unknown[]) => {
      const options = rest[0] as { detail?: string } | undefined;
      warnings.push(`${message}${options?.detail ?? ""}`);
      return undefined;
    }) as typeof window.showWarningMessage;
    window.showErrorMessage = (async () => undefined) as typeof window.showErrorMessage;
  });

  test("章立てが空なら、確認のあと章だけが入る（原稿は1バイトも変わらない）", async () => {
    putSplitWork();
    const before = manuscripts();
    answer = "章を立てる";

    expect(await applyChapterOutline(work, outline(), "N0000ZZ.zip")).toBe(true);

    expect(ledger()?.chapters).toEqual([
      { name: "第一章『岬』", startEpisodePath: "episode_0001.txt" },
      { name: "第二章『灯』", startEpisodePath: "episode_0003.txt" },
    ]);
    expect(confirmText).toContain("章を2個立てます");
    expect(confirmText).toContain("第二章『灯』");
    expect(manuscripts()).toEqual(before);
  });

  test("**章立てが既にあれば、押さないかぎり1文字も変えない**", async () => {
    putSplitWork();
    putLedger([{ name: "序章（作者の名前）", startEpisodePath: "episode_0001.txt" }]);
    const before = disk.get(chaptersPath);
    answer = undefined;

    expect(await applyChapterOutline(work, outline(), "N0000ZZ.zip")).toBe(false);

    expect(disk.get(chaptersPath)).toBe(before);
    // 違いを見せて、選び方を並べている
    expect(confirmText).toContain("序章（作者の名前）");
    expect(confirmText).toContain("第二章『灯』");
    expect(confirmButtons).toContain("足りない章だけ足す");
    expect(confirmButtons).toContain("バックアップの章立てに置き換える");
  });

  test("「足りない章だけ足す」では、作者の章が名前ごと残る", async () => {
    putSplitWork();
    putLedger([{ name: "序章（作者の名前）", startEpisodePath: "episode_0001.txt" }]);
    answer = "足りない章だけ足す";

    expect(await applyChapterOutline(work, outline(), "N0000ZZ.zip")).toBe(true);

    expect(ledger()?.chapters).toEqual([
      { name: "序章（作者の名前）", startEpisodePath: "episode_0001.txt" },
      { name: "第二章『灯』", startEpisodePath: "episode_0003.txt" },
    ]);
  });

  test("話が合わなければ、台帳を作らずに止まり、合わない話を見せる", async () => {
    putSplitWork();
    scanned.splice(1, 1); // 2話が手元に無い
    answer = "章を立てる";

    expect(await applyChapterOutline(work, outline(), "N0000ZZ.zip")).toBe(false);

    expect(ledger()).toBeNull();
    expect(warnings.join("")).toContain("2話　古い地図");
  });
});

describe("新しく取り込んだ作品の章立て（placeImportedChapters）", () => {
  beforeEach(() => {
    disk.clear();
    scanned.length = 0;
  });

  test("話ごとのファイルなら、訊かずに立てて一文を返す", async () => {
    putSplitWork();

    const result = await placeImportedChapters(work, outline());

    expect(result?.created).toBe(2);
    expect(result?.note).toContain("章立てを2個立てました");
    expect(ledger()?.chapters).toHaveLength(2);
  });

  test("合本のままなら立てず、「話ごとのファイルに分ける」を案内する", async () => {
    scanned.push(
      episodeFile(
        "N0000ZZ.txt",
        null,
        [
          episodeText(1, TITLES[0], [1, "第一章『岬』"]),
          episodeText(2, TITLES[1]),
          episodeText(3, TITLES[2], [2, "第二章『灯』"]),
          episodeText(4, TITLES[3]),
        ].join("\r\n")
      )
    );

    const result = await placeImportedChapters(work, outline());

    expect(result?.created).toBe(0);
    expect(result?.note).toContain("話ごとのファイルに分ける");
    expect(ledger()).toBeNull();
  });

  test("章の見出しが無ければ何もしない", async () => {
    putSplitWork();
    const bare = outline().map((episode) => ({ ...episode, part: null }));

    expect(await placeImportedChapters(work, bare)).toBeUndefined();
    expect(ledger()).toBeNull();
  });
});
