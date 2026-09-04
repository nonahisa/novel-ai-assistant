import { describe, expect, test } from "vitest";
import {
  bookChapterBodies,
  bookChaptersOf,
} from "../../src/core/bookChapters";
import type { EpisodeFile } from "../../src/models/types";

/**
 * 本に入る章の切り分け（設計書6.65.15）。
 *
 * **合本は話ごとに割り、単話はいままでどおり1ファイル＝1章。**
 * 境目は `isCollectedFile`（2話以上）が決める——区切り行が1本だけの
 * ファイルは「1話ぶんのダウンロード」であって合本ではなく、頭書きの
 * 落とし方は `parseEpisodeMetadata` が持っている（段D）。
 */

function episode(overrides: Partial<EpisodeFile> = {}): EpisodeFile {
  return {
    filePath: "C:\\novels\\work\\本文\\全話.txt",
    fileName: "全話.txt",
    ext: ".txt",
    chapterStart: null,
    chapterEnd: null,
    subtitle: null,
    kind: "不明",
    isInitialName: false,
    counts: { total: 0, net: 0, noSpace: 0 },
    hasMetadata: false,
    metaTitle: null,
    declaredCharCount: null,
    metaUpdatedAt: null,
    hasConflictMarkers: false,
    collectedCount: null,
    ...overrides,
  };
}

const COLLECTED = [
  "------- エピソード1開始 -------",
  "【エピソードタイトル】",
  "１話　転生",
  "",
  "【本文】",
  "　朝が来た。",
  "",
  "【後書き】",
  "　ありがとうございます。",
  "",
  "------- エピソード2開始 -------",
  "【エピソードタイトル】",
  "２話　再会",
  "",
  "【本文】",
  "　昼が来た。",
].join("\n");

describe("合本は話ごとに割る", () => {
  test("2話ぶんの合本から、2つの章ができる", () => {
    const parts = bookChaptersOf(episode(), COLLECTED);

    expect(parts).toHaveLength(2);
    expect(parts[0].heading).toBe("第1話　転生");
    expect(parts[0].numberLabel).toBe("第1話");
    expect(parts[0].title).toBe("転生");
    expect(parts[0].body).toBe("　朝が来た。");
    expect(parts[0].insideOrder).toBe(1);
    expect(parts[1].heading).toBe("第2話　再会");
    expect(parts[1].body).toBe("　昼が来た。");
  });

  /** 数える言い方は作品の形式で変わる（SNS記事は「第3話」と言わない） */
  test("SNS記事の作品では「投稿3」と数える", () => {
    const parts = bookChaptersOf(episode(), COLLECTED, "sns");

    expect(parts[0].numberLabel).toBe("投稿1");
    expect(parts[0].heading).toBe("投稿1　転生");
  });

  /** **並び順を話数として出さない**（「プロローグ」を第1話と呼ばない） */
  test("話数の読めない話は、題だけを見出しにする", () => {
    const parts = bookChaptersOf(
      episode(),
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

    expect(parts[0].heading).toBe("プロローグ");
    expect(parts[0].numberLabel).toBe("");
    expect(parts[1].heading).toBe("第1話　転生");
  });

  /** 題も話数も無い塊は、どの塊なのかがファイル名と並び順で分かる */
  test("題も話数も無ければ、ファイル名と並び順に倒す", () => {
    const parts = bookChaptersOf(
      episode(),
      [
        "------- エピソード1開始 -------",
        "【本文】",
        "　雪が降る。",
        "",
        "------- エピソード2開始 -------",
        "【本文】",
        "　朝が来た。",
      ].join("\n")
    );

    expect(parts[0].heading).toBe("全話.txtの1番目");
    expect(parts[1].heading).toBe("全話.txtの2番目");
  });

  /** 白紙の章は本に入れない（開いても何も書いていないページになる） */
  test("本文の無い塊は章にしない", () => {
    const parts = bookChaptersOf(
      episode(),
      [
        "------- エピソード1開始 -------",
        "【エピソードタイトル】",
        "１話　転生",
        "",
        "【本文】",
        "",
        "------- エピソード2開始 -------",
        "【エピソードタイトル】",
        "２話　再会",
        "",
        "【本文】",
        "　昼が来た。",
      ].join("\n")
    );

    expect(parts).toHaveLength(1);
    expect(parts[0].heading).toBe("第2話　再会");
  });
});

/**
 * **単話は1文字も変えない**（回帰の固定）。合本を割る道を足したせいで、
 * いままで出ていた本が変わっては困る。
 */
describe("単話はいままでどおり1ファイル＝1章", () => {
  const single = episode({
    filePath: "C:\\novels\\work\\本文\\第1話 出会い.txt",
    fileName: "第1話 出会い.txt",
    chapterStart: 1,
    chapterEnd: 1,
    subtitle: "出会い",
    kind: "本編",
  });

  test("頭書きの無い原稿は、本文がそのまま章になる", () => {
    const text = "　朝が来た。\n\n　鐘が鳴る。\n";
    const parts = bookChaptersOf(single, text);

    expect(parts).toHaveLength(1);
    expect(parts[0].body).toBe(text);
    expect(parts[0].heading).toBe("第1話　出会い");
    expect(parts[0].insideOrder).toBe(null);
  });

  /**
   * **区切りが1本だけのファイルは合本ではない。** 1話ずつ別ファイルなのに
   * 区切り行が入っているダウンロードがあり、ここを合本として扱うと
   * 見出しの作り方が変わってしまう（段Dで入った切り出しの回帰）。
   */
  test("区切りが1本だけなら、単話として頭書きを外す", () => {
    const parts = bookChaptersOf(
      single,
      [
        "-------- エピソード1開始 --------",
        "【エピソードタイトル】",
        "１話　出会い",
        "",
        "【本文】",
        "　朝が来た。",
        "",
        "【後書き】",
        "　ありがとうございます。",
      ].join("\n")
    );

    expect(parts).toHaveLength(1);
    expect(parts[0].body).toBe("　朝が来た。");
    // 見出しは合本の作り方ではなく、単話の作り方（`bookHeading`）で決まる
    expect(parts[0].heading).toBe("第1話　出会い");
    expect(parts[0].insideOrder).toBe(null);
  });

  /** 本文が空でも章は1つ出る（単話の振る舞いを変えない） */
  test("空のファイルでも章は1つできる", () => {
    expect(bookChaptersOf(single, "")).toHaveLength(1);
  });
});

/**
 * 段落を数える側（EPUBエディターの位置指定）は本文だけを見る。
 * **組むときと同じ切り分けを通す**（設計書6.65.10）。
 */
describe("本文だけを取り出す", () => {
  test("合本は話ごと、単話は1つ", () => {
    expect(bookChapterBodies(COLLECTED)).toEqual(["　朝が来た。", "　昼が来た。"]);
    expect(bookChapterBodies("　朝が来た。")).toEqual(["　朝が来た。"]);
  });
});
