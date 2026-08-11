import { describe, expect, test, vi } from "vitest";

vi.mock("vscode", () => ({
  Uri: { file: (p: string) => ({ fsPath: p }) },
  workspace: { fs: { rename: async () => {}, stat: async () => {} } },
}));

import { renamedFileName } from "../../src/core/episodeRename";
import { needsSubtitle, type EpisodeBody } from "../../src/core/episodeBodies";
import type { EpisodeFile } from "../../src/models/types";

function file(overrides: Partial<EpisodeFile> = {}): EpisodeFile {
  return {
    filePath: "C:/work/本文/007.txt",
    fileName: "007.txt",
    ext: ".txt",
    chapterStart: 7,
    chapterEnd: 7,
    subtitle: null,
    kind: "本編",
    isInitialName: true,
    counts: { gross: 0, net: 0, lines: 0, paragraphs: 0 },
    hasMetadata: false,
    metaTitle: null,
    declaredCharCount: null,
    metaUpdatedAt: null,
    hasConflictMarkers: false,
    collectedCount: null,
    ...overrides,
  };
}

function body(overrides: Partial<EpisodeBody> = {}): EpisodeBody {
  return {
    file: file(),
    chapter: 7,
    title: null,
    body: "本文",
    hash: "hash",
    insideCollected: false,
    ...overrides,
  };
}

describe("サブタイトルを付けたファイル名", () => {
  test("話数の部分は元のまま使う（ゼロ埋めを崩さない）", () => {
    // 007 を 7 に詰めると、一覧の並び順が崩れる
    expect(renamedFileName(file(), "湖畔の誓い")).toBe("007_湖畔の誓い.txt");
  });

  test("拡張子を保つ", () => {
    expect(
      renamedFileName(
        file({ fileName: "012.md", ext: ".md", filePath: "C:/w/012.md" }),
        "再会"
      )
    ).toBe("012_再会.md");
  });

  test("ファイル名に使えない文字は全角へ置き換える", () => {
    expect(renamedFileName(file(), "再会/別離")).toBe("007_再会／別離.txt");
  });
});

describe("サブタイトルを提案してよい話か", () => {
  test("ファイル名が数字だけで、サブタイトルが無ければ提案する", () => {
    expect(needsSubtitle(body())).toBe(true);
  });

  test("すでにサブタイトルがあれば提案しない", () => {
    expect(needsSubtitle(body({ title: "湖畔の誓い" }))).toBe(false);
  });

  test("作者が名前を付けたファイルには提案しない", () => {
    expect(needsSubtitle(body({ file: file({ isInitialName: false }) }))).toBe(
      false
    );
  });

  test("合本の中の話には提案しない（ファイル名を変えられない）", () => {
    expect(needsSubtitle(body({ insideCollected: true }))).toBe(false);
  });
});
