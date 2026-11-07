import { describe, expect, test } from "vitest";
import { castChunkSpeakerSequence, castFlowNames, validateCastSpeakers } from "../../../src/core/voiceCast";

/**
 * 案 C「掛け合いの流れを渡す」（設計書6.42.3・P-54 版1.4）。
 *
 * 1段目（話者）で区切りを訊くとき、すぐ前の区切りまでに決まった話者の名前を
 * 直前の数件だけ添える。流れを組むのはコード（ここ）で、頼み方は名前の列を受け取るだけ。
 */

const nameOf = new Map([
  ["c-akari", "灯"],
  ["c-ren", "蓮"],
]);

describe("流れに添える名前", () => {
  test("直前の上限の件数だけを、古い順に名前で返す", () => {
    const history = ["c-akari", "c-ren", "c-akari", "c-ren", "c-akari", "c-ren", "c-akari"];
    expect(castFlowNames(history, nameOf, 5)).toEqual(["灯", "蓮", "灯", "蓮", "灯"]);
    expect(castFlowNames(history, nameOf, 2)).toEqual(["蓮", "灯"]);
  });

  test("決まらなかった台詞は抜かずに「不明」と書く（抜くと、実際より交互に話しているように見える）", () => {
    expect(castFlowNames(["c-akari", null, "c-ren"], nameOf, 5)).toEqual(["灯", "不明", "蓮"]);
  });

  test("資料に無い id（消した人物）も「不明」にする", () => {
    expect(castFlowNames(["c-akari", "c-gone"], nameOf, 5)).toEqual(["灯", "不明"]);
  });

  test("添える範囲が全部「不明」なら、何も添えない（手がかりにならない）", () => {
    expect(castFlowNames([null, null], nameOf, 5)).toEqual([]);
    // 古い所に名前があっても、上限の外なら添えない
    expect(castFlowNames(["c-akari", null, null], nameOf, 2)).toEqual([]);
    expect(castFlowNames([], nameOf, 5)).toEqual([]);
  });
});

describe("区切りの話者の並び（流れへ足す分）", () => {
  const chunk = {
    dialogues: [0, 1, 2, 3].map((index) => ({ index: index + 10, start: 0, end: 0, quote: `「${index}」`, nth: 0 })),
    decided: new Map([[2, "c-ren"]]),
  };

  test("作者が直した行 → 本文に書いてあった話者 → 1段目の答え の順で決める。無ければ不明", () => {
    const ai = new Map<number, string | null>([
      [1, "c-akari"],
      [2, "c-akari"], // コードで決めた番号への答えは使わない
      [3, null],
    ]);
    // 作者の行は話の通し番号（dialogue.index）で引く。作者が「不明」に直した行も確かな答え
    const author = new Map<number, string | null>([[13, "c-akari"]]);
    expect(castChunkSpeakerSequence(chunk, ai, author)).toEqual(["c-akari", "c-ren", null, "c-akari"]);
    expect(castChunkSpeakerSequence(chunk, undefined)).toEqual([null, "c-ren", null, null]);
    expect(castChunkSpeakerSequence(chunk, ai, new Map([[11, null]]))).toEqual(["c-akari", null, null, null]);
  });
});

describe("流れの指示の言葉が答えに返ったとき", () => {
  test("「流れ」「前の話者」は、資料に無い名前ではなく指示の言葉として数える（失敗3番）", () => {
    const people = [{ id: "c-akari", name: "灯", aliases: [], speechStyle: null }];
    const { dropped } = validateCastSpeakers(
      [
        { number: 1, speaker: "前の話者" },
        { number: 2, speaker: "流れ" },
      ],
      2,
      people
    );
    expect(dropped.map((d) => d.reason)).toEqual(["話者が指示の言葉のまま", "話者が指示の言葉のまま"]);
  });
});
