import { describe, expect, test } from "vitest";
import {
  emptyPostingLedger,
  firstUnpostedEpisodePath,
  parsePostingLedger,
  postedSites,
  postRecordFor,
  revisionFor,
  revisionsFor,
  revisionNeed,
  unpostedSites,
  withRevision,
  type PostingLedger,
} from "../../../src/models/posting";

/**
 * 修正版の出し直しの記録（設計書6.68.7。作者の依頼 2026-11-03）。
 *
 * 出し直しは `posts` とは別の `revisions` に入る。**未投稿の数と投稿した日時を動かさない**
 * ことと、**この欄が無い古い台帳をそのまま読める**こと、**壊れた欄は直さずに止める**ことを見る。
 */

const base: PostingLedger = {
  ...emptyPostingLedger(),
  sites: [
    { site: "narou", newEpisodeUrl: "https://syosetu.com/usernovelmanage/isnoveluploadmenu/ncode/n1234ab/" },
    { site: "kakuyomu", newEpisodeUrl: "https://kakuyomu.jp/my/works/1/episodes/new" },
  ],
  posts: [{ episodePath: "本文/001.txt", site: "kakuyomu", postedAt: "2026-10-01T00:00:00.000Z" }],
};

describe("出し直しの記録", () => {
  test("投稿済みのサイトだけが出し直しの候補になる（登録したサイトの中だけ）", () => {
    expect(postedSites(base, "本文/001.txt")).toEqual(["kakuyomu"]);
    expect(postedSites(base, "本文/002.txt")).toEqual([]);
    // 外したサイトへ出した記録は候補に入れない
    const removed = { ...base, sites: base.sites.filter((entry) => entry.site === "narou") };
    expect(postedSites(removed, "本文/001.txt")).toEqual([]);
  });

  test("出し直しを記録しても、投稿の記録と未投稿の数は変わらない", () => {
    const next = withRevision(base, "本文/001.txt", "kakuyomu", "2026-11-03T00:00:00.000Z");
    expect(next.posts).toEqual(base.posts);
    expect(unpostedSites(next, "本文/001.txt")).toEqual(unpostedSites(base, "本文/001.txt"));
    expect(firstUnpostedEpisodePath(next, ["本文/001.txt"])).toBe("本文/001.txt");
    expect(next.revisions).toEqual([
      { episodePath: "本文/001.txt", site: "kakuyomu", revisedAt: "2026-11-03T00:00:00.000Z" },
    ]);
    // 元の台帳は書き換えない
    expect(base.revisions).toBeUndefined();
  });

  test("同じ話・同じサイトでも履歴として足していき、最新は日時で引く（作者の裁定 2026-11-03 昼）", () => {
    const first = withRevision(base, { episodePath: "本文/all.txt", chapter: 3 }, "kakuyomu", "2026-11-01T00:00:00.000Z");
    const second = withRevision(first, { episodePath: "本文/all.txt", chapter: 4 }, "kakuyomu", "2026-11-02T00:00:00.000Z");
    const third = withRevision(second, { episodePath: "本文/all.txt", chapter: 3 }, "kakuyomu", "2026-11-03T00:00:00.000Z");
    // 0.123.0 は同じ話・サイトを1件に保っていた（2件）。いまは消さずに3件
    expect(third.revisions).toHaveLength(3);
    expect(revisionFor(third, { episodePath: "本文/all.txt", chapter: 3 }, "kakuyomu")?.revisedAt).toBe(
      "2026-11-03T00:00:00.000Z"
    );
    expect(revisionFor(third, { episodePath: "本文/all.txt", chapter: 4 }, "kakuyomu")?.revisedAt).toBe(
      "2026-11-02T00:00:00.000Z"
    );
    expect(
      revisionsFor(third, { episodePath: "本文/all.txt", chapter: 3 }, "kakuyomu").map((record) => record.revisedAt)
    ).toEqual(["2026-11-03T00:00:00.000Z", "2026-11-01T00:00:00.000Z"]);
  });

  test("履歴の並びが日時順でなくても、最新は日時で引く。日時が同じなら後ろの記録", () => {
    const ledger: PostingLedger = {
      ...base,
      revisions: [
        { episodePath: "本文/001.txt", site: "kakuyomu", revisedAt: "2026-11-05T00:00:00.000Z", bodyHash: "a".repeat(64) },
        { episodePath: "本文/001.txt", site: "kakuyomu", revisedAt: "2026-11-02T00:00:00.000Z" },
      ],
    };
    expect(revisionFor(ledger, "本文/001.txt", "kakuyomu")?.revisedAt).toBe("2026-11-05T00:00:00.000Z");
    const tied = withRevision(ledger, "本文/001.txt", "kakuyomu", "2026-11-05T00:00:00.000Z", "b".repeat(64));
    expect(revisionFor(tied, "本文/001.txt", "kakuyomu")?.bodyHash).toBe("b".repeat(64));
  });

  test("0.123.0 の台帳（同じ話・サイトが1件だけの形）も、そのまま読めて最新を引ける", () => {
    const ledger = parsePostingLedger({
      schemaVersion: "1",
      sites: [{ site: "kakuyomu", newEpisodeUrl: "https://kakuyomu.jp/my/works/1/episodes/new" }],
      posts: [{ episodePath: "本文/001.txt", site: "kakuyomu", postedAt: "2026-10-01T00:00:00.000Z" }],
      revisions: [{ episodePath: "本文/001.txt", site: "kakuyomu", revisedAt: "2026-11-03T00:00:00.000Z" }],
      rankings: [],
    });
    expect(revisionFor(ledger, "本文/001.txt", "kakuyomu")?.revisedAt).toBe("2026-11-03T00:00:00.000Z");
    // 印の無い記録は「分からない」（出し直しが要るとは言わない）
    expect(revisionNeed(ledger, "本文/001.txt", "kakuyomu", { titled: `v2:${"c".repeat(64)}`, bodyOnly: "c".repeat(64) })).toBe("unknown");
  });

  test("投稿の記録は、その話の記録を先に、無ければファイルまるごとの記録を引く", () => {
    const ledger: PostingLedger = {
      ...base,
      posts: [
        { episodePath: "本文/all.txt", site: "kakuyomu", postedAt: "2026-09-01T00:00:00.000Z", importedBaseline: true },
        { episodePath: "本文/all.txt", site: "kakuyomu", postedAt: "2026-10-03T00:00:00.000Z", chapter: 3 },
      ],
    };
    expect(postRecordFor(ledger, { episodePath: "本文/all.txt", chapter: 3 }, "kakuyomu")?.postedAt).toBe(
      "2026-10-03T00:00:00.000Z"
    );
    expect(postRecordFor(ledger, { episodePath: "本文/all.txt", chapter: 5 }, "kakuyomu")?.importedBaseline).toBe(true);
  });
});

describe("台帳の読み込み", () => {
  const raw = {
    schemaVersion: "1",
    sites: [{ site: "kakuyomu", newEpisodeUrl: "https://kakuyomu.jp/my/works/1/episodes/new" }],
    posts: [],
    rankings: [],
  };

  test("この欄が無い古い台帳は、出し直しが無いとして読む（欄を足さない）", () => {
    expect("revisions" in parsePostingLedger(raw)).toBe(false);
  });

  test("出し直しの記録を読める（話数も）", () => {
    const ledger = parsePostingLedger({
      ...raw,
      revisions: [
        { episodePath: "本文\\all.txt", site: "kakuyomu", revisedAt: " 2026-11-03T00:00:00.000Z ", chapter: 3 },
      ],
    });
    expect(ledger.revisions).toEqual([
      { episodePath: "本文/all.txt", site: "kakuyomu", revisedAt: "2026-11-03T00:00:00.000Z", chapter: 3 },
    ]);
  });

  test("壊れた出し直しの記録は直さずに止める", () => {
    expect(() => parsePostingLedger({ ...raw, revisions: [{ episodePath: "本文/1.txt", site: "kakuyomu" }] })).toThrow();
    expect(() =>
      parsePostingLedger({ ...raw, revisions: [{ episodePath: "本文/1.txt", site: "unknown", revisedAt: "2026-11-03" }] })
    ).toThrow();
    expect(() => parsePostingLedger({ ...raw, revisions: "壊れた値" })).toThrow();
  });
});
