import { describe, expect, test } from "vitest";
import {
  collectedEpisodeStarts,
  planCollectedStep,
} from "../../src/core/collectedFile";

/**
 * 合本（1ファイルに全話）の中を、前の話・次の話で移る（設計書6.25.5）。
 *
 * 作者の指示（2026-09-10）：「合本版で原稿エディターで次の話で、合本の中の
 * 次の話数へいってください。前の話も同様」。
 *
 * **画面が動いたかは実機でしか見えないが、どこへ飛ぶかはここで固める。**
 * 行番号が1つずれると、飛び先が見出しの行になったり、前の話の末尾に
 * なったりする——押した本人には「1話ぶん飛ばなかった」としか見えない。
 */

/** 3話ぶんの合本。改行はダウンロードファイルと同じ CRLF */
const sample = [
  "【タイトル】", // 1
  "見本の作品", // 2
  "", // 3
  "------------------------- エピソード1開始 -------------------------", // 4
  "【エピソードタイトル】", // 5
  "１話　転生", // 6
  "", // 7
  "【本文】", // 8
  "　化学の先生が、授業中に無駄話をしていた。", // 9
  "", // 10
  "【後書き】", // 11
  "　読んでいただきありがとうございます。", // 12
  "", // 13
  "------------------------- エピソード2開始 -------------------------", // 14
  "【エピソードタイトル】", // 15
  "２話　てこの原理と救助", // 16
  "", // 17
  "【本文】", // 18
  "　何の気配もないところから急に声がした。", // 19
  "", // 20
  "------------------------- エピソード3開始 -------------------------", // 21
  "【エピソードタイトル】", // 22
  "３話　再会", // 23
  "", // 24
  "【本文】", // 25
  "　三度目の朝が来た。", // 26
].join("\r\n");

describe("合本の中の、話の入口", () => {
  test("話の数だけ返し、飛び先は【本文】の次の行", () => {
    expect(collectedEpisodeStarts(sample)).toEqual([
      { order: 1, line: 9 },
      { order: 2, line: 19 },
      { order: 3, line: 26 },
    ]);
  });

  test("【本文】が無い話は、区切り行の次へ落とす", () => {
    const text = [
      "----- エピソード1開始 -----", // 1
      "　いきなり本文が始まる作りのファイル", // 2
      "----- エピソード2開始 -----", // 3
      "　二話目", // 4
    ].join("\n");

    expect(collectedEpisodeStarts(text)).toEqual([
      { order: 1, line: 2 },
      { order: 2, line: 4 },
    ]);
  });

  /** 1話しか無いものを合本として扱うと、ファイルの外へ出られなくなる */
  test("区切りが1つしか無ければ、合本として扱わない", () => {
    const text = [
      "----- エピソード1開始 -----",
      "【本文】",
      "　ひとつだけ",
    ].join("\n");

    expect(collectedEpisodeStarts(text)).toEqual([]);
  });

  test("区切りが無い、ふつうの原稿は空", () => {
    expect(collectedEpisodeStarts("　ふつうの本文。\n　続き。")).toEqual([]);
  });
});

describe("合本の中で、前後の話へ移る", () => {
  const starts = collectedEpisodeStarts(sample);

  test("話の途中から「次の話」で、次の話の本文の頭へ", () => {
    // 12行目＝1話の後書き。それでも「いま居るのは1話」と読む
    expect(
      planCollectedStep({ starts, caretLine: 12, direction: "next" })
    ).toEqual({ kind: "reveal", line: 19 });
  });

  test("話の途中から「前の話」で、いまの話の頭ではなく前の話へ", () => {
    expect(
      planCollectedStep({ starts, caretLine: 20, direction: "prev" })
    ).toEqual({ kind: "reveal", line: 9 });
  });

  test("話の先頭行ちょうどでも、「前の話」は前の話へ", () => {
    expect(
      planCollectedStep({ starts, caretLine: 26, direction: "prev" })
    ).toEqual({ kind: "reveal", line: 19 });
  });

  test("最後の話で「次の話」は、ファイルの外へ出る", () => {
    expect(
      planCollectedStep({ starts, caretLine: 26, direction: "next" })
    ).toEqual({ kind: "leave" });
  });

  test("最初の話の途中で「前の話」は、ファイルの外へ出る", () => {
    expect(
      planCollectedStep({ starts, caretLine: 12, direction: "prev" })
    ).toEqual({ kind: "leave" });
  });

  /** 区切り行と【本文】のあいだ（章題やタイトル）に居ることがある */
  test("1話目の頭書きに居るときは、1話目に居るものとして扱う", () => {
    expect(
      planCollectedStep({ starts, caretLine: 5, direction: "next" })
    ).toEqual({ kind: "reveal", line: 19 });
    expect(
      planCollectedStep({ starts, caretLine: 5, direction: "prev" })
    ).toEqual({ kind: "leave" });
  });

  /** 組んで書く面では、選択が取れずカーソル行が0で届くことがある */
  test("カーソル行が読めなければ、1話目に居るものとして扱う", () => {
    expect(
      planCollectedStep({ starts, caretLine: 0, direction: "next" })
    ).toEqual({ kind: "reveal", line: 19 });
    expect(
      planCollectedStep({ starts, caretLine: 0, direction: "prev" })
    ).toEqual({ kind: "leave" });
  });

  test("合本でなければ、いつでもファイルの外へ出る", () => {
    expect(
      planCollectedStep({ starts: [], caretLine: 3, direction: "next" })
    ).toEqual({ kind: "leave" });
  });
});
