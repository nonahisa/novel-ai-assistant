import { describe, expect, test } from "vitest";
import {
  describeRemembered,
  isRememberable,
  rememberedAnswer,
  REMEMBERABLE_CONFIRMS,
  UNKNOWN_CONFIRM_LABEL,
  withoutAll,
  withoutRemembered,
  withRemembered,
  type ConfirmMemory,
} from "../../src/core/confirmMemory";

/**
 * 「以降は訊かない」の覚え書き（設計書6.89）。
 *
 * ここで一番大事なのは**危ない操作が一覧に入っていないこと**である。
 * 覚えられる確認は、押しても取り返しのつく操作に限る。
 */

describe("覚える・忘れる", () => {
  const id = REMEMBERABLE_CONFIRMS[0].id;

  test("覚えた答えを引ける", () => {
    const memory = withRemembered({}, id, "実行");

    expect(rememberedAnswer(memory, id)).toBe("実行");
  });

  test("違う文言で訊かれたら、覚えていても素通りさせない", () => {
    // 呼び出し側の判断に使えるよう、**答えはボタンの文言そのもの**で持つ
    const memory = withRemembered({}, id, "実行");

    expect(rememberedAnswer(memory, id)).not.toBe("作品全体を見る");
  });

  test("ひとつ忘れる", () => {
    const other = REMEMBERABLE_CONFIRMS[1].id;
    const memory = withRemembered(withRemembered({}, id, "実行"), other, "実行");

    const next = withoutRemembered(memory, id);

    expect(rememberedAnswer(next, id)).toBeUndefined();
    expect(rememberedAnswer(next, other)).toBe("実行");
  });

  test("すべて忘れる", () => {
    expect(withoutAll()).toEqual({});
  });

  test("元の覚え書きは書き換えない", () => {
    const memory: ConfirmMemory = withRemembered({}, id, "実行");

    withoutRemembered(memory, id);
    withRemembered(memory, REMEMBERABLE_CONFIRMS[1].id, "実行");

    expect(rememberedAnswer(memory, id)).toBe("実行");
  });
});

describe("一覧に無い id は覚えない", () => {
  test("isRememberable が偽", () => {
    expect(isRememberable("novelai.gitSync.push")).toBe(false);
  });

  test("覚えようとしても、覚え書きは変わらない", () => {
    // **呼び出し側の書き間違いで、知らない確認が固定されないようにする**
    expect(withRemembered({}, "ai.run.しらない機能", "実行")).toEqual({});
  });

  test("設定へ手で書かれていても効かせない", () => {
    const memory = { "gitSync.push": "送信する" };

    expect(rememberedAnswer(memory, "gitSync.push")).toBeUndefined();
  });
});

describe("見直しの一覧", () => {
  test("覚えているものを、作者の言葉で並べる", () => {
    const entry = REMEMBERABLE_CONFIRMS[0];
    const listed = describeRemembered(withRemembered({}, entry.id, "実行"));

    expect(listed).toEqual([
      { id: entry.id, label: entry.label, answer: "実行" },
    ]);
  });

  test("一覧に無い id も落とさずに出す", () => {
    // 設定を手で書き換えた作者が、「消したいのに出ない」で詰まらないため
    const listed = describeRemembered({ "むかしの確認": "実行" });

    expect(listed).toHaveLength(1);
    expect(listed[0].id).toBe("むかしの確認");
    expect(listed[0].label).toContain(UNKNOWN_CONFIRM_LABEL);
  });

  test("空の答えは並べない", () => {
    expect(describeRemembered({ [REMEMBERABLE_CONFIRMS[0].id]: "" })).toEqual(
      []
    );
  });
});

describe("一覧の形", () => {
  test("id が重複しない", () => {
    const ids = REMEMBERABLE_CONFIRMS.map((entry) => entry.id);

    expect(ids.length).toBe(new Set(ids).size);
  });

  test("どの項目にも、作者が読める日本語の名前が付いている", () => {
    for (const entry of REMEMBERABLE_CONFIRMS) {
      expect(entry.label.trim().length).toBeGreaterThan(0);
    }
  });
});

/**
 * **ここが一番の番人。**
 *
 * 「以降は訊かない」を当ててよいのは、押しても取り返しのつく操作だけ。
 * 外への送信・統合・削除・原稿への書き込みは、一度固定すると戻せない
 * ——固定したこと自体を作者が忘れていれば、気づく機会も無い。
 *
 * **この一覧へ足すときは、このテストも直すことになる。**
 * つまり、わざとでなければ足せない。
 */
describe("危ない操作は覚えない", () => {
  const FORBIDDEN = [
    "gitSync",
    "syncAllWorks",
    "unifyCharacters",
    "delete",
    "clearVectorIndex",
    "gitOnboarding",
    "watchSettings",
  ];

  test.each(FORBIDDEN)("%s を含む id は一覧に無い", (word) => {
    const hits = REMEMBERABLE_CONFIRMS.filter((entry) =>
      entry.id.toLowerCase().includes(word.toLowerCase())
    );

    expect(hits.map((entry) => entry.id)).toEqual([]);
  });
});
