import { describe, expect, test } from "vitest";
import {
  countUnextracted,
  emptyExtractedIndex,
  hashEpisode,
  parseExtractedIndex,
  recordExtracted,
  shouldOfferExtraction,
} from "../../src/core/extractedIndex";

/**
 * 取り込んだ話を中身で覚える（設計書6.21.3）。
 *
 * 作者の指摘（2026-08-24）：「GitHubと同期する際、勝手に設定資料の
 * 再抽出が起きる」。**gitは更新時刻を保存しない**ので、時刻で比べると
 * 取り込んだ直後に全話が「未抽出」になっていた。
 */

const EPISODES = [
  { relativePath: "本文/001.txt", text: "むかしむかし" },
  { relativePath: "本文/002.txt", text: "あるところに" },
];

describe("取り込んだ話を覚える", () => {
  test("記録が無ければ、数を出さない", () => {
    // 登録した直後に「19話ぶん抽出しませんか」は催促である
    const result = countUnextracted(EPISODES, undefined);
    expect(result.extracted).toBe(false);
    expect(result.unextracted).toBeUndefined();
  });

  test("空の記録も、まだ抽出していない扱い", () => {
    const result = countUnextracted(EPISODES, emptyExtractedIndex());
    expect(result.extracted).toBe(false);
    expect(result.unextracted).toBeUndefined();
  });

  test("抽出した直後は、未抽出が0件", () => {
    const index = recordExtracted(emptyExtractedIndex(), EPISODES);
    expect(countUnextracted(EPISODES, index).unextracted).toBe(0);
  });

  /** ここが今回の直し。取り込みで時刻が変わっても中身は同じ */
  test("同期でファイルが書き直されても、中身が同じなら未抽出にならない", () => {
    const index = recordExtracted(emptyExtractedIndex(), EPISODES);
    // git pull で書き直された想定（中身は1文字も変わっていない）
    const afterPull = EPISODES.map((episode) => ({ ...episode }));
    expect(countUnextracted(afterPull, index).unextracted).toBe(0);
  });

  test("中身が変わった話だけを数える", () => {
    const index = recordExtracted(emptyExtractedIndex(), EPISODES);
    const edited = [
      EPISODES[0],
      { relativePath: "本文/002.txt", text: "あるところに、老人がいた" },
    ];
    expect(countUnextracted(edited, index).unextracted).toBe(1);
  });

  test("新しく足した話は未抽出", () => {
    const index = recordExtracted(emptyExtractedIndex(), EPISODES);
    const added = [...EPISODES, { relativePath: "本文/003.txt", text: "続き" }];
    expect(countUnextracted(added, index).unextracted).toBe(1);
  });

  /** 読めないファイルが1つあるだけで催促を始めない */
  test("読めなかった話は数えない", () => {
    const index = recordExtracted(emptyExtractedIndex(), EPISODES);
    const unreadable = [
      ...EPISODES,
      { relativePath: "本文/003.txt", text: undefined },
    ];
    expect(countUnextracted(unreadable, index).unextracted).toBe(0);
  });

  test("読めなかった話は、記録にも書かない", () => {
    const index = recordExtracted(emptyExtractedIndex(), [
      { relativePath: "本文/001.txt", text: undefined },
    ]);
    expect(index.files["本文/001.txt"]).toBeUndefined();
  });

  /** 話を減らしただけで、残りの記録まで失わない */
  test("前の記録は消さない", () => {
    const index = recordExtracted(emptyExtractedIndex(), EPISODES);
    const next = recordExtracted(index, [EPISODES[0]]);
    expect(next.files["本文/002.txt"]).toBe(hashEpisode(EPISODES[1].text));
  });
});

describe("記録の読み取り", () => {
  test("書いたものを読み戻せる", () => {
    const index = recordExtracted(emptyExtractedIndex(), EPISODES);
    const round = parseExtractedIndex(JSON.parse(JSON.stringify(index)));
    expect(round.files).toEqual(index.files);
  });

  /** 同期対象なので、競合マーカーや手編集で壊れることがある */
  test("壊れていたら空として扱う", () => {
    expect(parseExtractedIndex(undefined).files).toEqual({});
    expect(parseExtractedIndex("<<<<<<< HEAD").files).toEqual({});
    expect(parseExtractedIndex({ files: null }).files).toEqual({});
  });

  test("形の合わない項目だけを落とす", () => {
    const parsed = parseExtractedIndex({
      version: 1,
      files: { "本文/001.txt": "abc", "本文/002.txt": 12 },
    });
    expect(parsed.files).toEqual({ "本文/001.txt": "abc" });
  });
});

describe("申し出てよいか", () => {
  test("1話だけでは申し出ない", () => {
    expect(shouldOfferExtraction({ extracted: true, unextracted: 1 })).toBe(
      false
    );
  });

  test("2話からは申し出る", () => {
    expect(shouldOfferExtraction({ extracted: true, unextracted: 2 })).toBe(
      true
    );
  });

  test("一度も抽出していなければ申し出ない", () => {
    expect(
      shouldOfferExtraction({ extracted: false, unextracted: undefined })
    ).toBe(false);
  });
});
