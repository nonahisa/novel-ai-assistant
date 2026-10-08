import { describe, expect, test } from "vitest";
import type { Chunk } from "../../../src/core/chunker";
import { validateExtractedLocations } from "../../../src/core/settingsExtractionValidation";

/**
 * 場所の位置関係の検算（設計書6.93.3。実装ルール3）。
 *
 * **見逃しと誤検出の両方を見る**——本文にある関係は通り、本文に無い関係・
 * 離れた文をつないだ引用・指示の言葉がそのまま返ったものは落ちる。
 * 関係が落ちても場所そのものは残ることも見る。
 */

const text = [
  "港町の外れに港がある。",
  "学校は港の北に建っている。",
  "港から学校までは徒歩10分ほどだ。",
  "灯台は防波堤に隣接している。",
  "夕方、鐘が鳴った。",
].join("\n");

const chunk: Chunk = {
  filePath: "003.txt",
  index: 0,
  text,
  startLine: 0,
  hash: "fixture",
  chapterStart: 3,
  chapterEnd: 3,
};

function school(relations: unknown[]): unknown[] {
  return [
    {
      name: "学校",
      evidence: "学校は港の北に建っている",
      relations,
    },
  ];
}

function relationsOf(raw: unknown[]) {
  const result = validateExtractedLocations(raw, chunk);
  return {
    accepted: result.accepted,
    relations: result.accepted[0]?.data.relations ?? [],
    rejected: result.rejected,
  };
}

describe("本文にある関係は通す", () => {
  test("方角・距離・含む・隣接を受け取る", () => {
    const { relations, rejected } = relationsOf([
      {
        name: "学校",
        evidence: "学校は港の北に建っている",
        relations: [
          { target: "港", kind: "direction", value: "北", evidence: "学校は港の北に建っている。" },
          { target: "港", kind: "distance", value: "徒歩10分", evidence: "港から学校までは徒歩10分ほどだ" },
        ],
      },
      {
        name: "灯台",
        evidence: "灯台は防波堤に隣接している",
        relations: [
          { target: "防波堤", kind: "adjacent", value: null, evidence: "灯台は防波堤に隣接している" },
        ],
      },
      {
        name: "港",
        evidence: "港町の外れに港がある",
        relations: [
          { target: "港町", kind: "within", value: "外れ", evidence: "「港町の外れに港がある」" },
        ],
      },
    ]);

    expect(rejected).toEqual([]);
    expect(relations).toEqual([
      { target: "港", kind: "direction", value: "北", evidence: "学校は港の北に建っている。", chapters: [3] },
      { target: "港", kind: "distance", value: "徒歩10分", evidence: "港から学校までは徒歩10分ほどだ", chapters: [3] },
    ]);
  });

  test("含む・隣接の値は持たない（AIが入れてきても捨てる）", () => {
    const result = validateExtractedLocations(
      [
        {
          name: "港",
          evidence: "港町の外れに港がある",
          relations: [
            { target: "港町", kind: "within", value: "外れ", evidence: "港町の外れに港がある" },
          ],
        },
      ],
      chunk
    );
    expect(result.accepted[0].data.relations).toEqual([
      { target: "港町", kind: "within", value: null, evidence: "港町の外れに港がある", chapters: [3] },
    ]);
  });
});

describe("本文に無い関係は落とす（場所は残す）", () => {
  test("離れた2文をつないだ引用は落とす", () => {
    const { accepted, relations, rejected } = relationsOf(
      school([
        {
          target: "港",
          kind: "distance",
          value: "徒歩10分",
          // 2文とも本文にあるが、あいだに1文あって続いてはいない
          evidence: "港町の外れに港がある。港から学校までは徒歩10分ほどだ。",
        },
      ])
    );
    expect(accepted).toHaveLength(1);
    expect(relations).toEqual([]);
    expect(rejected).toEqual([
      { name: "学校の位置関係（港）", reason: "ungrounded_relation" },
    ]);
  });

  test("隣り合う2文は一続きの引用として通す（改行は区切りにしない）", () => {
    const { relations } = relationsOf(
      school([
        {
          target: "港",
          kind: "direction",
          value: "北",
          evidence: "港町の外れに港がある。学校は港の北に建っている。",
        },
      ])
    );
    expect(relations).toHaveLength(1);
  });

  test("本文に無い引用は落とす", () => {
    const { relations } = relationsOf(
      school([
        { target: "港", kind: "direction", value: "南", evidence: "学校は港の南に建っている" },
      ])
    );
    expect(relations).toEqual([]);
  });

  test("引用が相手を名指ししていなければ落とす", () => {
    const { relations } = relationsOf(
      school([
        // 引用は本文にあるが、相手（灯台）の話ではない
        { target: "灯台", kind: "direction", value: "北", evidence: "学校は港の北に建っている" },
      ])
    );
    expect(relations).toEqual([]);
  });

  test("値が引用の中に無ければ落とす", () => {
    const { relations } = relationsOf(
      school([
        { target: "港", kind: "distance", value: "徒歩1時間", evidence: "港から学校までは徒歩10分ほどだ" },
      ])
    );
    expect(relations).toEqual([]);
  });

  test("自分自身を相手にした関係は落とす", () => {
    const { relations } = relationsOf(
      school([
        { target: "学校", kind: "direction", value: "北", evidence: "学校は港の北に建っている" },
      ])
    );
    expect(relations).toEqual([]);
  });

  test("指示語の相手は落とす", () => {
    const { relations } = relationsOf(
      school([
        { target: "そこ", kind: "adjacent", value: null, evidence: "学校は港の北に建っている" },
      ])
    );
    expect(relations).toEqual([]);
  });
});

describe("指示の言葉がそのまま返ってきても通さない（失敗3）", () => {
  test("種類の欄に指示の英字の列が返る", () => {
    const { relations } = relationsOf(
      school([
        {
          target: "港",
          kind: "within|adjacent|direction|distance",
          value: null,
          evidence: "学校は港の北に建っている",
        },
      ])
    );
    expect(relations).toEqual([]);
  });

  test("値の欄に指示の言葉が返る", () => {
    const { relations } = relationsOf(
      school([
        { target: "港", kind: "direction", value: "方角の語", evidence: "学校は港の北に建っている" },
        {
          target: "港",
          kind: "distance",
          value: "距離・所要時間の言い方",
          evidence: "港から学校までは徒歩10分ほどだ",
        },
      ])
    );
    expect(relations).toEqual([]);
  });

  test("引用の欄に指示の言葉が返る", () => {
    const { relations } = relationsOf(
      school([
        {
          target: "港",
          kind: "direction",
          value: "北",
          evidence: "その関係が書かれた本文の一続きの部分",
        },
      ])
    );
    expect(relations).toEqual([]);
  });
});

describe("話数は関係の引用の位置で決める", () => {
  test("場所の話数を流用しない", () => {
    const first = "学校の門をくぐる。\n\n";
    const second = "学校は港の北に建っている。";
    const twoEpisodes: Chunk = {
      filePath: "001.txt",
      index: 0,
      text: first + second,
      startLine: 0,
      hash: "fixture2",
      chapterStart: 1,
      chapterEnd: 2,
      segments: [
        {
          filePath: "001.txt",
          startLine: 0,
          start: 0,
          end: first.length,
          chapterStart: 1,
          chapterEnd: 1,
        },
        {
          filePath: "002.txt",
          startLine: 0,
          start: first.length,
          end: first.length + second.length,
          chapterStart: 2,
          chapterEnd: 2,
        },
      ],
    };
    const result = validateExtractedLocations(
      [
        {
          name: "学校",
          evidence: "学校の門をくぐる",
          relations: [
            { target: "港", kind: "direction", value: "北", evidence: "学校は港の北に建っている" },
          ],
        },
      ],
      twoEpisodes
    );
    expect(result.accepted[0].chapters).toEqual([1]);
    expect(result.accepted[0].data.relations?.[0].chapters).toEqual([2]);
  });
});
