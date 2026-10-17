import * as path from "path";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { WorkEntry } from "../../../src/models/types";
import { Uri, window, workspace } from "../support/vscodeStub";
import { memoryFs } from "../support/memoryDisk";

/**
 * ［PDF出力］の前回の設定（作者の裁定 2026-10-16 夜の3）。
 *
 * - 作者が画面で書き出せたら、紙・向き・範囲を作品の設定（`config.json` の `pdfExport`）に覚える
 * - 外部AIからの PDF の書き出し（`run.request` の `exportPdf`）は、それを使って組む。
 *   記録が無ければ文庫サイズ・縦書き・全話
 *
 * 作り物のファイルシステムで、製品の `exportPdf` と `exportPdfForRequest` をそのまま動かす
 * （`exportPdfCollected.test.ts` と同じ作法）。
 */

vi.mock("../../../src/core/openExternalFile", () => ({
  openInDefaultApp: async () => true,
}));
vi.mock("../../../src/views/openDocument", () => ({
  revealFolder: async () => undefined,
}));

const { exportPdf, exportPdfForRequest, planPdfExportForRequest } = await import(
  "../../../src/features/exportPdf"
);

const work: WorkEntry = {
  id: "work_pdf_last",
  title: "灯の町",
  folderPath: "C:\\novels\\lamp",
  registeredAt: "2026-10-16T00:00:00.000Z",
};

const disk = new Map<string, Uint8Array>();

function diskPath(filePath: string): string {
  return Uri.file(filePath).fsPath;
}

function put(relativePath: string, text: string): void {
  disk.set(diskPath(path.join(work.folderPath, relativePath)), new TextEncoder().encode(text));
}

function read(relativePath: string): string | undefined {
  const bytes = disk.get(diskPath(path.join(work.folderPath, relativePath)));
  return bytes ? new TextDecoder().decode(bytes) : undefined;
}

function config(): Record<string, unknown> {
  return JSON.parse(read(".aiwriter/config.json") ?? "{}") as Record<string, unknown>;
}

function installDisk(): void {
  workspace.fs = memoryFs(disk, {
    fileStat: { mtime: Date.UTC(2026, 9, 16, 5, 0, 0), size: 1 },
    folderStat: { mtime: 0, size: 0 },
    readDirectory: "nested",
  });
}

/**
 * 画面の選択に答える。**項目の形で見分ける**（順番で決め打ちしない）。
 * `files` を渡すと「話を選ぶ」へ進み、その名前の話だけを選ぶ。
 */
function answer(options: { paper: string; files?: string[] }): void {
  (window as unknown as Record<string, unknown>).showQuickPick = async (
    items: Array<Record<string, unknown>>,
    pickOptions?: { canPickMany?: boolean }
  ) => {
    if (pickOptions?.canPickMany) {
      return items.filter((item) => options.files?.includes(String(item.description)));
    }
    const scope = items.find((item) => item.all === (options.files === undefined));
    if (scope) return scope;
    const keep = items.find((item) => item.margins === "default");
    if (keep) return keep;
    return items.find((item) => item.id === options.paper);
  };
}

/** 書き出された印刷用HTML（新しいほう） */
function exportedHtmls(): string[] {
  return [...disk.entries()]
    .filter(([name]) => name.endsWith(".html"))
    .map(([, bytes]) => new TextDecoder().decode(bytes));
}

beforeEach(() => {
  disk.clear();
  installDisk();
  window.showInformationMessage = async () => undefined;
  window.showWarningMessage = async () => undefined;
  window.showErrorMessage = async () => undefined;
  put(
    ".aiwriter/config.json",
    JSON.stringify(
      {
        schemaVersion: "1",
        workTitle: "灯の町",
        manuscriptDir: "本文",
        settingsDir: "設定",
        createdAt: "2026-01-01T00:00:00.000Z",
        kind: "novel",
      },
      null,
      2
    )
  );
  put("本文/001_灯.txt", "　港の灯が消えた夜。\n");
  put("本文/002_便り.txt", "　冬の終わりに便りが届いた。\n");
  put("本文/003_春.txt", "　春が来た。\n");
});

/** 読む紙の既定の置き方（2026-10-17） */
const NONE = { left: "none", center: "none", right: "none" };
const READING_MARGINS = {
  odd: { top: { left: "none", center: "episode", right: "page" }, bottom: NONE },
  even: { top: { left: "page", center: "episode", right: "none" }, bottom: NONE },
};

describe("画面で書き出せたら、紙・向き・範囲・余白の置き方を覚える", () => {
  test("すべての話を選んだら「全話」として覚える。ほかの欄は落とさない", async () => {
    answer({ paper: "a4-horizontal" });
    await exportPdf(work);
    expect(config().pdfExport).toEqual({
      paper: { kind: "preset", preset: "a4-horizontal" },
      range: { scope: "all" },
      headerFooter: READING_MARGINS,
    });
    expect(config().kind).toBe("novel");
    expect(config().workTitle).toBe("灯の町");
  });

  test("話を選んだら、その話を作品フォルダーからの相対パスで覚える", async () => {
    answer({ paper: "a5-vertical", files: ["003_春.txt", "001_灯.txt"] });
    await exportPdf(work);
    expect(config().pdfExport).toEqual({
      paper: { kind: "preset", preset: "a5-vertical" },
      range: { scope: "files", files: ["本文/001_灯.txt", "本文/003_春.txt"] },
      headerFooter: READING_MARGINS,
    });
  });

  test("前回の置き方があれば「前回と同じ置き方」を先頭に出す（同じ種類の紙のときだけ）", async () => {
    const saved = {
      odd: { top: NONE, bottom: { ...NONE, right: "page" } },
      even: { top: NONE, bottom: { ...NONE, left: "page" } },
    };
    const base = JSON.parse(read(".aiwriter/config.json") ?? "{}") as Record<string, unknown>;
    put(
      ".aiwriter/config.json",
      JSON.stringify({
        ...base,
        pdfExport: { paper: { kind: "preset", preset: "a5-vertical" }, range: { scope: "all" }, headerFooter: saved },
      })
    );
    const seen: Array<Array<Record<string, unknown>>> = [];
    (window as unknown as Record<string, unknown>).showQuickPick = async (
      items: Array<Record<string, unknown>>
    ) => {
      seen.push(items);
      const scope = items.find((item) => item.all === true);
      if (scope) return scope;
      const last = items.find((item) => item.margins === "last");
      if (last) return last;
      return items.find((item) => item.id === "bunko-vertical");
    };
    await exportPdf(work);

    const marginPick = seen.find((items) => items.some((item) => item.margins));
    expect(marginPick?.[0].label).toBe("前回と同じ置き方");
    expect(marginPick?.[0].description).toBe("奇数ページ：フッター右にページ番号／偶数ページ：フッター左にページ番号");
    expect((config().pdfExport as { headerFooter: unknown }).headerFooter).toEqual(saved);
  });

  test("取りやめたら覚えない", async () => {
    (window as unknown as Record<string, unknown>).showQuickPick = async () => undefined;
    await exportPdf(work);
    expect(config().pdfExport).toBeUndefined();
  });

  test("壊れた設定ファイルは直さない", async () => {
    put(".aiwriter/config.json", "{ 壊れている");
    answer({ paper: "a4-horizontal" });
    // 走査（作品の設定を読む）が先に断るのは今までどおり。ここで見るのは、覚える処理が
    // 壊れたファイルを上書きしないこと（規則2）
    await exportPdf(work).catch(() => undefined);
    expect(read(".aiwriter/config.json")).toBe("{ 壊れている");
  });
});

describe("外部AIからの書き出しは、前回の設定で組む", () => {
  test("前回の記録が無ければ、文庫サイズ・縦書き・全話", async () => {
    const plan = await planPdfExportForRequest(work);
    if (!plan.ok) throw new Error(plan.reason);
    expect(plan.paper).toEqual({ kind: "preset", preset: "bunko-vertical" });
    expect(plan.episodes.map((episode) => episode.fileName)).toEqual([
      "001_灯.txt",
      "002_便り.txt",
      "003_春.txt",
    ]);
    expect(plan.lines.source).toContain("既定");

    const made = await exportPdfForRequest(work);
    if (!made.ok) throw new Error(made.reason);
    expect(made.chapters).toBe(3);
    expect(made.notices[0]).toContain("文庫サイズ");
    expect(made.notices[0]).toContain("縦書き");
    // 外からの書き出しは設定を書き換えない（覚えるのは作者が画面で選んだときだけ）
    expect(config().pdfExport).toBeUndefined();
  });

  test("画面で選んだ紙と話で、外からも組む", async () => {
    answer({ paper: "a4-horizontal", files: ["002_便り.txt"] });
    await exportPdf(work);

    const plan = await planPdfExportForRequest(work);
    if (!plan.ok) throw new Error(plan.reason);
    expect(plan.lines.paper).toContain("A4");
    expect(plan.lines.direction).toBe("横書き");
    expect(plan.lines.range).toContain("前回選んだ1話");
    expect(plan.lines.source).toContain("前回");

    const made = await exportPdfForRequest(work);
    if (!made.ok) throw new Error(made.reason);
    expect(made.chapters).toBe(1);
    const html = exportedHtmls().find((text) => !text.includes("港の灯"));
    expect(html).toBeDefined();
    expect(html).toContain("冬の終わりに便りが届いた");
    expect(made.notices[0]).toContain("横書き");
  });

  test("公募の納品用（字数×行数）も前回のとおり升目で組む", async () => {
    put(
      ".aiwriter/config.json",
      JSON.stringify({
        schemaVersion: "1",
        workTitle: "灯の町",
        manuscriptDir: "本文",
        settingsDir: "設定",
        createdAt: "2026-01-01T00:00:00.000Z",
        pdfExport: {
          paper: {
            kind: "grid",
            paper: "a4-portrait",
            columns: 20,
            rows: 20,
            hanging: true,
            vertical: false,
            marginMm: 20,
          },
          range: { scope: "all" },
        },
      })
    );
    const plan = await planPdfExportForRequest(work);
    if (!plan.ok) throw new Error(plan.reason);
    expect(plan.paper.kind).toBe("grid");
    expect(plan.lines.paper).toContain("20字×20行");
    expect(plan.lines.direction).toBe("横書き");

    const made = await exportPdfForRequest(work);
    if (!made.ok) throw new Error(made.reason);
    // 升目で組んだときだけ出る枚数の一言
    expect(made.notices.join("\n")).toContain("20字×20行で本文");
    // 置き方の記録が無いので、公募の既定（下の中央にページ番号）
    expect(made.notices[0]).toContain("奇数・偶数ページとも：フッター中央にページ番号");
  });

  test("前回の置き方で組む。作者名の枠は、名前を訊けないので空けて断る", async () => {
    put(
      ".aiwriter/config.json",
      JSON.stringify({
        schemaVersion: "1",
        workTitle: "灯の町",
        manuscriptDir: "本文",
        settingsDir: "設定",
        createdAt: "2026-01-01T00:00:00.000Z",
        pdfExport: {
          paper: { kind: "preset", preset: "bunko-vertical" },
          range: { scope: "all" },
          headerFooter: {
            odd: { top: NONE, bottom: { left: "author", center: "none", right: "page" } },
            even: { top: NONE, bottom: { left: "page", center: "none", right: "author" } },
          },
        },
      })
    );
    const plan = await planPdfExportForRequest(work);
    if (!plan.ok) throw new Error(plan.reason);
    expect(plan.lines.margins).toContain("フッター左に作者名");

    const made = await exportPdfForRequest(work);
    if (!made.ok) throw new Error(made.reason);
    expect(made.notices[0]).toContain("奇数ページ：フッター右にページ番号／偶数ページ：フッター左にページ番号");
    expect(made.notices.join("\n")).toContain("作者名を刷る余白は、外からは名前を訊けないため空けました");
    const html = exportedHtmls()[0];
    expect(html).not.toContain("&quot;author&quot;");
  });
});
