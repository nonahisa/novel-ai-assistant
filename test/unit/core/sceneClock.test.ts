import { describe, expect, it } from "vitest";
import {
  buildSceneClock,
  CALENDAR_CHAIN,
  readHeadMarker,
} from "../../../src/core/sceneClock";

/**
 * 本文の語と日付から読む時計（設計書6.88。移動の照合の材料）。
 *
 * **小さな語彙だけを読み、分からないところは鎖を切る。** 推し量った経過で
 * 矛盾を出すと、作者は本文ではなくこちらの推測を直しに行く。
 */

function clockOf(...texts: string[]) {
  return buildSceneClock(
    texts.map((text, index) => ({
      filePath: `${index + 1}.txt`,
      chapter: index + 1,
      text,
    }))
  );
}

describe("段落の頭の印", () => {
  it("同じ時・次の日・N日後・鎖を切る語・同じ日を読み分ける", () => {
    expect(readHeadMarker("その頃、リナは港町にいた。")).toEqual({ kind: "simultaneous" });
    expect(readHeadMarker("　同じ頃、")).toEqual({ kind: "simultaneous" });
    expect(readHeadMarker("翌朝、エドは")).toEqual({ kind: "advance", days: 1 });
    expect(readHeadMarker("翌々日、")).toEqual({ kind: "advance", days: 2 });
    expect(readHeadMarker("三日後、")).toEqual({ kind: "advance", days: 3 });
    expect(readHeadMarker("１２日後、")).toEqual({ kind: "advance", days: 12 });
    expect(readHeadMarker("数日後、")).toEqual({ kind: "cut" });
    expect(readHeadMarker("しばらくして、")).toEqual({ kind: "cut" });
    expect(readHeadMarker("三年後、")).toEqual({ kind: "cut" });
    expect(readHeadMarker("その夜、")).toEqual({ kind: "sameDay" });
    expect(readHeadMarker("エドは歩いた。")).toBeNull();
  });
});

describe("時計", () => {
  it("区切りのあとの「翌朝」は、前の場面から1日進める", () => {
    const clock = clockOf("　エドは王都にいた。\n\n　＊\n\n　翌朝、エドは港町に着いた。");
    const before = clock.readingAt("1.txt", 1);
    const after = clock.readingAt("1.txt", 5);
    expect(before?.chain).toBe(after?.chain);
    expect(before?.segment).not.toBe(after?.segment);
    expect([after?.dayLow, after?.dayHigh]).toEqual([1, 1]);
  });

  it("「その頃」は前の場面と同じ幅", () => {
    const clock = clockOf("　王都。\n　＊\n　その頃、港町では。");
    expect(clock.readingAt("1.txt", 3)).toMatchObject({ dayLow: 0, dayHigh: 0 });
    expect(clock.readingAt("1.txt", 3)?.chain).toBe(clock.readingAt("1.txt", 1)?.chain);
  });

  /** 印の無い時間の飛び。何日飛んだか分からない */
  it("区切りのあとに印が無ければ鎖を切る", () => {
    const clock = clockOf("　港町にいた。\n　＊\n　王都に戻った。");
    expect(clock.readingAt("1.txt", 3)?.chain).not.toBe(
      clock.readingAt("1.txt", 1)?.chain
    );
    expect(clock.stats.unmarkedBreaks).toBe(1);
  });

  it("「数日後」は鎖を切る", () => {
    const clock = clockOf("　港町にいた。\n　＊\n　数日後、王都に戻った。");
    expect(clock.readingAt("1.txt", 3)?.chain).not.toBe(
      clock.readingAt("1.txt", 1)?.chain
    );
  });

  /** 作者の作品は段落ごとに空行を入れる。空行で切ると鎖が段落ごとに切れる */
  it("空行は区切りにしない", () => {
    const clock = clockOf("　港町にいた。\n\n\n　市場を歩いた。");
    expect(clock.readingAt("1.txt", 4)?.segment).toBe(
      clock.readingAt("1.txt", 1)?.segment
    );
  });

  /** 場面の途中で時が進んだら、その場面の終わりは読めない */
  it("場面の途中に経過の語があれば、次の「翌朝」は数えない", () => {
    const clock = clockOf("　港町を発ち、三日かけて王都に着いた。\n　＊\n　翌朝、港町に着いた。");
    expect(clock.readingAt("1.txt", 3)?.chain).not.toBe(
      clock.readingAt("1.txt", 1)?.chain
    );
  });

  /** 旅の台で「騎士団に入って三年目」が鎖を切っていた（身の上の説明は経過ではない） */
  it("「三年目の春」「三年間」は場面の中の経過にしない", () => {
    const clock = clockOf(
      "　騎士団に入って三年目の春だった。三年間、門に立った。\n　＊\n　その頃、港町では。"
    );
    expect(clock.readingAt("1.txt", 3)?.chain).toBe(
      clock.readingAt("1.txt", 1)?.chain
    );
  });

  it("台詞の中の経過の語は、地の文の時ではない", () => {
    const clock = clockOf("　王都にいた。\n　「三日後に来い」\n　＊\n　翌朝、港町。");
    expect(clock.readingAt("1.txt", 4)?.chain).toBe(
      clock.readingAt("1.txt", 1)?.chain
    );
  });

  it("日付の読めた話は暦の鎖に載り、その日のうちの幅を1日持つ", () => {
    const clock = clockOf("　四月二日、王都。", "　四月九日、港町。");
    expect(clock.readingAt("1.txt", 1)).toMatchObject({
      chain: CALENDAR_CHAIN,
      dayLow: 0,
      dayHigh: 1,
    });
    expect(clock.readingAt("2.txt", 1)).toMatchObject({
      chain: CALENDAR_CHAIN,
      dayLow: 7,
      dayHigh: 8,
    });
    expect(clock.stats.datedEpisodes).toBe(2);
  });

  it("次の話が「翌朝」で始まれば、前の話の続きとして数える", () => {
    const clock = clockOf("　王都にいた。", "　翌朝、港町に着いた。");
    expect(clock.readingAt("2.txt", 1)?.chain).toBe(
      clock.readingAt("1.txt", 1)?.chain
    );
    expect(clock.readingAt("2.txt", 1)).toMatchObject({ dayLow: 1, dayHigh: 1 });
  });

  /** 間の話が渡っていない（話を絞った実行）のに続けて数えると、抜けた話の日数を落とす */
  it("話数が飛んでいれば、前の話の続きにしない", () => {
    const clock = buildSceneClock([
      { filePath: "1.txt", chapter: 1, text: "　王都にいた。" },
      { filePath: "3.txt", chapter: 3, text: "　翌朝、港町に着いた。" },
    ]);
    expect(clock.readingAt("3.txt", 1)?.chain).not.toBe(
      clock.readingAt("1.txt", 1)?.chain
    );
  });

  it("合本の話の見出しは区切りとして扱う", () => {
    const clock = clockOf("第1話　出発\n　王都にいた。\n第2話　港\n　港町にいた。");
    expect(clock.readingAt("1.txt", 4)?.chain).not.toBe(
      clock.readingAt("1.txt", 2)?.chain
    );
  });

  it("CRLF の本文でも行がずれない", () => {
    const clock = clockOf("　王都にいた。\r\n　＊\r\n　翌朝、港町。");
    expect(clock.readingAt("1.txt", 3)).toMatchObject({ dayLow: 1, dayHigh: 1 });
  });
});
