import { describe, expect, test } from "vitest";
import {
  emptyPostingLedger,
  hasBodyHashFor,
  isTitledTextHash,
  lastSentBodyHash,
  parsePostingLedger,
  revisionNeed,
  siteEpisodeIdFor,
  siteWorkNumberFor,
  sitesNeedingRevision,
  withPost,
  withRevision,
  withSiteEpisodeId,
  withSiteWorkNumber,
  type PostingLedger,
  type PostingTextHashes,
} from "../../../src/models/posting";

/**
 * 投稿したときの本文の印と、サイトの話の番号（設計書6.68.7。作者の裁定 2026-11-03 昼）。
 *
 * 印は「投稿のあとに本文を直した話」を見つけるためにある。**印の無い記録（これより前の投稿・
 * 基準線）は「分からない」**とし、直したとは言わない——直していない話にまで出し直しを促すと、
 * 促しが当てにならなくなる。
 */

/** 記録に残る印（0.124.1 からの、題と本文の両方の印） */
const OLD = `v2:${"1".repeat(64)}`;
const NEW = `v2:${"2".repeat(64)}`;
const NEWER = `v2:${"3".repeat(64)}`;
/** 今の話の印（本文だけの印は、ここでは古い記録と比べないので何でもよい） */
const cur = (titled: string): PostingTextHashes => ({ titled, bodyOnly: "f".repeat(64) });

const base: PostingLedger = {
  ...emptyPostingLedger(),
  sites: [
    { site: "narou", newEpisodeUrl: "https://syosetu.com/usernovelmanage/isnoveluploadmenu/ncode/n1234ab/" },
    { site: "kakuyomu", newEpisodeUrl: "https://kakuyomu.jp/my/works/1/episodes/new" },
  ],
};

describe("本文の印で、出し直しが要る話を見分ける", () => {
  test("投稿の記録に印を持ち、今の本文と違えば「直した」", () => {
    const ledger = withPost(base, "本文/001.txt", "kakuyomu", "2026-10-01T00:00:00.000Z", OLD);
    expect(ledger.posts[0].bodyHash).toBe(OLD);
    expect(revisionNeed(ledger, "本文/001.txt", "kakuyomu", cur(OLD))).toBe("same");
    expect(revisionNeed(ledger, "本文/001.txt", "kakuyomu", cur(NEW))).toBe("changed");
    expect(sitesNeedingRevision(ledger, "本文/001.txt", cur(NEW))).toEqual(["kakuyomu"]);
    // まだ出していないサイトは「分からない」（出し直しの対象ではない）
    expect(revisionNeed(ledger, "本文/001.txt", "narou", cur(NEW))).toBe("unknown");
  });

  test("印を渡さなければ欄を持たない（読んで書き戻すだけで中身が増えない）", () => {
    const ledger = withPost(base, "本文/001.txt", "kakuyomu", "2026-10-01T00:00:00.000Z");
    expect("bodyHash" in ledger.posts[0]).toBe(false);
    expect(revisionNeed(ledger, "本文/001.txt", "kakuyomu", cur(NEW))).toBe("unknown");
  });

  test("出し直したら、比べる相手は最新の出し直しの印になる", () => {
    const posted = withPost(base, "本文/001.txt", "kakuyomu", "2026-10-01T00:00:00.000Z", OLD);
    const revised = withRevision(posted, "本文/001.txt", "kakuyomu", "2026-11-01T00:00:00.000Z", NEW);
    expect(lastSentBodyHash(revised, "本文/001.txt", "kakuyomu")).toBe(NEW);
    expect(revisionNeed(revised, "本文/001.txt", "kakuyomu", cur(NEW))).toBe("same");
    expect(revisionNeed(revised, "本文/001.txt", "kakuyomu", cur(NEWER))).toBe("changed");
  });

  test("最新の出し直しに印が無ければ「分からない」——古い投稿の印へ遡らない", () => {
    const posted = withPost(base, "本文/001.txt", "kakuyomu", "2026-10-01T00:00:00.000Z", OLD);
    // 印を持たない版（0.123.0）で出し直した記録
    const revised = withRevision(posted, "本文/001.txt", "kakuyomu", "2026-11-01T00:00:00.000Z");
    expect(lastSentBodyHash(revised, "本文/001.txt", "kakuyomu")).toBeUndefined();
    expect(revisionNeed(revised, "本文/001.txt", "kakuyomu", cur(NEW))).toBe("unknown");
  });

  test("合本の1話は、その話の記録の印だけで比べる（別の話の印を使わない）", () => {
    const third = { episodePath: "本文/all.txt", chapter: 3 };
    const fourth = { episodePath: "本文/all.txt", chapter: 4 };
    let ledger = withPost(base, third, "kakuyomu", "2026-10-01T00:00:00.000Z", OLD);
    ledger = withPost(ledger, fourth, "kakuyomu", "2026-10-02T00:00:00.000Z", NEW);
    expect(revisionNeed(ledger, third, "kakuyomu", cur(OLD))).toBe("same");
    expect(revisionNeed(ledger, fourth, "kakuyomu", cur(NEW))).toBe("same");
    expect(revisionNeed(ledger, third, "kakuyomu", cur(NEW))).toBe("changed");
  });

  test("印つきの記録があるファイルだけを読む対象にする", () => {
    const ledger = withPost(base, { episodePath: "本文/all.txt", chapter: 3 }, "kakuyomu", "2026-10-01T00:00:00.000Z", OLD);
    expect(hasBodyHashFor(ledger, "本文/all.txt")).toBe(true);
    expect(hasBodyHashFor(ledger, "本文\\all.txt")).toBe(true);
    expect(hasBodyHashFor(ledger, "本文/002.txt")).toBe(false);
    const noHash = withPost(base, "本文/002.txt", "kakuyomu", "2026-10-01T00:00:00.000Z");
    expect(hasBodyHashFor(noHash, "本文/002.txt")).toBe(false);
  });
});

describe("0.124.0 の印（本文だけ・頭に v2: が無い）との比べ方", () => {
  const legacyBody = "4".repeat(64);
  const ledger = withPost(base, "本文/001.txt", "kakuyomu", "2026-10-01T00:00:00.000Z", legacyBody);

  test("本文だけの印どうしで比べ、違えば「直した」（本文を直したことは確か）", () => {
    expect(revisionNeed(ledger, "本文/001.txt", "kakuyomu", { titled: NEW, bodyOnly: "5".repeat(64) })).toBe("changed");
  });

  test("本文だけの印が同じなら「分からない」（題を直したかは、その印からは分からない）", () => {
    expect(revisionNeed(ledger, "本文/001.txt", "kakuyomu", { titled: NEW, bodyOnly: legacyBody })).toBe("unknown");
    expect(sitesNeedingRevision(ledger, "本文/001.txt", { titled: NEW, bodyOnly: legacyBody })).toEqual([]);
  });

  test("今の取り方の印（v2:）と古い印を取り違えない", () => {
    expect(isTitledTextHash(NEW)).toBe(true);
    expect(isTitledTextHash(legacyBody)).toBe(false);
  });
});

describe("サイトの中の数字の作品番号（なろうの小説番号）", () => {
  test("ヘルパーが送り返した番号を入れる（元の台帳は書き換えない）", () => {
    const next = withSiteWorkNumber(base, "narou", " 2930206 ", "2026-11-03T00:00:00.000Z");
    expect(siteWorkNumberFor(next ?? base, "narou")).toBe("2930206");
    expect(next?.siteFacts).toEqual([
      { site: "narou", siteWorkNumber: "2930206", siteWorkNumberAt: "2026-11-03T00:00:00.000Z" },
    ]);
    expect(base.siteFacts).toBeUndefined();
  });

  test("タグなど、そのサイトのほかの事柄は残す。同じ番号なら台帳をそのまま返す", () => {
    const withTags: PostingLedger = {
      ...base,
      siteFacts: [{ site: "narou", tags: ["異世界"], tagsAt: "2026-11-01T00:00:00.000Z" }],
    };
    const next = withSiteWorkNumber(withTags, "narou", "2930206", "2026-11-03T00:00:00.000Z");
    expect(next?.siteFacts?.[0]).toMatchObject({ tags: ["異世界"], siteWorkNumber: "2930206" });
    expect(withSiteWorkNumber(next ?? withTags, "narou", "2930206", "2026-11-04T00:00:00.000Z")).toBe(next);
  });

  test("数字でない番号は入れず undefined を返す（Nコードを取り違えて入れない）", () => {
    for (const value of ["n1234ab", "1/2", "", "２９"]) {
      expect(withSiteWorkNumber(base, "narou", value, "2026-11-03T00:00:00.000Z"), value).toBeUndefined();
    }
  });

  test("台帳から読める。形の違う番号は直さずに止める", () => {
    const raw = {
      schemaVersion: "1",
      sites: base.sites,
      posts: [],
      rankings: [],
    };
    const ledger = parsePostingLedger({
      ...raw,
      siteFacts: [{ site: "narou", siteWorkNumber: "2930206", siteWorkNumberAt: "2026-11-03T00:00:00.000Z" }],
    });
    expect(siteWorkNumberFor(ledger, "narou")).toBe("2930206");
    expect(() =>
      parsePostingLedger({
        ...raw,
        siteFacts: [{ site: "narou", siteWorkNumber: "n1234ab", siteWorkNumberAt: "2026-11-03T00:00:00.000Z" }],
      })
    ).toThrow();
    expect(() => parsePostingLedger({ ...raw, siteFacts: [{ site: "narou", siteWorkNumber: "1" }] })).toThrow();
  });
});

describe("サイトの話の番号", () => {
  const posted = withPost(base, "本文/001.txt", "kakuyomu", "2026-10-01T00:00:00.000Z", OLD);

  test("投稿の記録へ入れる（元の台帳は書き換えない）", () => {
    const next = withSiteEpisodeId(posted, "本文/001.txt", "kakuyomu", " 16816927859000000001 ");
    expect(next?.posts[0]).toMatchObject({ siteEpisodeId: "16816927859000000001", bodyHash: OLD });
    expect(siteEpisodeIdFor(next ?? posted, "本文/001.txt", "kakuyomu")).toBe("16816927859000000001");
    expect(posted.posts[0].siteEpisodeId).toBeUndefined();
  });

  test("当てる記録が無い・番号の形が違うときは undefined を返す（黙って捨てない）", () => {
    expect(withSiteEpisodeId(posted, "本文/002.txt", "kakuyomu", "1")).toBeUndefined();
    expect(withSiteEpisodeId(posted, "本文/001.txt", "narou", "1")).toBeUndefined();
    expect(withSiteEpisodeId(posted, "本文/001.txt", "kakuyomu", "../new")).toBeUndefined();
    expect(withSiteEpisodeId(posted, "本文/001.txt", "kakuyomu", "")).toBeUndefined();
  });

  test("合本の1話の番号を、ファイルまるごとの記録には付けない", () => {
    const fileLevel = withPost(base, "本文/all.txt", "kakuyomu", "2026-10-01T00:00:00.000Z");
    expect(withSiteEpisodeId(fileLevel, { episodePath: "本文/all.txt", chapter: 3 }, "kakuyomu", "9")).toBeUndefined();
    expect(siteEpisodeIdFor(
      withSiteEpisodeId(fileLevel, "本文/all.txt", "kakuyomu", "9") ?? fileLevel,
      { episodePath: "本文/all.txt", chapter: 3 },
      "kakuyomu"
    )).toBeUndefined();
  });

  test("同じ話・同じサイトの投稿の記録を置き換えても、番号は引き継ぐ", () => {
    const withId = withSiteEpisodeId(posted, "本文/001.txt", "kakuyomu", "123");
    const replaced = withPost(withId ?? posted, "本文/001.txt", "kakuyomu", "2026-11-01T00:00:00.000Z", NEW);
    expect(replaced.posts).toHaveLength(1);
    expect(replaced.posts[0]).toMatchObject({ siteEpisodeId: "123", bodyHash: NEW });
  });
});

describe("台帳の読み込み", () => {
  const raw = {
    schemaVersion: "1",
    sites: [{ site: "kakuyomu", newEpisodeUrl: "https://kakuyomu.jp/my/works/1/episodes/new" }],
    rankings: [],
  };

  test("印と話の番号を読める。無い記録には欄を足さない", () => {
    const ledger = parsePostingLedger({
      ...raw,
      posts: [
        { episodePath: "本文/001.txt", site: "kakuyomu", postedAt: "2026-10-01T00:00:00.000Z", bodyHash: OLD, siteEpisodeId: "42" },
        { episodePath: "本文/002.txt", site: "kakuyomu", postedAt: "2026-10-02T00:00:00.000Z", bodyHash: "", siteEpisodeId: "" },
      ],
      revisions: [
        { episodePath: "本文/001.txt", site: "kakuyomu", revisedAt: "2026-11-01T00:00:00.000Z", bodyHash: NEW },
      ],
    });
    expect(ledger.posts[0]).toMatchObject({ bodyHash: OLD, siteEpisodeId: "42" });
    expect("bodyHash" in ledger.posts[1]).toBe(false);
    expect("siteEpisodeId" in ledger.posts[1]).toBe(false);
    expect(ledger.revisions?.[0].bodyHash).toBe(NEW);
  });

  test("形の違う印・番号は直さずに止める", () => {
    const post = { episodePath: "本文/001.txt", site: "kakuyomu", postedAt: "2026-10-01T00:00:00.000Z" };
    expect(() => parsePostingLedger({ ...raw, posts: [{ ...post, bodyHash: 1 }] })).toThrow();
    expect(() => parsePostingLedger({ ...raw, posts: [{ ...post, bodyHash: "短い" }] })).toThrow();
    expect(() => parsePostingLedger({ ...raw, posts: [{ ...post, siteEpisodeId: "1/../2" }] })).toThrow();
    expect(() =>
      parsePostingLedger({
        ...raw,
        posts: [post],
        revisions: [{ episodePath: "本文/001.txt", site: "kakuyomu", revisedAt: "2026-11-01", bodyHash: "XYZ" }],
      })
    ).toThrow();
  });
});
