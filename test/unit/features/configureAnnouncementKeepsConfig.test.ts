import * as path from "path";
import { beforeEach, describe, expect, test } from "vitest";
import type { WorkEntry } from "../../../src/models/types";
import { FileSystemError, Uri, window, workspace } from "../support/vscodeStub";
import { configureAnnouncement } from "../../../src/features/generateAnnouncement";

/**
 * 告知の設定（ハッシュタグ・URL）を保存するとき、作品の設定（`config.json`）の
 * **ほかの欄を落とさない**。
 *
 * 2026-10-16 夜、［PDF出力］の前回の設定（`pdfExport`）を同じファイルへ足したときに、
 * 告知の設定の保存が欄を名指しで組み直していて、種類（`kind`）・シリーズ（`series`）・
 * 名前の系統（`nameOrigin`）まで黙って消していたことが分かった（コメントには
 * 「他の欄を落とさない」とあった）。
 */

const work: WorkEntry = {
  id: "work_announce_keep",
  title: "灯の町",
  folderPath: "C:\\novels\\lamp",
  registeredAt: "2026-10-16T00:00:00.000Z",
};

const disk = new Map<string, Uint8Array>();
const configPath = Uri.file(path.join(work.folderPath, ".aiwriter", "config.json")).fsPath;

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
  } as unknown as typeof workspace.fs;
  const answers = ["創作 小説", "https://example.com/works/1"];
  (window as unknown as Record<string, unknown>).showInputBox = async () => answers.shift();
  window.showWarningMessage = async () => undefined;
});

describe("告知の設定の保存", () => {
  test("種類・シリーズ・名前の系統・PDFの前回の設定を残したまま、announce だけを重ねる", async () => {
    const pdfExport = {
      paper: { kind: "preset", preset: "a5-vertical" },
      range: { scope: "files", files: ["本文/001_灯.txt"] },
    };
    disk.set(
      configPath,
      new TextEncoder().encode(
        JSON.stringify({
          schemaVersion: "1",
          workTitle: "灯の町",
          manuscriptDir: "本文",
          settingsDir: "設定",
          createdAt: "2026-01-01T00:00:00.000Z",
          kind: "script",
          series: { name: "灯の町シリーズ", related: ["灯の町2"] },
          nameOrigin: "ドイツ",
          pdfExport,
        })
      )
    );

    const saved = await configureAnnouncement(work);
    expect(saved?.workUrl).toBe("https://example.com/works/1");

    const written = JSON.parse(new TextDecoder().decode(disk.get(configPath))) as Record<string, unknown>;
    expect(written.announce).toEqual({
      hashtags: ["#創作", "#小説"],
      workUrl: "https://example.com/works/1",
    });
    expect(written.kind).toBe("script");
    expect(written.series).toEqual({ name: "灯の町シリーズ", related: ["灯の町2"] });
    expect(written.nameOrigin).toBe("ドイツ");
    expect(written.pdfExport).toEqual(pdfExport);
  });

  test("設定ファイルがまだ無い作品では、既定で作る（今までどおり）", async () => {
    await configureAnnouncement(work);
    const written = JSON.parse(new TextDecoder().decode(disk.get(configPath))) as Record<string, unknown>;
    expect(written.workTitle).toBe("灯の町");
    expect(written.manuscriptDir).toBe("本文");
    expect(written.announce).toEqual({
      hashtags: ["#創作", "#小説"],
      workUrl: "https://example.com/works/1",
    });
  });
});
