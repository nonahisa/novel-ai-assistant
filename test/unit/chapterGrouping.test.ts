import * as path from "path";
import { describe, expect, test } from "vitest";
import {
  chapterNodeId,
  episodeGroupLabels,
  formatChapterRange,
  groupEpisodesByChapter,
} from "../../src/core/chapterGrouping";
import type { Chapter } from "../../src/models/chapter";
import type { EpisodeFile } from "../../src/models/types";

/**
 * 章ごとに話を束ねる論理（設計書6.66.1・6.66.3）。
 *
 * 章は開始の話しか持たない。**次の章が始まるまでがその章**なので、
 * 話を後から足しても、書いた場所の章へ自然に落ちる。
 * 最初の章より前の話は章なし（作品の直下）に残る。
 */

const WORK_FOLDER = path.join("C:", "novels", "work");

function episode(chapterStart: number, fileName: string): EpisodeFile {
  return {
    filePath: path.join(WORK_FOLDER, "本文", fileName),
    fileName,
    ext: ".txt",
    chapterStart,
    chapterEnd: chapterStart,
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

/** 第1話〜第8話を用意する（ファイル名は 001.txt 〜 008.txt） */
const episodes = [1, 2, 3, 4, 5, 6, 7, 8].map((n) =>
  episode(n, `${String(n).padStart(3, "0")}.txt`)
);

function chapter(name: string, fileName: string): Chapter {
  return { name, startEpisodePath: `本文/${fileName}` };
}

function names(groups: { chapter: Chapter }[]): string[] {
  return groups.map((group) => group.chapter.name);
}

function fileNames(list: EpisodeFile[]): string[] {
  return list.map((ep) => ep.fileName);
}

describe("章ごとの束ね", () => {
  test("章が1つも無ければ、話は全部が章なし", () => {
    const grouped = groupEpisodesByChapter(episodes, [], WORK_FOLDER);

    expect(grouped.groups).toEqual([]);
    expect(fileNames(grouped.ungrouped)).toHaveLength(8);
  });

  test("章が1つなら、その話から最後までが章に入る", () => {
    const grouped = groupEpisodesByChapter(
      episodes,
      [chapter("第一章", "003.txt")],
      WORK_FOLDER
    );

    expect(fileNames(grouped.ungrouped)).toEqual([
      "001.txt",
      "002.txt",
    ]);
    expect(fileNames(grouped.groups[0].episodes)).toEqual([
      "003.txt",
      "004.txt",
      "005.txt",
      "006.txt",
      "007.txt",
      "008.txt",
    ]);
  });

  test("章が複数なら、次の章が始まる手前までが1つの章", () => {
    const grouped = groupEpisodesByChapter(
      episodes,
      [chapter("第一章", "001.txt"), chapter("第二章", "006.txt")],
      WORK_FOLDER
    );

    expect(grouped.ungrouped).toEqual([]);
    expect(names(grouped.groups)).toEqual(["第一章", "第二章"]);
    expect(fileNames(grouped.groups[0].episodes)).toEqual([
      "001.txt",
      "002.txt",
      "003.txt",
      "004.txt",
      "005.txt",
    ]);
    expect(fileNames(grouped.groups[1].episodes)).toEqual([
      "006.txt",
      "007.txt",
      "008.txt",
    ]);
  });

  test("台帳の並びが話の順と違っていても、話の順に並べ直す", () => {
    // 作者が手で書き足すと、あとの章が先に書かれることがある
    const grouped = groupEpisodesByChapter(
      episodes,
      [chapter("第二章", "006.txt"), chapter("第一章", "003.txt")],
      WORK_FOLDER
    );

    expect(names(grouped.groups)).toEqual(["第一章", "第二章"]);
  });

  test("最初の章より前の話は、章なしとして残る（プロローグを章へ入れない）", () => {
    const grouped = groupEpisodesByChapter(
      episodes,
      [chapter("第一章", "002.txt")],
      WORK_FOLDER
    );

    expect(fileNames(grouped.ungrouped)).toEqual(["001.txt"]);
  });

  test("開始の話が見つからない章も、黙って消さずに返す", () => {
    const grouped = groupEpisodesByChapter(
      episodes,
      [chapter("第一章", "001.txt"), chapter("幻の章", "999.txt")],
      WORK_FOLDER
    );

    expect(names(grouped.groups)).toEqual(["第一章", "幻の章"]);
    const missing = grouped.groups[1];
    expect(missing.missingStart).toBe(true);
    expect(missing.episodes).toEqual([]);
    // 見つかる章のほうは、いままでどおり全部の話を持つ
    expect(grouped.groups[0].missingStart).toBe(false);
    expect(grouped.groups[0].episodes).toHaveLength(8);
  });

  test("話を後から足すと、開始のパスの間に入った話が正しい章へ落ちる", () => {
    const chapters = [chapter("第一章", "001.txt"), chapter("第二章", "006.txt")];
    const added = [...episodes, episode(9, "004b.txt")].sort((a, b) =>
      a.fileName.localeCompare(b.fileName)
    );

    const grouped = groupEpisodesByChapter(added, chapters, WORK_FOLDER);

    // 004b.txt は 004 と 005 の間（＝第一章の中）に並ぶ
    expect(fileNames(grouped.groups[0].episodes)).toContain("004b.txt");
    expect(fileNames(grouped.groups[1].episodes)).not.toContain("004b.txt");
    // 台帳は書き換えていない（章は開始しか持たない）
    expect(chapters).toHaveLength(2);
  });

  test("区切りが `\\` で書かれた台帳でも、同じ話を指す", () => {
    const grouped = groupEpisodesByChapter(
      episodes,
      [{ name: "第一章", startEpisodePath: "本文\\003.txt" }],
      WORK_FOLDER
    );

    expect(grouped.groups[0].missingStart).toBe(false);
    expect(fileNames(grouped.groups[0].episodes)[0]).toBe("003.txt");
  });
});

describe("章に添える話数の範囲", () => {
  test("範囲と件数を出す", () => {
    expect(formatChapterRange(episodes.slice(0, 5))).toBe("第1話〜第5話・5話");
  });

  test("1話だけの章は、範囲を重ねて出さない", () => {
    expect(formatChapterRange(episodes.slice(0, 1))).toBe("第1話・1話");
  });

  test("SNS記事では「話」と言わない", () => {
    expect(formatChapterRange(episodes.slice(0, 3), "sns")).toBe(
      "投稿1〜投稿3・3投稿"
    );
  });

  test("話が無ければ、範囲の代わりにその旨を出す", () => {
    expect(formatChapterRange([])).toBe("話がありません");
  });
});

describe("章ノードのID", () => {
  test("名前を含めない（改名で折りたたみの開閉が失われないように）", () => {
    const id = chapterNodeId("work_1", "本文/003.txt");

    expect(id).toContain("work_1");
    expect(id).toContain("本文/003.txt");
    expect(chapterNodeId("work_1", "本文/003.txt")).toBe(id);
  });

  test("作品が違えば別のID", () => {
    expect(chapterNodeId("work_1", "本文/003.txt")).not.toBe(
      chapterNodeId("work_2", "本文/003.txt")
    );
  });
});

/**
 * 目次の束ね名（設計書6.66.4の3）。
 *
 * 台帳があれば**台帳の章名が正**で、無ければファイル名由来の従来の束ね
 * （`episodeGroupLabel`）へ倒す。動いているものを壊さないための切り替えなので、
 * **両方の道を見張る。**
 */
describe("目次の束ね名（台帳が正）", () => {
  const chapters = [chapter("第一章　出立", "003.txt"), chapter("第二章　邂逅", "006.txt")];

  test("台帳があれば、章名で束ねる", () => {
    const labels = episodeGroupLabels(episodes, chapters, WORK_FOLDER);

    expect(labels.get("本文/003.txt")).toBe("第一章　出立");
    expect(labels.get("本文/005.txt")).toBe("第一章　出立");
    expect(labels.get("本文/006.txt")).toBe("第二章　邂逅");
  });

  test("最初の章より前の話は束ねない（章なしのまま先頭に並ぶ）", () => {
    const labels = episodeGroupLabels(episodes, chapters, WORK_FOLDER);

    // ここを「本編」で束ねると、台帳に無い章が本の目次に立つ
    expect(labels.get("本文/001.txt")).toBe("");
    expect(labels.get("本文/002.txt")).toBe("");
  });

  test("台帳が空なら、従来のファイル名由来の束ねのまま", () => {
    const labels = episodeGroupLabels(episodes, [], WORK_FOLDER);

    expect(labels.get("本文/001.txt")).toBe("本編");
    expect(labels.get("本文/008.txt")).toBe("本編");
  });

  test("開始の話が見つからない章では、その章に束ねない", () => {
    const labels = episodeGroupLabels(
      episodes,
      [chapter("第一章", "003.txt"), chapter("幻の章", "999.txt")],
      WORK_FOLDER
    );

    // 第3話以降は第一章のまま。指し先の無い章は誰も束ねない
    expect(labels.get("本文/008.txt")).toBe("第一章");
    expect([...labels.values()]).not.toContain("幻の章");
  });
});
