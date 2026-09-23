import { describe, expect, test } from "vitest";
import {
  parseTitleFitRecord,
  parseTitleFitResponse,
  titleFitBatches,
  splitTitleFit,
  titleFitCandidates,
  titleFitTargets,
  TITLE_FIT_REACHES_SCORE,
  TITLE_FIT_BATCH,
  TITLE_FIT_CANDIDATES,
  TITLE_FIT_COMMENT_MAX,
  TITLE_FIT_SCHEMA_VERSION,
  type TitleFitItem,
  type TitleFitRecord,
} from "../../../src/core/titleFit";

/**
 * タイトルとサブタイトルのターゲット読者適合度（設計書6.108.6、P-41）。
 *
 * **AI の出力を信用しない**（実装ルール3）。点数も一言も AI が返すが、
 * どの題についての答えか・点数が範囲にあるか・一言が指示語の返りで
 * ないかは、コードが確かめる。
 *
 * **数字は目安**で、順位づけには使わない——低い順に並べて「直す候補」を
 * 示すだけ（設計書6.108.6）。
 */

const TARGETS = titleFitTargets("鉛の海", [
  { label: "第1話", title: "目覚め" },
  { label: "第2話", title: null },
  { label: "第3話", title: "錆びた港" },
]);

describe("何を測るか", () => {
  test("作品タイトルと、題のある話だけを並べる（題の無い話は測らない）", () => {
    expect(TARGETS.map((target) => [target.id, target.label, target.text])).toEqual([
      ["title", "作品タイトル", "鉛の海"],
      ["e1", "第1話", "目覚め"],
      ["e3", "第3話", "錆びた港"],
    ]);
  });

  test("話が多ければ、決まった数ずつに分けて頼む", () => {
    const many = titleFitTargets(
      "題",
      Array.from({ length: TITLE_FIT_BATCH * 2 + 1 }, (_, index) => ({
        label: `第${index + 1}話`,
        title: `題${index + 1}`,
      }))
    );

    const batches = titleFitBatches(many);
    expect(batches).toHaveLength(3);
    expect(batches.flat()).toHaveLength(many.length);
    // 作品タイトルは最初の束に入る
    expect(batches[0][0].id).toBe("title");
  });
});

describe("AI の答えを確かめる", () => {
  test("渡した題への答えだけを採る", () => {
    const parsed = parseTitleFitResponse(
      {
        items: [
          { id: "title", score: 72, comment: "重さが考察好きに届く" },
          { id: "e1", score: 40, comment: "ありふれていて目を引かない" },
          { id: "e9", score: 90, comment: "渡していない話" },
        ],
      },
      TARGETS
    );

    expect(parsed.items.map((item) => item.id)).toEqual(["title", "e1"]);
    expect(parsed.items[0]).toMatchObject({
      label: "作品タイトル",
      text: "鉛の海",
      score: 72,
    });
    expect(parsed.notes.join("\n")).toContain("e9");
  });

  test("同じ題に2度答えたら、先の1つだけ", () => {
    const parsed = parseTitleFitResponse(
      {
        items: [
          { id: "e1", score: 40, comment: "一つ目" },
          { id: "e1", score: 90, comment: "二つ目" },
        ],
      },
      TARGETS
    );

    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0].comment).toBe("一つ目");
  });

  test("点数が0〜100の外・数でないものは捨てる（丸めて採らない）", () => {
    const parsed = parseTitleFitResponse(
      {
        items: [
          { id: "title", score: 140, comment: "範囲の外" },
          { id: "e1", score: "高い", comment: "数でない" },
          { id: "e3", score: 55.4, comment: "小数は丸める" },
        ],
      },
      TARGETS
    );

    expect(parsed.items.map((item) => [item.id, item.score])).toEqual([
      ["e3", 55],
    ]);
  });

  test("一言が空・指示語の返りなら、その題は捨てる", () => {
    const parsed = parseTitleFitResponse(
      {
        items: [
          { id: "title", score: 50, comment: "" },
          { id: "e1", score: 50, comment: "一言" },
          { id: "e3", score: 50, comment: "空文字" },
        ],
      },
      TARGETS
    );

    expect(parsed.items).toEqual([]);
    expect(parsed.notes.length).toBeGreaterThan(0);
  });

  test(`一言が${TITLE_FIT_COMMENT_MAX}字を超えたら切り詰めて印を付ける`, () => {
    const long = "あ".repeat(TITLE_FIT_COMMENT_MAX + 10);
    const parsed = parseTitleFitResponse(
      { items: [{ id: "e1", score: 30, comment: long }] },
      TARGETS
    );

    expect(parsed.items[0].comment).toHaveLength(TITLE_FIT_COMMENT_MAX + 1);
    expect(parsed.items[0].comment.endsWith("…")).toBe(true);
  });

  test("形の合わない答えは、何も採らない（投げない）", () => {
    expect(parseTitleFitResponse(null, TARGETS).items).toEqual([]);
    expect(parseTitleFitResponse({ items: "x" }, TARGETS).items).toEqual([]);
  });
});

describe("直す候補", () => {
  function item(id: string, score: number): TitleFitItem {
    return { id, kind: "episode", label: id, text: id, score, comment: "c" };
  }

  test("低い順に並べ、決まった数まで", () => {
    const items = [
      item("e1", 80),
      item("e2", 20),
      item("e3", 60),
      item("e4", 10),
      item("e5", 90),
      item("e6", 30),
      item("e7", 40),
    ];

    const picked = titleFitCandidates(items);
    expect(picked).toHaveLength(TITLE_FIT_CANDIDATES);
    expect(picked.map((entry) => entry.id)).toEqual([
      "e4",
      "e2",
      "e6",
      "e7",
      "e3",
    ]);
  });

  test("同点は元の並び（話の順）を崩さない", () => {
    const picked = titleFitCandidates([item("e1", 50), item("e2", 50)]);
    expect(picked.map((entry) => entry.id)).toEqual(["e1", "e2"]);
  });

  test("よく届いている題は直す候補に回さず、件数で切らずに元の並びで返す（プロンプト設計書1.9）", () => {
    const items = [
      item("e1", 95),
      item("e2", 20),
      item("e3", TITLE_FIT_REACHES_SCORE),
      item("e4", 80),
      item("e5", 90),
      item("e6", 85),
      item("e7", 99),
    ];
    const { reaching, candidates } = splitTitleFit(items);
    expect(reaching.map((entry) => entry.id)).toEqual(["e1", "e3", "e4", "e5", "e6", "e7"]);
    expect(candidates.map((entry) => entry.id)).toEqual(["e2"]);
    // どれも高ければ、直す候補は0件（件数で作らない）
    expect(splitTitleFit([item("e1", 90)]).candidates).toEqual([]);
  });
});

describe("記録を読む", () => {
  const record: TitleFitRecord = {
    schemaVersion: TITLE_FIT_SCHEMA_VERSION,
    measuredAt: "2026-09-23T10:00:00.000Z",
    readerType: "lore_deep",
    basis: "aim",
    model: "gemma",
    items: [
      {
        id: "title",
        kind: "title",
        label: "作品タイトル",
        text: "鉛の海",
        score: 70,
        comment: "届く",
      },
    ],
    unmeasured: 1,
  };

  test("書いたものを読み直せる", () => {
    expect(parseTitleFitRecord(JSON.parse(JSON.stringify(record)))).toEqual(
      record
    );
  });

  test("形の合わない記録は読まない（直さない）", () => {
    expect(parseTitleFitRecord({ ...record, readerType: "unknown" })).toBeUndefined();
    expect(parseTitleFitRecord({ ...record, items: "x" })).toBeUndefined();
    expect(parseTitleFitRecord("壊れた")).toBeUndefined();
  });
});
