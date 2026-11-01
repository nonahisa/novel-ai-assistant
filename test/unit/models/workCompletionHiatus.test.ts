import { describe, expect, test } from "vitest";
import {
  WORK_COMPLETIONS,
  isWorkCompletion,
  readPostingLedger,
  withSiteFacts,
  emptyPostingLedger,
  workCompletionLabel,
} from "../../../src/models/posting";

/**
 * 連載の状態に「休載」を足す（作者の判断 2026-11-01）。
 *
 * あわせて、**知らない値が来たとき、その作品の投稿の記録ごと止めない**。
 * 新しい版が書いた値（ここでいう休載のような、まだ知らない値）を読んだ古い版が、
 * 台帳を丸ごと読めなくなると、投稿キットも執筆統計も止まる。知らない値の欄だけを
 * 読まずに、生のまま返す（保存で書き戻すのは `PostingStore` の仕事）。
 * 壊れたJSON（型の違い・欠けた日時）は今までどおり止める。
 */

describe("休載", () => {
  test("連載中・完結・休載の3つ", () => {
    expect([...WORK_COMPLETIONS]).toEqual(["ongoing", "completed", "hiatus"]);
    expect(isWorkCompletion("hiatus")).toBe(true);
    expect(workCompletionLabel("ongoing")).toBe("連載中");
    expect(workCompletionLabel("completed")).toBe("完結");
    expect(workCompletionLabel("hiatus")).toBe("休載");
  });

  test("作品の印に休載を書いた台帳を読める", () => {
    const read = readPostingLedger({
      sites: [],
      posts: [],
      completion: { value: "hiatus", setAt: "2026-11-01T00:00:00.000Z" },
    });
    expect(read.ledger.completion).toEqual({ value: "hiatus", setAt: "2026-11-01T00:00:00.000Z" });
  });

  test("サイトから届いた休載も台帳へ写せる", () => {
    const { ledger } = withSiteFacts(emptyPostingLedger(), {
      site: "kakuyomu",
      readAt: "2026-11-01T00:00:00.000Z",
      completion: "hiatus",
    });
    expect(ledger.siteFacts?.[0]?.completion).toBe("hiatus");
  });
});

describe("知らない連載の状態で、台帳ごと止めない", () => {
  test("作品の印が知らない値なら、その欄だけ読まずに生のまま返す", () => {
    const raw = { value: "paused-forever", setAt: "2026-11-01T00:00:00.000Z", by: "新しい版" };
    const read = readPostingLedger({
      sites: [],
      posts: [{ episodePath: "本文/001.txt", site: "narou", postedAt: "2026-09-04T10:00:00.000Z" }],
      completion: raw,
    });
    expect(read.ledger.completion).toBeUndefined();
    // 投稿の記録は読めている（ここが止まると投稿キットまで止まる）
    expect(read.ledger.posts).toHaveLength(1);
    expect(read.skippedCompletion).toEqual(raw);
    expect(read.unknownValues).toEqual([
      expect.stringContaining("paused-forever"),
    ]);
  });

  test("サイトの印が知らない値なら、その欄だけ読まない（タグは残す）", () => {
    const read = readPostingLedger({
      sites: [],
      posts: [],
      siteFacts: [
        {
          site: "kakuyomu",
          tags: ["幽霊"],
          tagsAt: "2026-11-01T00:00:00.000Z",
          completion: "paused-forever",
          completionAt: "2026-11-01T00:00:00.000Z",
        },
      ],
    });
    expect(read.ledger.siteFacts).toEqual([
      { site: "kakuyomu", tags: ["幽霊"], tagsAt: "2026-11-01T00:00:00.000Z" },
    ]);
    expect(read.skippedSiteCompletions).toEqual([
      { site: "kakuyomu", completion: "paused-forever", completionAt: "2026-11-01T00:00:00.000Z" },
    ]);
    expect(read.unknownValues).toHaveLength(1);
  });

  test("知っている値だけの台帳では、何も読み飛ばさない", () => {
    const read = readPostingLedger({
      sites: [],
      posts: [],
      completion: { value: "completed", setAt: "2026-11-01T00:00:00.000Z" },
    });
    expect(read.skippedCompletion).toBeUndefined();
    expect(read.skippedSiteCompletions).toEqual([]);
    expect(read.unknownValues).toEqual([]);
  });

  test("壊れた形（文字列でない値・日時の欠け）は今までどおり止める", () => {
    expect(() =>
      readPostingLedger({ sites: [], posts: [], completion: { value: 3, setAt: "2026-11-01T00:00:00.000Z" } })
    ).toThrow();
    expect(() =>
      readPostingLedger({ sites: [], posts: [], completion: { value: "hiatus" } })
    ).toThrow();
    expect(() =>
      readPostingLedger({ sites: [], posts: [], completion: "hiatus" })
    ).toThrow();
    expect(() =>
      readPostingLedger({
        sites: [],
        posts: [],
        siteFacts: [{ site: "kakuyomu", completion: 1, completionAt: "2026-11-01T00:00:00.000Z" }],
      })
    ).toThrow();
    expect(() =>
      readPostingLedger({
        sites: [],
        posts: [],
        siteFacts: [{ site: "kakuyomu", completion: "paused-forever" }],
      })
    ).toThrow();
  });
});
