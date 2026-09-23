import { describe, expect, test } from "vitest";
import {
  buildEmptyForeshadowGuide,
  buildForeshadowMarkdown,
} from "../../src/core/foreshadowMarkdown";
import { emptyForeshadow, type Foreshadow } from "../../src/models/foreshadow";

/**
 * 伏線の一覧（設計書6.35.5）。
 *
 * **未回収を上に置く。** この一覧を開く目的は「まだ回収していないものを
 * 思い出すこと」であり、回収済みは確認のために残っているだけである。
 */

function foreshadow(overrides: Partial<Foreshadow>): Foreshadow {
  return {
    ...emptyForeshadow(overrides.id ?? "foreshadow_001", overrides.label ?? "伏線"),
    ...overrides,
  };
}

/** 見出しの並び（`##` の行だけ取り出す） */
function headings(markdown: string): string[] {
  return markdown
    .split("\n")
    .filter((line) => line.startsWith("## "))
    .map((line) => line.slice(3));
}

/** 各件の見出し（`###` の行だけ取り出す） */
function entries(markdown: string): string[] {
  return markdown
    .split("\n")
    .filter((line) => line.startsWith("### "))
    .map((line) => line.slice(4));
}

describe("伏線の一覧のMarkdown", () => {
  test("未回収・意図して開けたまま・回収済みの順に並ぶ", () => {
    // 登録した順に関わらず、読む順で並べ直す
    const markdown = buildForeshadowMarkdown([
      foreshadow({ id: "foreshadow_001", label: "回収した鏡", status: "resolved" }),
      foreshadow({
        id: "foreshadow_002",
        label: "開けたままの扉",
        status: "intentional",
      }),
      foreshadow({ id: "foreshadow_003", label: "銀の懐中時計", status: "open" }),
    ]);

    expect(headings(markdown)).toEqual([
      "未回収（1件）",
      "意図して開けたまま（1件）",
      "回収済み（1件）",
    ]);
    expect(entries(markdown)).toEqual([
      "銀の懐中時計",
      "開けたままの扉",
      "回収した鏡",
    ]);
  });

  test("冒頭に未回収の件数を出す", () => {
    const markdown = buildForeshadowMarkdown([
      foreshadow({ id: "foreshadow_001", status: "open" }),
      foreshadow({ id: "foreshadow_002", status: "open" }),
      foreshadow({ id: "foreshadow_003", status: "resolved" }),
    ]);

    expect(markdown).toContain("未回収 2件");
    expect(markdown).toContain("回収済み 1件");
  });

  test("未回収が0件でも、0件と書く", () => {
    // 「まだ数えていない」との違いが分かるようにする
    const markdown = buildForeshadowMarkdown([
      foreshadow({ id: "foreshadow_001", status: "resolved" }),
    ]);

    expect(markdown).toContain("未回収 0件");
  });

  test("0件でも壊れず、見出しだけの一覧を返す", () => {
    const markdown = buildForeshadowMarkdown([]);

    expect(markdown).toContain("# 伏線の一覧");
    expect(markdown).toContain("未回収 0件");
    expect(headings(markdown)).toEqual([]);
  });

  test("話数が分からなければ「話数不明」と書く", () => {
    // **推測で第1話にしない。** 一覧の順序も内容も嘘になる
    const markdown = buildForeshadowMarkdown([
      foreshadow({ label: "名を呼ばれない少女", plantedChapter: null }),
    ]);

    expect(markdown).toContain("話数不明で張った");
    expect(markdown).not.toContain("第null話");
  });

  test("話数の早い順に並び、話数不明は最後へ回る", () => {
    const markdown = buildForeshadowMarkdown([
      foreshadow({ id: "foreshadow_001", label: "不明の伏線", plantedChapter: null }),
      foreshadow({ id: "foreshadow_002", label: "第7話の伏線", plantedChapter: 7 }),
      foreshadow({ id: "foreshadow_003", label: "第2話の伏線", plantedChapter: 2 }),
    ]);

    expect(entries(markdown)).toEqual([
      "第2話の伏線",
      "第7話の伏線",
      "不明の伏線",
    ]);
  });

  test("張った話数と引用を出す", () => {
    const markdown = buildForeshadowMarkdown([
      foreshadow({
        label: "銀の懐中時計",
        note: "祖父の形見。由来がまだ語られていない",
        plantedChapter: 3,
        plantedQuote: "祖父は黙って銀の懐中時計を差し出した",
      }),
    ]);

    expect(markdown).toContain("祖父の形見。由来がまだ語られていない");
    expect(markdown).toContain("第3話で張った");
    expect(markdown).toContain("引用：「祖父は黙って銀の懐中時計を差し出した」");
  });

  test("回収済みには回収した話数と引用も出す", () => {
    const markdown = buildForeshadowMarkdown([
      foreshadow({
        label: "割れた鏡",
        status: "resolved",
        plantedChapter: 2,
        resolvedChapter: 9,
        resolvedQuote: "鏡が割れていたのは、あの夜のせいだった",
      }),
    ]);

    expect(markdown).toContain("第2話で張った");
    expect(markdown).toContain("第9話で回収");
    expect(markdown).toContain("鏡が割れていたのは、あの夜のせいだった");
  });

  test("未回収には回収の行を出さない", () => {
    const markdown = buildForeshadowMarkdown([
      foreshadow({ label: "銀の懐中時計", plantedChapter: 3 }),
    ]);

    expect(markdown).not.toContain("で回収");
  });

  test("1件も無いときは、次に何をすればよいかを書いた1枚を出す", () => {
    // **黙って空の一覧を出さない。** 壊れているのか、まだ登録していないのかを
    // 作者が見分けられるようにする
    const guide = buildEmptyForeshadowGuide();

    expect(guide).toContain("# 伏線の一覧");
    expect(guide).toContain("まだ伏線が登録されていません。");
    expect(guide).toContain("伏線として登録");
    expect(guide).toContain("伏線を手で追加");
  });

  test("作者メモは書いてあれば必ず出す", () => {
    // AIが触らない項目。**一覧から落とすと、書いた意味が無くなる**
    const markdown = buildForeshadowMarkdown([
      foreshadow({ label: "銀の懐中時計", authorNotes: "第12話で使う" }),
    ]);

    expect(markdown).toContain("作者メモ：第12話で使う");
  });
});
