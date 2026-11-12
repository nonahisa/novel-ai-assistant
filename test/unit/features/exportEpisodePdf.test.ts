import * as path from "path";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { EpisodeFile, WorkEntry } from "../../../src/models/types";
import { emptyCounts } from "../../../src/core/charCount";
import { Uri, window, workspace } from "../support/vscodeStub";
import { memoryFs } from "../support/memoryDisk";

/**
 * 原稿エディターの［出力］→「PDF（この話）」（0.150.0。設計書6.25.13）。
 *
 * - 作品の［PDF出力］と同じ組み方で、**開いている話だけ**を印刷用のファイルにする
 * - 紙・向き・余白は前回の［PDF出力］の設定（無ければ文庫サイズ・縦書き）。訊かない
 * - 合本はカーソルのある話だけ
 * - 設定は覚え直さない（外部AIの依頼の範囲が1話に変わらないように）
 *
 * 作り物のファイルシステムで製品の関数をそのまま動かす（`exportPdfLastSettings.test.ts` と同じ作法）。
 */

const opened: string[] = [];
vi.mock("../../../src/core/openExternalFile", () => ({
  openInDefaultApp: async (target: string) => {
    opened.push(target);
    return true;
  },
}));
vi.mock("../../../src/views/openDocument", () => ({
  revealFolder: async () => undefined,
}));

const { exportEpisodePdf } = await import("../../../src/features/exportPdf");

const work: WorkEntry = {
  id: "work_pdf_episode",
  title: "灯の町",
  folderPath: "C:\\novels\\lamp-episode",
  registeredAt: "2026-11-12T00:00:00.000Z",
};

const disk = new Map<string, Uint8Array>();
const diskPath = (filePath: string) => Uri.file(filePath).fsPath;
const full = (relativePath: string) => diskPath(path.join(work.folderPath, relativePath));

function put(relativePath: string, text: string): void {
  disk.set(full(relativePath), new TextEncoder().encode(text));
}

function read(relativePath: string): string | undefined {
  const bytes = disk.get(full(relativePath));
  return bytes ? new TextDecoder().decode(bytes) : undefined;
}

function episode(relativePath: string, collectedCount: number | null = null): EpisodeFile {
  const fileName = path.basename(relativePath);
  return {
    filePath: full(relativePath),
    fileName,
    ext: ".txt",
    chapterStart: 1,
    chapterEnd: 1,
    subtitle: null,
    kind: "本編",
    isInitialName: false,
    counts: emptyCounts(),
    hasMetadata: false,
    metaTitle: null,
    declaredCharCount: null,
    metaUpdatedAt: null,
    hasConflictMarkers: false,
    collectedCount,
  };
}

/** 書き出された印刷用HTMLの名前と中身 */
function exported(): Array<[string, string]> {
  return [...disk.entries()]
    .filter(([name]) => name.endsWith(".html"))
    .map(([name, bytes]) => [path.basename(name), new TextDecoder().decode(bytes)]);
}

const BASE_CONFIG = {
  schemaVersion: "1",
  workTitle: "灯の町",
  manuscriptDir: "本文",
  settingsDir: "設定",
  createdAt: "2026-01-01T00:00:00.000Z",
  kind: "novel",
};

let picks: number;
let infos: string[];

beforeEach(() => {
  disk.clear();
  opened.length = 0;
  picks = 0;
  infos = [];
  workspace.fs = memoryFs(disk, {
    fileStat: { mtime: Date.UTC(2026, 10, 12, 5, 0, 0), size: 1 },
    folderStat: { mtime: 0, size: 0 },
    readDirectory: "nested",
  });
  // 紙を選ぶ窓は出ない（出たら数える）
  (window as unknown as Record<string, unknown>).showQuickPick = async () => {
    picks++;
    return undefined;
  };
  window.showInformationMessage = (async (message: string) => {
    infos.push(message);
    return undefined;
  }) as typeof window.showInformationMessage;
  window.showWarningMessage = async () => undefined;
  window.showErrorMessage = async () => undefined;
  put(".aiwriter/config.json", JSON.stringify(BASE_CONFIG, null, 2));
  put("本文/001_灯.txt", "　港の灯が消えた夜。\n");
  put("本文/002_便り.txt", "　冬の終わりに便りが届いた。\n");
});

describe("PDF（この話）", () => {
  test("開いている話だけを組み、紙は訊かずに既定（文庫サイズ・縦書き）。ブラウザで開く", async () => {
    await exportEpisodePdf(work, episode("本文/002_便り.txt"), 1);

    expect(picks).toBe(0);
    const files = exported();
    expect(files).toHaveLength(1);
    const [name, html] = files[0];
    expect(name).toMatch(/^印刷用_002_便り \d{4}-\d{2}-\d{2} \d{4}\.html$/);
    expect(html).toContain("冬の終わりに便りが届いた。");
    expect(html).not.toContain("港の灯が消えた夜。");
    expect(opened).toHaveLength(1);
    expect(opened[0]).toContain(path.join(".aiwriter", "exports"));
    expect(infos.join("\n")).toContain("縦書き");
  });

  test("前回の［PDF出力］の紙を使い、設定は覚え直さない", async () => {
    const last = {
      paper: { kind: "preset", preset: "a4-horizontal" },
      range: { scope: "all" },
    };
    put(".aiwriter/config.json", JSON.stringify({ ...BASE_CONFIG, pdfExport: last }, null, 2));
    const before = read(".aiwriter/config.json");

    await exportEpisodePdf(work, episode("本文/001_灯.txt"), 1);

    expect(infos.join("\n")).toContain("横書き");
    expect(read(".aiwriter/config.json")).toBe(before);
  });

  test("合本では、カーソルのある話だけを組む", async () => {
    const sep = (n: number) => `------------------------- エピソード${n}開始 -------------------------`;
    const text = [
      sep(1),
      "【エピソードタイトル】",
      "１話　始まり",
      "",
      "【本文】",
      "　一話目の本文。",
      "",
      sep(2),
      "【エピソードタイトル】",
      "２話　続き",
      "",
      "【本文】",
      "　二話目の本文。",
      "",
    ].join("\n");
    put("本文/合本.txt", text);
    // 13行目＝2話目の本文の行
    await exportEpisodePdf(work, episode("本文/合本.txt", 2), 13);

    const files = exported();
    expect(files).toHaveLength(1);
    expect(files[0][0]).toMatch(/^印刷用_合本_2 \d{4}-/);
    expect(files[0][1]).toContain("二話目の本文。");
    expect(files[0][1]).not.toContain("一話目の本文。");
  });

  test("原稿は1文字も書き換えない", async () => {
    await exportEpisodePdf(work, episode("本文/001_灯.txt"), 1);
    expect(read("本文/001_灯.txt")).toBe("　港の灯が消えた夜。\n");
  });
});
