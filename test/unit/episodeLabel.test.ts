import { describe, it, expect } from "vitest";
import {
  bookHeading,
  episodeGroupLabel,
  isCollectedFile,
} from "../../src/core/episodeLabel";
import type { EpisodeFile } from "../../src/models/types";

/** 見出しの材料。話数と種別だけを見るので、残りは空でよい */
function episode(patch: Partial<EpisodeFile>): EpisodeFile {
  return {
    filePath: "C:\\novels\\work\\001.txt",
    fileName: "001.txt",
    ext: ".txt",
    chapterStart: null,
    chapterEnd: null,
    subtitle: null,
    kind: "本編",
    isInitialName: false,
    counts: {
      gross: 0,
      net: 0,
      lines: 0,
      paragraphs: 0,
      manuscriptLines: 0,
    },
    hasMetadata: false,
    metaTitle: null,
    declaredCharCount: null,
    metaUpdatedAt: null,
    hasConflictMarkers: false,
    collectedCount: null,
    ...patch,
  };
}

describe("本に出す見出し（EPUB・設計書6.65）", () => {
  it("話数と題を並べる", () => {
    expect(
      bookHeading(episode({ chapterStart: 1, subtitle: "出会い" }), undefined)
    ).toBe("第1話　出会い");
  });

  it("題に話数が含まれていても二重にしない", () => {
    // 投稿サイトのDLは「第1話 気がついたら幽霊に」の形で題を持つ
    expect(
      bookHeading(
        episode({ chapterStart: 1, metaTitle: "第1話 気がついたら幽霊に" }),
        undefined
      )
    ).toBe("第1話　気がついたら幽霊に");
  });

  it("何も読み取れなければファイル名にする（無題の面を作らない）", () => {
    expect(bookHeading(episode({ fileName: "メモ.txt" }), undefined)).toBe(
      "メモ.txt"
    );
  });

  /**
   * EPUBの目次で「第1話　第001話 ◯◯」と二重に出た不具合（設計書6.65.15、
   * 作者の報告2026-09-03）。投稿サイトのDLは題にゼロ埋め・全角の話数を
   * 持つことがあり、章ラベル（半角・ゼロ埋め無し）とは文字列として
   * 一致しないため、以前の実装（`raw.startsWith(chapterLabel)`）は
   * 見逃していた。
   */
  it("題の話数がゼロ埋めでも二重にしない", () => {
    expect(
      bookHeading(
        episode({ chapterStart: 1, metaTitle: "第001話　気がついたら幽霊に" }),
        undefined
      )
    ).toBe("第1話　気がついたら幽霊に");
  });

  it("題の話数が全角でも二重にしない", () => {
    expect(
      bookHeading(
        episode({ chapterStart: 1, metaTitle: "第１話　気がついたら幽霊に" }),
        undefined
      )
    ).toBe("第1話　気がついたら幽霊に");
  });

  it("違う話数を指す題は剥がさない（第1話から第12話の題を誤って削らない）", () => {
    expect(
      bookHeading(
        episode({ chapterStart: 1, metaTitle: "第12話から続く騒動" }),
        undefined
      )
    ).toBe("第1話　第12話から続く騒動");
  });
});

describe("目次を章ごとに区切るときの束ね名（設計書6.65.6）", () => {
  it("プロローグ・幕間・エピローグは、それ自体が束ねの名前になる", () => {
    expect(episodeGroupLabel(episode({ kind: "プロローグ" }))).toBe(
      "プロローグ"
    );
    expect(episodeGroupLabel(episode({ kind: "幕間", chapterStart: 1 }))).toBe(
      "幕間"
    );
    expect(episodeGroupLabel(episode({ kind: "エピローグ" }))).toBe(
      "エピローグ"
    );
  });

  it("本編はひとまとめ", () => {
    expect(episodeGroupLabel(episode({ kind: "本編", chapterStart: 3 }))).toBe(
      "本編"
    );
  });

  it("日付で名付けられたものは月ごとに束ねる", () => {
    // SNS記事は続きものではない。月で切るのが読み手の探し方に近い
    expect(episodeGroupLabel(episode({ date: "2026-08-16", dateSeq: 2 }))).toBe(
      "2026年8月"
    );
  });

  it("話数も種別も分からなければ束ねない（章を捏造しない）", () => {
    expect(episodeGroupLabel(episode({ kind: "不明" }))).toBe("");
  });
});

describe("isCollectedFile", () => {
  it("2話以上なら合本として扱う", () => {
    expect(isCollectedFile(2)).toBe(true);
    expect(isCollectedFile(219)).toBe(true);
  });

  it("1話しか入っていないものは合本ではない", () => {
    // 投稿サイトのダウンロードには、1話ずつ別ファイルなのに区切り行
    //（エピソードN開始）が入っている形がある。`parseCollectedFile` は
    // 区切り行が1つでもあれば話に分けて返すので、全ファイルに
    //「1話ぶん」の印が付いていた（2026-08-21、作者が実機で気づいた）
    expect(isCollectedFile(1)).toBe(false);
  });

  it("合本でないファイルは印を付けない", () => {
    expect(isCollectedFile(null)).toBe(false);
    expect(isCollectedFile(undefined)).toBe(false);
    expect(isCollectedFile(0)).toBe(false);
  });
});
