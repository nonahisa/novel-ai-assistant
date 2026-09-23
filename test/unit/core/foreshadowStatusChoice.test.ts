import { describe, expect, test } from "vitest";
import {
  FORESHADOW_STATUS_NAME,
  foreshadowStatusChoices,
} from "../../src/core/foreshadowStatusChoice";

/**
 * 伏線の状態を変えるときの選択肢（作者の指摘、2026-09-06）。
 *
 * 「回収済みの伏線を選んでも『回収済みにする』が既定で先頭に来るため、
 * いまどちらなのかは一覧に戻らないと分からない」。
 *
 * 直したのは2つ——**いまの状態を書き添える**ことと、
 * **いまと同じ選択肢を先頭に置かない**ことである。QuickPick は開いた瞬間に
 * 先頭が選ばれているので、Enter を押しただけで「いまと同じ状態にする」が
 * 通ってしまう。押しても変わらない操作を、いちばん押しやすい場所に置かない。
 */

describe("いまの状態を、選ぶ画面に出す", () => {
  test("いまの状態と同じ選択肢に「（いま：回収済み）」を添える", () => {
    const choices = foreshadowStatusChoices("resolved");
    const current = choices.find((choice) => choice.status === "resolved");

    expect(current?.description).toBe("（いま：回収済み）");
    expect(current?.current).toBe(true);
  });

  test("いまと違う選択肢には、何も添えない", () => {
    const choices = foreshadowStatusChoices("resolved");

    for (const choice of choices) {
      if (choice.status === "resolved") continue;
      expect(choice.description, choice.label).toBeUndefined();
      expect(choice.current, choice.label).toBe(false);
    }
  });

  test("状態の言い方は、3つとも用意してある", () => {
    expect(FORESHADOW_STATUS_NAME).toEqual({
      open: "未回収",
      resolved: "回収済み",
      intentional: "意図して開けたまま",
    });
  });
});

describe("いまの状態と同じ選択肢は、先頭に出さない", () => {
  for (const status of ["open", "resolved", "intentional"] as const) {
    test(`いまが「${FORESHADOW_STATUS_NAME[status]}」なら、それが先頭に来ない`, () => {
      const choices = foreshadowStatusChoices(status);

      expect(choices[0].status).not.toBe(status);
      // **消しはしない。** 回収済みのものを「回収した話数」だけ入れ直す道は残す
      expect(choices.map((choice) => choice.status)).toContain(status);
      expect(choices[choices.length - 1].status).toBe(status);
    });
  }

  test("3つとも、1回ずつ出る", () => {
    const statuses = foreshadowStatusChoices("open").map(
      (choice) => choice.status
    );

    expect([...statuses].sort()).toEqual(["intentional", "open", "resolved"]);
  });

  test("使う言葉は変えない（作者が覚えている言い方）", () => {
    const labels = foreshadowStatusChoices("open").map(
      (choice) => choice.label
    );

    expect(labels).toContain("回収済みにする");
    expect(labels).toContain("意図して開けたまま（回収しない）");
    expect(labels).toContain("未回収に戻す");
  });
});
