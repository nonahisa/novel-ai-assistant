import * as path from "path";
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { WorkEntry } from "../../src/models/types";
import {
  FileSystemError,
  FileType,
  Uri,
  window,
  workspace,
} from "./support/vscodeStub";

/**
 * 合本（1ファイルに複数話）をPDF（印刷用HTML）へ組む（設計書6.65.15）。
 *
 * **EPUBと同じ切り分けを通す。** PDF出力は長いあいだ
 * `parseEpisodeMetadata` だけを通っており、区切り行（`エピソードN開始`）も
 * 【エピソードタイトル】【後書き】【リアクション】も、まるごと本文として
 * 紙に出ていた（EPUBで直したのと同じ不具合。原稿は読むだけなので、
 * 被害は書き出したファイルの中だけ）。
 *
 * ここは作り物のファイルシステムで `exportPdf` をそのまま動かし、
 * 書き出されたHTMLを開いて確かめる。組版を別に組み直すと、**製品に無い紙**
 * を確かめたことになる。
 */

// 書き出したファイルを既定のアプリで開くところは、テストでは動かさない
// （`cmd /c start` が実際に走ってブラウザが開いてしまう）
vi.mock("../../src/core/openExternalFile", () => ({
  openInDefaultApp: async () => true,
}));
vi.mock("../../src/views/openDocument", () => ({
  revealFolder: async () => undefined,
}));

const { exportPdf } = await import("../../src/features/exportPdf");

const work: WorkEntry = {
  id: "work_pdf_collected",
  title: "氷の街",
  folderPath: "C:\\novels\\work",
  registeredAt: "2026-09-05T00:00:00.000Z",
};

const disk = new Map<string, Uint8Array>();
const shown: string[] = [];

function diskPath(filePath: string): string {
  return Uri.file(filePath).fsPath;
}

function put(relativePath: string, text: string): void {
  disk.set(
    diskPath(path.join(work.folderPath, relativePath)),
    new TextEncoder().encode(text)
  );
}

/** 作り物のファイルシステム。キーは `Uri.file` が返す形に揃える */
function installDisk(): void {
  const separator = path.sep;
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
      if (disk.has(uri.fsPath)) {
        return { mtime: Date.UTC(2026, 8, 5, 5, 0, 0), size: 1 };
      }
      const prefix = uri.fsPath + separator;
      for (const key of disk.keys()) {
        if (key.startsWith(prefix)) return { mtime: 0, size: 0 };
      }
      throw new FileSystemError("missing", "FileNotFound");
    },
    readDirectory: async (uri: { fsPath: string }) => {
      const prefix = uri.fsPath + separator;
      const names = new Map<string, FileType>();
      for (const key of disk.keys()) {
        if (!key.startsWith(prefix)) continue;
        const rest = key.slice(prefix.length);
        const cut = rest.indexOf(separator);
        if (cut < 0) names.set(rest, FileType.File);
        else names.set(rest.slice(0, cut), FileType.Directory);
      }
      if (names.size === 0) throw new FileSystemError("missing", "FileNotFound");
      return [...names.entries()];
    },
  } as unknown as typeof workspace.fs;
}

/**
 * 2つの選択（範囲・紙の大きさ）に答える。
 *
 * **項目の形で見分ける。** 順番で決め打ちすると、選択が1つ増えた
 * ときに黙って別の答えを返すことになる。
 */
function answerQuickPicks(): void {
  (window as unknown as Record<string, unknown>).showQuickPick = async (
    items: Array<Record<string, unknown>>
  ) => {
    const all = items.find((item) => item.all === true);
    if (all) return all;
    return items.find((item) => item.id === "bunko-vertical");
  };
}

beforeEach(() => {
  disk.clear();
  shown.length = 0;
  installDisk();
  answerQuickPicks();

  window.showInformationMessage = async (message: string) => {
    shown.push(message);
    return undefined;
  };
  window.showWarningMessage = async (message: string) => {
    shown.push(message);
    return undefined;
  };
  window.showErrorMessage = async (message: string) => {
    shown.push(message);
    return undefined;
  };
});

/** 書き出された印刷用HTMLを開き直す */
function exportedHtml(): string {
  const found = [...disk.entries()].find(([name]) => name.endsWith(".html"));
  if (!found) throw new Error("印刷用HTMLが書き出されていません");
  return new TextDecoder().decode(found[1]);
}

/** 目に見える字だけを取り出す（札を落とす） */
function plain(html: string): string {
  return html.replace(/<[^>]+>/g, "");
}

/** 実データで観察された合本の形（区切り＋頭書き＋後書き＋リアクション） */
const COLLECTED = [
  "------------------------- エピソード1開始 -------------------------",
  "【エピソードタイトル】",
  "１話　転生",
  "",
  "【本文】",
  "　朝が来た。",
  "",
  "　鐘が鳴る。",
  "",
  "【後書き】",
  "　お読みいただきありがとうございます。",
  "",
  "【リアクション】",
  "いいね: 19件",
  "",
  "------------------------- エピソード2開始 -------------------------",
  "【エピソードタイトル】",
  "２話　再会",
  "",
  "【本文】",
  "　昼が来た。",
  "",
  "------------------------- エピソード3開始 -------------------------",
  "【エピソードタイトル】",
  "３話　別離",
  "",
  "【本文】",
  "　夜が来た。",
].join("\n");

describe("合本は話ごとに章へ割る（設計書6.65.15）", () => {
  beforeEach(() => {
    put("本文/全話.txt", COLLECTED);
  });

  test("3話ぶんの合本から、3つの章ができる", async () => {
    await exportPdf(work);
    const html = exportedHtml();

    // 話ごとに改ページする単位が `section.episode`（`core/printHtml.ts`）
    expect(html.match(/<section class="episode">/g)?.length).toBe(3);
  });

  test("区切り行・頭書き・後書き・リアクションは本文に入らない", async () => {
    await exportPdf(work);
    const text = plain(exportedHtml());

    expect(text).toContain("朝が来た。");
    expect(text).toContain("昼が来た。");
    expect(text).toContain("夜が来た。");

    expect(text).not.toContain("エピソード1開始");
    expect(text).not.toContain("エピソードタイトル");
    expect(text).not.toContain("【本文】");
    expect(text).not.toContain("お読みいただきありがとうございます");
    expect(text).not.toContain("いいね: 19件");
  });

  test("章の見出しは、その話の話数と題になる", async () => {
    await exportPdf(work);
    const headings = [
      ...exportedHtml().matchAll(/<h2 class="episode-heading">([^<]*)<\/h2>/g),
    ].map((matched) => matched[1]);

    expect(headings).toEqual(["第1話　転生", "第2話　再会", "第3話　別離"]);
  });

  /**
   * **話数が読めない話でも、番号を捏造しない**（EPUBと同じ約束）。
   * 並び順を話数として出すと、「プロローグ」が第1話になる。
   */
  test("話数の読めない話は、題だけを見出しにする", async () => {
    put(
      "本文/全話.txt",
      [
        "------- エピソード1開始 -------",
        "【エピソードタイトル】",
        "プロローグ",
        "",
        "【本文】",
        "　雪が降る。",
        "",
        "------- エピソード2開始 -------",
        "【エピソードタイトル】",
        "１話　転生",
        "",
        "【本文】",
        "　朝が来た。",
      ].join("\n")
    );

    await exportPdf(work);
    const headings = [
      ...exportedHtml().matchAll(/<h2 class="episode-heading">([^<]*)<\/h2>/g),
    ].map((matched) => matched[1]);

    expect(headings).toEqual(["プロローグ", "第1話　転生"]);
  });
});

/**
 * **単話ファイルだけの作品の紙は、1バイトも変わらない**（回帰の固定）。
 *
 * 合本を割る道を足したせいで、いままで出ていた紙が変わっては困る。
 * 下の期待値は、合本を割る前の書き出しから採った。
 */
describe("単話だけの作品の紙は変わらない（回帰の固定）", () => {
  /** 1区切りだけの頭書き付き。**これは合本ではない**（単話の道を通る） */
  const WITH_HEADER = [
    "-------- エピソード1開始 --------",
    "【エピソードタイトル】",
    "２話　再会",
    "",
    "【本文】",
    "　昼が来た。",
  ].join("\n");

  test("組んだHTMLが1バイトも変わらない", async () => {
    put("本文/第1話 出会い.txt", "　朝が来た。\n\n　鐘が鳴る。");
    put("本文/第2話.txt", WITH_HEADER);

    await exportPdf(work);
    const digest = createHash("sha256")
      .update(new TextEncoder().encode(exportedHtml()))
      .digest("hex");

    expect(digest).toBe(GOLDEN);
  });
});

/**
 * 合本を割る前の書き出しから採ったハッシュ（2026-09-05）。
 *
 * **ここを更新してよいのは、紙の組み方を変えると決めたときだけ**である。
 * 合本の実装で動いたら、単話の道を巻き込んでいる。
 */
const GOLDEN =
  "119fb2fb6c21f6c5832ca70dcfbde810e80be145043b67c7d6748a81187b742b";
