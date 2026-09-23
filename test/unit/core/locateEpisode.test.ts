import { describe, expect, test } from "vitest";
import {
  episodeNumberFromHint,
  resolveEpisodeByNumber,
} from "../../src/core/locateEpisode";

/**
 * 相談パネルの「そこを見せて」が、**存在しないファイルを開こうとした**
 * （2026-09-07の実機確認）。AIは `episode.4.txt` を指したが、作品にあるのは
 * `episode_0004.md` で、URLエンコードされた生のエラーが画面に出た。
 *
 * **ファイル名は当てずっぽうでも、話数は合っている。** そこを頼りに
 * 引き当てる。引き当てられないときは黙って開かない。
 */
describe("指されたファイル名から話数を読む", () => {
  test("実機で外したものを引き当てられる", () => {
    expect(episodeNumberFromHint("episode.4.txt")).toBe(4);
  });

  test("実在する名前の付け方も読める", () => {
    expect(episodeNumberFromHint("episode_0004.md")).toBe(4);
    expect(episodeNumberFromHint("第4話 再会.md")).toBe(4);
    expect(episodeNumberFromHint("004_湖畔の誓い.txt")).toBe(4);
    expect(episodeNumberFromHint("本文/第４話.txt")).toBe(4);
  });

  test("数字が2つ以上あるものは引き当てない（別の話を開くほうが悪い）", () => {
    // 投稿日で名付けたファイル（設計書6.4.6）と、合本
    expect(episodeNumberFromHint("2026-08-16.txt")).toBe(undefined);
    expect(episodeNumberFromHint("003-005_合本.txt")).toBe(undefined);
  });

  test("話数の手掛かりが無ければ引き当てない", () => {
    expect(episodeNumberFromHint("設定/plot.md")).toBe(undefined);
    expect(episodeNumberFromHint("")).toBe(undefined);
    expect(episodeNumberFromHint("episode_0000.md")).toBe(undefined);
  });
});

describe("話数から本物のファイルを探す", () => {
  const episodes = [
    { fileName: "episode_0003.md" },
    { fileName: "episode_0004.md" },
    { fileName: "プロローグ.txt" },
  ];

  test("一致が1つならそれを返す", () => {
    expect(resolveEpisodeByNumber(episodes, 4)?.fileName).toBe("episode_0004.md");
  });

  test("合本（範囲）の中に入っていれば当たる", () => {
    expect(
      resolveEpisodeByNumber([{ fileName: "003-005_合本.txt" }], 4)?.fileName
    ).toBe("003-005_合本.txt");
  });

  test("見つからなければ返さない", () => {
    expect(resolveEpisodeByNumber(episodes, 9)).toBe(undefined);
  });

  test("2つ当たったら返さない（どちらを指しているか決められない）", () => {
    const duplicated = [
      { fileName: "episode_0004.md" },
      { fileName: "004_旧版.txt" },
    ];
    expect(resolveEpisodeByNumber(duplicated, 4)).toBe(undefined);
  });
});

/**
 * 合本（1ファイルに全話）は、**ファイル名に話数が無い**ことがある
 * （`全話.txt`）。ファイル名からしか読んでいなかったころは、
 * 何話を指されても当たらなかった（2026-09-12）。
 *
 * 走査（`scanWork`）は中の各話のタイトルから話数を読んでいるので、
 * その値があればそちらを先に使う。
 */
describe("走査の話数があれば、そちらで当てる（合本）", () => {
  test("ファイル名に話数が無い合本でも、中の話に当たる", () => {
    const episodes = [
      { fileName: "全話.txt", chapterStart: 1, chapterEnd: 219 },
    ];
    expect(resolveEpisodeByNumber(episodes, 137)?.fileName).toBe("全話.txt");
    expect(resolveEpisodeByNumber(episodes, 1)?.fileName).toBe("全話.txt");
    expect(resolveEpisodeByNumber(episodes, 219)?.fileName).toBe("全話.txt");
  });

  test("範囲の外は当てない", () => {
    const episodes = [
      { fileName: "全話.txt", chapterStart: 1, chapterEnd: 219 },
    ];
    expect(resolveEpisodeByNumber(episodes, 220)).toBe(undefined);
  });

  test("終わりが無ければ、始まりの1話だけを受け持つ", () => {
    const episodes = [{ fileName: "無題.txt", chapterStart: 5, chapterEnd: null }];
    expect(resolveEpisodeByNumber(episodes, 5)?.fileName).toBe("無題.txt");
    expect(resolveEpisodeByNumber(episodes, 6)).toBe(undefined);
  });

  test("走査の値が無い要素は、これまでどおりファイル名から読む", () => {
    const episodes = [
      { fileName: "episode_0004.md", chapterStart: null, chapterEnd: null },
      { fileName: "プロローグ.txt" },
    ];
    expect(resolveEpisodeByNumber(episodes, 4)?.fileName).toBe(
      "episode_0004.md"
    );
  });

  test("合本と単話が同じ話数を受け持つなら返さない（既存の約束）", () => {
    const episodes = [
      { fileName: "全話.txt", chapterStart: 1, chapterEnd: 219 },
      { fileName: "episode_0137.md" },
    ];
    expect(resolveEpisodeByNumber(episodes, 137)).toBe(undefined);
  });
});
