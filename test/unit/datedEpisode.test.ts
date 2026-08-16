import { describe, expect, test } from "vitest";
import {
  nextDatedName,
  parseEpisodeFileName,
} from "../../src/core/episodeParser";
import { formatChapterLabel } from "../../src/core/episodeLabel";

/**
 * SNS記事は投稿日で管理する（設計書6.4.6、作者の指示 2026-08-16）。
 *
 * **1日に何本でも書ける。** 日付だけでは2本目のファイル名が作れないので、
 * 日付の後ろの数字を「その日の中での並び」として読む
 * （作者の指摘、2026-08-16）。
 */
describe("日付のファイル名を読む", () => {
  test("区切りのある日付を読む", () => {
    for (const name of ["2026-08-16.txt", "2026_08_16.txt", "2026.08.16.md"]) {
      expect(parseEpisodeFileName(name).date, name).toBe("2026-08-16");
    }
  });

  test("区切りの無い8桁も読む", () => {
    expect(parseEpisodeFileName("20260816.txt").date).toBe("2026-08-16");
  });

  test("1桁の月日も読む", () => {
    expect(parseEpisodeFileName("2026-8-6.txt").date).toBe("2026-08-06");
  });

  test("話数としては扱わない", () => {
    // 日付をそのまま話数にすると「第20260816話」になる
    const parsed = parseEpisodeFileName("2026-08-16.txt");

    expect(parsed.chapterStart).toBeNull();
    expect(parsed.chapterEnd).toBeNull();
  });

  test("実在しない日付は日付として扱わない", () => {
    // 単なる数字の羅列まで投稿日にしてしまう
    expect(parseEpisodeFileName("2026-13-01.txt").date).toBeNull();
    expect(parseEpisodeFileName("2026-02-30.txt").date).toBeNull();
  });

  test("8桁でない数字の並びは日付にしない", () => {
    // 話数の初期名（長い番号）まで日付にしかねない
    expect(parseEpisodeFileName("001.txt").date).toBeNull();
    expect(parseEpisodeFileName("0012025.txt").date).toBeNull();
  });

  test("従来の話数は今までどおり読む", () => {
    expect(parseEpisodeFileName("007_湖畔の誓い.txt").chapterStart).toBe(7);
    expect(parseEpisodeFileName("003-005_合本.txt").chapterEnd).toBe(5);
    expect(parseEpisodeFileName("プロローグ.txt").kind).toBe("プロローグ");
  });
});

describe("1日に何本も書く", () => {
  test("日付の後ろの数字は、その日の中での並び", () => {
    const parsed = parseEpisodeFileName("2026-08-16_2.txt");

    expect(parsed.date).toBe("2026-08-16");
    expect(parsed.dateSeq).toBe(2);
    // 並びの数字を題として出すと、一覧に「2」とだけ並ぶ
    expect(parsed.subtitle).toBeNull();
  });

  test("時刻を入れた形も並びとして読む", () => {
    const parsed = parseEpisodeFileName("2026-08-16_1230.txt");

    expect(parsed.date).toBe("2026-08-16");
    expect(parsed.dateSeq).toBe(1230);
  });

  test("並びと題を両方持てる", () => {
    const parsed = parseEpisodeFileName("2026-08-16_2_海辺の話.txt");

    expect(parsed.dateSeq).toBe(2);
    expect(parsed.subtitle).toBe("海辺の話");
  });

  test("題だけを付けた形も読む", () => {
    const parsed = parseEpisodeFileName("2026-08-16_海辺の話.txt");

    expect(parsed.dateSeq).toBeNull();
    expect(parsed.subtitle).toBe("海辺の話");
  });
});

describe("次のファイル名", () => {
  const today = "2026-08-16";
  const existing = (...names: string[]) => names.map(parseEpisodeFileName);

  test("その日がまだ無ければ日付だけ", () => {
    // 1本しか無い日に番号があると、「他にもあるのか」と探させる
    expect(nextDatedName(existing("2026-08-15.txt"), today)).toBe("2026-08-16");
  });

  test("1本あれば2本目になる", () => {
    expect(nextDatedName(existing("2026-08-16.txt"), today)).toBe(
      "2026-08-16_2"
    );
  });

  test("番号のあるものが並んでいれば、その次", () => {
    expect(
      nextDatedName(
        existing("2026-08-16.txt", "2026-08-16_2.txt", "2026-08-16_3.txt"),
        today
      )
    ).toBe("2026-08-16_4");
  });

  test("他の日のファイルは数に入れない", () => {
    expect(
      nextDatedName(existing("2026-08-15_5.txt", "2026-08-17.txt"), today)
    ).toBe("2026-08-16");
  });
});

describe("見出し", () => {
  function episode(fileName: string) {
    const parsed = parseEpisodeFileName(fileName);
    return {
      kind: parsed.kind,
      chapterStart: parsed.chapterStart,
      chapterEnd: parsed.chapterEnd,
      date: parsed.date,
      dateSeq: parsed.dateSeq,
    };
  }

  test("日付そのものが見出しになる", () => {
    expect(formatChapterLabel(episode("2026-08-16.txt"), "sns")).toBe(
      "2026-08-16"
    );
  });

  test("同じ日の2本目には並びを添える", () => {
    // 同じ見出しが2行並ぶと、どちらを開いたか分からない
    expect(formatChapterLabel(episode("2026-08-16_2.txt"), "sns")).toBe(
      "2026-08-16（2）"
    );
  });

  test("形式を決めていなくても、日付なら日付を出す", () => {
    // 日付で名付けたファイルは、SNS記事と決めていなくても日付である
    expect(formatChapterLabel(episode("2026-08-16.txt"))).toBe("2026-08-16");
  });
});
