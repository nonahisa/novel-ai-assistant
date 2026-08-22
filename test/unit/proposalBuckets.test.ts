import { describe, expect, test } from "vitest";
import {
  describeBadgeTooltip,
  isRemaining,
  mergeProposals,
  summarizeCategories,
} from "../../src/core/proposalBuckets";

/**
 * 提案パネルの中身を、分類ごとに分けて足す（設計書6.11.3）。
 *
 * **他の検知を走らせると、それまでの作業が消えていた**（2026-08-22、
 * 作者の指摘）。ここは「足し方」だけを切り出したもので、VS Code に
 * 依らないので機械で見張れる。
 */

const item = (id: string, status = "pending") => ({ id, status });

describe("同じ分類へ足す", () => {
  test("新しいものは、うしろへ足す", () => {
    const merged = mergeProposals([item("a")], [item("b"), item("c")]);
    expect(merged.map((i) => i.id)).toEqual(["a", "b", "c"]);
  });

  test("同じ印のものは、増やさない", () => {
    const merged = mergeProposals([item("a")], [item("a")]);
    expect(merged).toHaveLength(1);
  });

  /**
   * **作者が決めたものを `pending` へ戻さない。**
   * 戻すと、同じ直しをもう一度当てにいくことになる。
   */
  test("適用済み・見送り済みは、そのまま残る", () => {
    const merged = mergeProposals(
      [item("a", "applied"), item("b", "dismissed")],
      [item("a"), item("b")]
    );
    expect(merged.map((i) => i.status)).toEqual(["applied", "dismissed"]);
  });

  /**
   * **まだ手を付けていないものは、新しい内容で置き換える。**
   * 作者は何も決めていないので、古い内容を抱え込む理由がない。
   */
  test("手つかずのものは、新しい内容に入れ替わる", () => {
    const merged = mergeProposals(
      [{ id: "a", status: "pending", suggestion: "古い" }],
      [{ id: "a", status: "pending", suggestion: "新しい" }]
    );
    expect(merged[0].suggestion).toBe("新しい");
  });

  test("失敗したものは、やり直せるよう新しい内容に入れ替わる", () => {
    // 失敗はまだ片付いていない。作者の判断ではない
    const merged = mergeProposals(
      [{ id: "a", status: "failed", suggestion: "古い" }],
      [{ id: "a", status: "pending", suggestion: "新しい" }]
    );
    expect(merged[0].status).toBe("failed");
  });

  test("0件を足しても、持っているものは消えない", () => {
    const merged = mergeProposals([item("a")], []);
    expect(merged.map((i) => i.id)).toEqual(["a"]);
  });

  test("元の配列を書き換えない", () => {
    const existing = [item("a")];
    mergeProposals(existing, [item("b")]);
    expect(existing).toHaveLength(1);
  });
});

describe("まだ手が要るもの", () => {
  test("手つかずと失敗は残りに数える", () => {
    expect(isRemaining(item("a", "pending"))).toBe(true);
    // 手は付けたが、片付いていない
    expect(isRemaining(item("a", "failed"))).toBe(true);
  });

  test("適用済みと見送り済みは数えない", () => {
    expect(isRemaining(item("a", "applied"))).toBe(false);
    expect(isRemaining(item("a", "dismissed"))).toBe(false);
  });
});

describe("分類のタブ", () => {
  const counts = new Map([
    ["誤字脱字", { remaining: 2, total: 5 }],
    ["推敲", { remaining: 0, total: 3 }],
  ]);

  test("走らせた順に並べる", () => {
    // 名前で並べ替えると、いま実行したものがどこへ入ったのか目で追えない
    expect(summarizeCategories(counts, "推敲").map((s) => s.name)).toEqual([
      "誤字脱字",
      "推敲",
    ]);
  });

  test("いま見ているものに印を付ける", () => {
    const summaries = summarizeCategories(counts, "推敲");
    expect(summaries.find((s) => s.name === "推敲")?.active).toBe(true);
    expect(summaries.find((s) => s.name === "誤字脱字")?.active).toBe(false);
  });

  test("残りが0でも、分類そのものは残す", () => {
    // 「さっき走らせたのに消えた」と思わせない
    expect(summarizeCategories(counts, "誤字脱字")).toHaveLength(2);
  });
});

describe("タブの印の説明", () => {
  test("分類ごとの内訳を出す", () => {
    // 合計だけだと、どれを見に行けばよいか分からない
    const text = describeBadgeTooltip([
      { name: "誤字脱字", remaining: 2, total: 5, active: true },
      { name: "推敲", remaining: 1, total: 1, active: false },
    ]);
    expect(text).toContain("誤字脱字 2件");
    expect(text).toContain("推敲 1件");
  });

  test("残りのない分類は書かない", () => {
    const text = describeBadgeTooltip([
      { name: "誤字脱字", remaining: 2, total: 5, active: true },
      { name: "推敲", remaining: 0, total: 3, active: false },
    ]);
    expect(text).not.toContain("推敲");
  });

  test("どこにも残っていなければ、そう言う", () => {
    expect(
      describeBadgeTooltip([
        { name: "誤字脱字", remaining: 0, total: 5, active: true },
      ])
    ).toContain("未処理はありません");
  });
});
