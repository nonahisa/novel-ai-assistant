import { describe, expect, test } from "vitest";
import {
  emptyPostingLedger,
  parsePostingLedger,
  postingTargetOfRecord,
  postRecordForPostRef,
  withPost,
  withSiteEpisodeId,
} from "../../../src/models/posting";

/**
 * 投稿の記録に残す貼り込みの札（設計書6.68.8）。
 * ヘルパーが投稿のあとに送り返す番号を、札でこの投稿へ結ぶ。
 */

const base = { ...emptyPostingLedger(), sites: [] };

describe("投稿の記録の札", () => {
  test("封筒で投稿した話の記録に札が入り、札で引ける", () => {
    const ledger = withPost(base, "本文/013.txt", "kakuyomu", "2026-11-03T00:00:00.000Z", undefined, "abc123");
    expect(ledger.posts[0].postRef).toBe("abc123");
    expect(postRecordForPostRef(ledger, "kakuyomu", "abc123")?.episodePath).toBe("本文/013.txt");
    // 札は1つのサイトへの投稿を指す。別のサイトでは引かない
    expect(postRecordForPostRef(ledger, "alphapolis", "abc123")).toBeUndefined();
  });

  test("投稿し直すと前の札は引き継がない（話の番号は引き継ぐ）", () => {
    const first = withPost(base, "本文/013.txt", "kakuyomu", "2026-11-01T00:00:00.000Z", undefined, "old");
    const numbered = withSiteEpisodeId(first, "本文/013.txt", "kakuyomu", "555");
    if (!numbered) throw new Error("番号が入りませんでした");
    const again = withPost(numbered, "本文/013.txt", "kakuyomu", "2026-11-03T00:00:00.000Z");
    expect(again.posts[0].postRef).toBeUndefined();
    expect(again.posts[0].siteEpisodeId).toBe("555");
  });

  test("台帳から読める。形の崩れた札は直さずに止める", () => {
    const raw = {
      schemaVersion: "1",
      sites: [],
      posts: [{ episodePath: "本文/013.txt", site: "kakuyomu", postedAt: "x", postRef: "k7Qm2xP9" }],
      rankings: [],
    };
    expect(parsePostingLedger(raw).posts[0].postRef).toBe("k7Qm2xP9");
    expect(() =>
      parsePostingLedger({ ...raw, posts: [{ ...raw.posts[0], postRef: "本文/013" }] })
    ).toThrow();
  });

  test("合本の1話の記録は、話数（読めなければ並び）を持つ指し先に戻る", () => {
    expect(
      postingTargetOfRecord({ episodePath: "a.txt", site: "kakuyomu", postedAt: "x", chapter: 3 })
    ).toEqual({ episodePath: "a.txt", chapter: 3 });
    expect(
      postingTargetOfRecord({ episodePath: "a.txt", site: "kakuyomu", postedAt: "x", order: 2 })
    ).toEqual({ episodePath: "a.txt", chapter: null, order: 2 });
    expect(postingTargetOfRecord({ episodePath: "a.txt", site: "kakuyomu", postedAt: "x" })).toEqual({
      episodePath: "a.txt",
    });
  });
});
