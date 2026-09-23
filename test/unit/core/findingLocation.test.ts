import { describe, expect, test } from "vitest";
import {
  locateFinding,
  locateFindings,
} from "../../src/core/findingLocation";
import type { Finding } from "../../src/models/finding";

/**
 * 残した指摘の位置を、開くたびに探し直す（設計書6.96.3）。
 *
 * **行番号を鍵にしない。** 三日ぶんの編集に耐えるため、原文を本文から
 * 探し直す。結末は3つしかない——**見つかった**（そのまま出す）／
 * **動いた**（位置を更新して出す）／**消えた**（その指摘を捨てる）。
 */

/** 3行目に原文が在る本文 */
const text = [
  "　朝の廊下は静かだった。", // 1
  "", // 2
  "　彼女は振り返らなかった。", // 3
  "", // 4
  "　窓の外で鐘が鳴る。", // 5
].join("\n");

function finding(overrides: Partial<Finding> = {}): Finding {
  const base: Finding = {
    id: "f1",
    time: "2026-09-19T09:00:00.000Z",
    file: "本文/episode_0001.txt",
    hintLine: 3,
    original: "　彼女は振り返らなかった。",
    target: "振り返らなかった",
    suggestion: "振りかえらなかった",
    before: "　朝の廊下は静かだった。",
    after: "　窓の外で鐘が鳴る。",
    message: "送り仮名",
    category: "typo",
    label: "誤字脱字",
  };
  return { ...base, ...overrides };
}

describe("3つの結末", () => {
  test("見つかった——保存してあった行に、そのまま在る", () => {
    expect(locateFinding(finding(), text)).toEqual({
      status: "found",
      line: 3,
    });
  });

  test("動いた——前に2行足されていれば、新しい行を返す", () => {
    const grown = ["追加1", "追加2", ...text.split("\n")].join("\n");

    expect(locateFinding(finding(), grown)).toEqual({
      status: "moved",
      line: 5,
    });
  });

  test("動いた——前が削られていても、新しい行を返す", () => {
    const shrunk = ["　彼女は振り返らなかった。", "　窓の外で鐘が鳴る。"].join(
      "\n"
    );

    expect(locateFinding(finding(), shrunk)).toEqual({
      status: "moved",
      line: 1,
    });
  });

  /** **当て推量で置かない**（6.96.6）。存在しない場所を指す指摘は害しかない */
  test("消えた——作者が直してしまえば、原文はもう本文に無い", () => {
    const fixed = text.replace(
      "　彼女は振り返らなかった。",
      "　彼女は振りかえらなかった。"
    );

    expect(locateFinding(finding(), fixed)).toEqual({ status: "lost" });
  });

  test("消えた——その話ごと書き直されていても、捨てるだけ", () => {
    expect(locateFinding(finding(), "まるごと別の本文です。")).toEqual({
      status: "lost",
    });
  });

  /** 原文が空なら、どの行にも「在る」ことになってしまう */
  test("消えた——原文が空の指摘は、位置を決めない", () => {
    expect(locateFinding(finding({ original: "" }), text)).toEqual({
      status: "lost",
    });
  });
});

describe("前後の文脈で絞る", () => {
  /**
   * **同じ語が何度も出る作品**でどれかを特定するために持っている
   * （6.96.3）。数日たつと `hintLine` は当てにならないので、
   * **近さだけでは近くの別の一致を採ってしまう。**
   */
  const twice = [
    "　夜の教室は静かだった。", // 1
    "　彼女は振り返らなかった。", // 2  ← こちらが本命
    "　鍵の音が響く。", // 3
    "　朝の廊下は騒がしかった。", // 4
    "　彼女は振り返らなかった。", // 5
    "　誰も呼び止めなかった。", // 6
  ].join("\n");

  test("文脈が合うほうを採る（行番号が近いのは別のほうでも）", () => {
    const located = locateFinding(
      finding({
        hintLine: 5, // 近いのは5行目だが、前後の本文は2行目のもの
        before: "　夜の教室は静かだった。",
        after: "　鍵の音が響く。",
      }),
      twice
    );

    expect(located).toEqual({ status: "moved", line: 2 });
  });

  test("前だけしか持っていなくても絞れる", () => {
    expect(
      locateFinding(
        finding({ hintLine: 5, before: "　夜の教室は静かだった。", after: "" }),
        twice
      )
    ).toEqual({ status: "moved", line: 2 });
  });

  test("後ろだけしか持っていなくても絞れる", () => {
    expect(
      locateFinding(
        finding({ hintLine: 2, before: "", after: "　誰も呼び止めなかった。" }),
        twice
      )
    ).toEqual({ status: "moved", line: 5 });
  });

  /**
   * **文脈のほうが古びていることもある。** 合う候補が1つも無いからと
   * いって「消えた」ことにはしない——原文は在るのだから、近さで決める。
   */
  test("文脈がどれにも合わなければ、近さで決める（捨てない）", () => {
    expect(
      locateFinding(
        finding({
          hintLine: 5,
          before: "いまはもう無い一行",
          after: "これも無い",
        }),
        twice
      )
      // 近いのは5行目。文脈で絞れなくても「消えた」にはしない
    ).toEqual({ status: "found", line: 5 });
  });

  /** 原稿は段落の間に空行を挟む。隣をそのまま見ると空文字どうしで当たる */
  test("段落の間の空行は飛ばして、中身のある隣の行と比べる", () => {
    const spaced = [
      "　朝の廊下は静かだった。", // 1
      "",
      "　彼女は振り返らなかった。", // 3
      "",
      "　窓の外で鐘が鳴る。", // 5
      "",
      "　朝の廊下は静かだった。", // 7
      "",
      "　彼女は振り返らなかった。", // 9
      "",
      "　別の一行。", // 11
    ].join("\n");

    expect(
      locateFinding(
        finding({ hintLine: 9, after: "　窓の外で鐘が鳴る。" }),
        spaced
      )
    ).toEqual({ status: "moved", line: 3 });
  });
});

describe("まとめて位置を決める", () => {
  const texts = new Map([["本文/episode_0001.txt", text]]);

  test("消えたものは返らない", () => {
    const located = locateFindings(
      [
        finding({ id: "在る" }),
        finding({ id: "消えた", original: "本文のどこにも無い一文" }),
      ],
      texts
    );

    expect(located.map((entry) => entry.id)).toEqual(["在る"]);
  });

  /**
   * **本文が渡されていないファイルは、まだ見ていないだけである。**
   * 「消えた」と同じ扱いにすると、開いていない話の指摘が
   * 画面から永久に落ちる。
   */
  test("本文を渡していないファイルの指摘は、返らない（が捨ててもいない）", () => {
    const all = [finding({ file: "本文/episode_0009.txt" })];

    expect(locateFindings(all, texts)).toEqual([]);
    expect(all).toHaveLength(1);
  });

  /** **話数 → 行の順**（6.96.5）。種類では分けない */
  test("話数、そのなかは行の順に並ぶ", () => {
    const second = ["別の話の1行目", "　彼女は振り返らなかった。"].join("\n");
    const located = locateFindings(
      [
        finding({ id: "二話目", file: "本文/episode_0002.txt", hintLine: 2 }),
        finding({ id: "一話目の後ろ", original: "　窓の外で鐘が鳴る。" }),
        finding({ id: "一話目の前", original: "　朝の廊下は静かだった。" }),
      ],
      new Map([
        ["本文/episode_0001.txt", text],
        ["本文/episode_0002.txt", second],
      ])
    );

    expect(located.map((entry) => entry.id)).toEqual([
      "一話目の前",
      "一話目の後ろ",
      "二話目",
    ]);
  });
});
