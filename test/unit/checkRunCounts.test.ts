import { describe, expect, test } from "vitest";
import { describeCheckRunCounts } from "../../src/core/checkRunCounts";

/**
 * 検知の完了通知は、提案パネルの見出しと同じ数え方をする（設計書6.8）。
 *
 * **実機で食い違った**（2026-09-06、作者の報告）。通知は
 * 「指摘 1件 / 除外 1件」なのに、提案パネルの見出しは「誤字脱字 0件」
 * ——前に適用した指摘・解消済みにした指摘を、通知だけが今回の指摘として
 * 数えていた。作者には「1件見つかったのに一覧が空」に見える。
 */

describe("完了通知の件数", () => {
  test("指摘だけのときは、指摘の件数だけを言う", () => {
    expect(
      describeCheckRunCounts({ shown: 3, alreadyHandled: 0, rejected: 0 })
    ).toEqual(["指摘 3件"]);
  });

  /**
   * **これが実機で起きた形である。** 既に適用済みの1件しか返らなかった回。
   * 「指摘 1件」と言ってはならないが、黙って消すのも駄目なので、
   * 括弧で別立てにして「なぜ一覧が空なのか」を言う。
   */
  test("既に適用・解消済みのものは、指摘に数えず別立てで言う", () => {
    const parts = describeCheckRunCounts({
      shown: 0,
      alreadyHandled: 1,
      rejected: 0,
    });

    expect(parts).toHaveLength(1);
    expect(parts[0]).toContain("指摘 0件");
    expect(parts[0]).toContain("前回適用・解消済み 1件");
  });

  test("捨てたぶんは件数だけ言い、理由はログへ送る", () => {
    const parts = describeCheckRunCounts({
      shown: 2,
      alreadyHandled: 0,
      rejected: 4,
    });

    expect(parts[0]).toBe("指摘 2件");
    // **内訳を通知へ並べない。** 理由の名前は作者の判断材料にならず、
    // 通知が長くなるだけである。追えるように場所だけ言う
    expect(parts[1]).toContain("除外 4件");
    expect(parts[1]).toContain("操作ログ");
  });

  test("両方あるときは、指摘・除外の順に並べる", () => {
    const parts = describeCheckRunCounts({
      shown: 1,
      alreadyHandled: 2,
      rejected: 3,
    });

    expect(parts).toHaveLength(2);
    expect(parts[0]).toContain("指摘 1件");
    expect(parts[1]).toContain("除外 3件");
  });
});
