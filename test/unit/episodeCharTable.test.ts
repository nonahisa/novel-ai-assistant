import { describe, expect, test } from "vitest";
import { buildEpisodeCountTable } from "../../src/core/episodeCharTable";
import type { EpisodeFile } from "../../src/models/types";

/** 走査結果の1件。文字数まわり以外は既定値でよい */
function episode(
  fileName: string,
  net: number,
  overrides: Partial<EpisodeFile> = {}
): EpisodeFile {
  return {
    filePath: `C:/work/本文/${fileName}`,
    fileName,
    ext: ".txt",
    chapterStart: null,
    chapterEnd: null,
    subtitle: null,
    kind: "本編",
    isInitialName: false,
    counts: {
      gross: net,
      net,
      lines: 10,
      paragraphs: 5,
      // 1行20字で折り返した行数。枚数の合算を確かめるのに使う
      manuscriptLines: Math.ceil(net / 20),
    },
    hasMetadata: false,
    metaTitle: null,
    declaredCharCount: null,
    metaUpdatedAt: null,
    hasConflictMarkers: false,
    collectedCount: null,
    ...overrides,
  };
}

describe("話ごとの文字数一覧", () => {
  test("平均から大きく外れた話に印を付ける", () => {
    // 極端に短い話・長い話は、投稿の間隔や読者の離脱に効く
    const table = buildEpisodeCountTable([
      episode("001.txt", 2_000),
      episode("002.txt", 2_000),
      episode("003.txt", 2_000),
      episode("004.txt", 300),
      episode("005.txt", 9_000),
    ]);

    const flags = table.rows.map((row) => row.flag);
    expect(flags).toEqual([null, null, null, "short", "long"]);
  });

  test("話数が少ないうちは印を付けない", () => {
    // 2話しかなければ片方は必ず平均より上になる。平均自体が当てにならない
    const table = buildEpisodeCountTable([
      episode("001.txt", 500),
      episode("002.txt", 5_000),
    ]);

    expect(table.rows.every((row) => row.flag === null)).toBe(true);
  });

  test("競合中の話は字数に数えず、行としては残す", () => {
    // 数えないだけで、存在まで消すと作者は何が抜けたか分からない
    const table = buildEpisodeCountTable([
      episode("001.txt", 2_000),
      episode("002.txt", 0, { hasConflictMarkers: true }),
    ]);

    expect(table.rows).toHaveLength(2);
    expect(table.summary.countedFiles).toBe(1);
    expect(table.summary.conflictedFiles).toBe(1);
    expect(table.summary.totalNet).toBe(2_000);
    expect(table.rows[1].flag).toBeNull();
  });

  test("原稿用紙の枚数は行数を合算してから換算する", () => {
    // ファイルごとに切り上げて足すと、端数が積み上がって実際より多くなる
    const table = buildEpisodeCountTable([
      episode("001.txt", 210),
      episode("002.txt", 210),
    ]);

    // 各11行 → 合計22行 → 2枚（1枚ずつ切り上げると2枚だが、
    // 行で合算しないと端数が増えていく）
    expect(table.summary.totalPages).toBe(2);
  });

  test("中央値も出す", () => {
    // 合本の1ファイルがあると平均が跳ね上がり、実感と合わなくなる
    const table = buildEpisodeCountTable([
      episode("001.txt", 2_000),
      episode("002.txt", 2_100),
      episode("003.txt", 2_200),
      episode("全話.txt", 700_000, { collectedCount: 219 }),
    ]);

    expect(table.summary.medianNet).toBe(2_150);
    expect(table.summary.averageNet).toBeGreaterThan(100_000);
  });

  test("いちばん長い話と短い話を指す", () => {
    const table = buildEpisodeCountTable([
      episode("001.txt", 2_000),
      episode("002.txt", 500),
      episode("003.txt", 9_000),
    ]);

    expect(table.summary.longest?.fileName).toBe("003.txt");
    expect(table.summary.shortest?.fileName).toBe("002.txt");
  });

  test("話数の見出しとタイトルを作る", () => {
    const table = buildEpisodeCountTable([
      episode("001.txt", 2_000, {
        chapterStart: 1,
        chapterEnd: 1,
        metaTitle: "第1話 気がついたら幽霊に",
      }),
      episode("序章.txt", 1_000, { kind: "プロローグ" }),
    ]);

    // 見出しに「第1話」が出るので、タイトル側からは落とす
    expect(table.rows[0]).toMatchObject({
      chapterLabel: "第1話",
      title: "気がついたら幽霊に",
    });
    expect(table.rows[1].chapterLabel).toBe("プロローグ");
  });

  test("本文が1件も無くても壊れない", () => {
    const table = buildEpisodeCountTable([]);

    expect(table.rows).toEqual([]);
    expect(table.summary).toMatchObject({
      countedFiles: 0,
      averageNet: 0,
      medianNet: 0,
      longest: null,
      shortest: null,
    });
  });
});
