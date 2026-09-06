import { describe, expect, test } from "vitest";
import {
  countIncoming,
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

/**
 * 今回届いた結果のうち、何件が一覧に残ったか（設計書6.8）。
 *
 * **通知の「指摘 N件」は、ここで数えた `remaining` を言う。**
 * 検知が返した件数をそのまま言うと、前に適用済み・解消済みだったものまで
 * 数えてしまい、パネルの見出し（`remainingIn`）と食い違う。
 */
describe("届いた結果のうち、一覧に残った件数", () => {
  test("初めて届いたものは、残りに数える", () => {
    const incoming = [item("a"), item("b")];
    const merged = mergeProposals([], incoming);

    expect(countIncoming(merged, incoming)).toEqual({
      remaining: 2,
      handled: 0,
    });
  });

  test("前に適用済みのものは、残りに数えない", () => {
    const incoming = [item("a")];
    const merged = mergeProposals([item("a", "applied")], incoming);

    expect(countIncoming(merged, incoming)).toEqual({
      remaining: 0,
      handled: 1,
    });
  });

  test("解消済み・見送り済みも、残りに数えない", () => {
    const incoming = [item("a"), item("b")];
    const merged = mergeProposals(
      [item("a", "resolved"), item("b", "dismissed")],
      incoming
    );

    expect(countIncoming(merged, incoming)).toEqual({
      remaining: 0,
      handled: 2,
    });
  });

  /** 適用に失敗したものは、まだ片付いていないので残りに数える */
  test("適用に失敗したものは、残りに数える", () => {
    const incoming = [item("a")];
    const merged = mergeProposals([item("a", "failed")], incoming);

    expect(countIncoming(merged, incoming)).toEqual({
      remaining: 1,
      handled: 0,
    });
  });

  test("同じ印が二度届いても、1件として数える", () => {
    const incoming = [item("a"), item("a")];
    const merged = mergeProposals([], incoming);

    expect(countIncoming(merged, incoming)).toEqual({
      remaining: 1,
      handled: 0,
    });
  });

  /**
   * **前の回の残りは数えない。** ここで見たいのは「今回の結果が
   * どうなったか」であって、パネル全体の残数ではない
   */
  test("今回届かなかったものは、数に入れない", () => {
    const incoming = [item("b")];
    const merged = mergeProposals([item("a")], incoming);

    expect(countIncoming(merged, incoming)).toEqual({
      remaining: 1,
      handled: 0,
    });
  });
});
