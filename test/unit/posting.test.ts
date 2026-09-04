import { describe, expect, test } from "vitest";
import {
  POSTING_SITES,
  emptyPostingLedger,
  firstUnpostedEpisodePath,
  isPosted,
  parsePostingLedger,
  postingSiteInfo,
  postingSiteLabels,
  unpostedSites,
  validateNewEpisodeUrl,
  withBaselinePosts,
  withPost,
  withSites,
  type PostingLedger,
} from "../../src/models/posting";

/**
 * 投稿状態の台帳（設計書6.68.2）。
 *
 * **自動投稿はしない**（6.68.1）。ここが持つのは「どの話を、どのサイトへ、
 * いつ出したか」の記録と、作者が貼った投稿ページのURLだけである。
 * サイトへ触りにいく処理は1つも無い。
 *
 * 作者が手で開いて直すJSONなので、**壊れていたら直さずに止める**
 * （章立て・本の設計図と同じ約束）。
 */

const url = {
  narou: "https://syosetu.com/usernovelmanage/isnoveluploadmenu/ncode/n1234ab/",
  kakuyomu: "https://kakuyomu.jp/my/works/1177354054892/episodes/new",
  alphapolis: "https://www.alphapolis.co.jp/novel/manage/123456/789",
  note: "https://note.com/notes/new",
};

describe("サイトの一覧", () => {
  test("4つのサイトを、表示名つきで持つ", () => {
    expect(POSTING_SITES.map((site) => site.id)).toEqual([
      "narou",
      "kakuyomu",
      "alphapolis",
      "note",
    ]);
    expect(postingSiteInfo("kakuyomu").label).toBe("カクヨム");
    expect(postingSiteLabels(["note", "narou"])).toBe(
      "小説家になろう・note"
    );
  });

  /**
   * **noteだけ記法が違う。** ルビの記法が無いので括弧書きへ落とす
   * （`core/ruby.ts` の "paren"）。ほかの3つは `｜漢字《かんじ》` で通る。
   */
  test("noteは括弧書き、ほかの3つは投稿サイト記法", () => {
    expect(postingSiteInfo("note").notation).toBe("paren");
    for (const id of ["narou", "kakuyomu", "alphapolis"] as const) {
      expect(postingSiteInfo(id).notation, id).toBe("site");
    }
    // 傍点の書き方はカクヨムだけが専用記法を持つ（6.12.4）
    expect(postingSiteInfo("kakuyomu").emphasis).toBe("kakuyomu");
    expect(postingSiteInfo("narou").emphasis).toBe("narou");
    expect(postingSiteInfo("alphapolis").emphasis).toBe("narou");
  });
});

describe("投稿ページのURL", () => {
  test("そのサイトのURLなら受ける", () => {
    expect(validateNewEpisodeUrl("narou", url.narou)).toBeNull();
    expect(validateNewEpisodeUrl("kakuyomu", url.kakuyomu)).toBeNull();
    expect(validateNewEpisodeUrl("alphapolis", url.alphapolis)).toBeNull();
    expect(validateNewEpisodeUrl("note", url.note)).toBeNull();
  });

  test("サブドメインでも受ける（作者が貼る画面はまちまち）", () => {
    expect(
      validateNewEpisodeUrl("narou", "https://mypage.syosetu.com/mypage/")
    ).toBeNull();
  });

  /** **中身は見ない。** 確かめるのは「そのサイトか」だけである（6.68.1） */
  test("別のサイトのURLは断る", () => {
    expect(validateNewEpisodeUrl("kakuyomu", url.narou)).toContain("kakuyomu.jp");
    expect(validateNewEpisodeUrl("note", url.kakuyomu)).toContain("note.com");
  });

  test("URLでないものは断る", () => {
    expect(validateNewEpisodeUrl("note", "note.com/notes/new")).toContain(
      "http"
    );
    expect(validateNewEpisodeUrl("note", "")).toContain("URL");
    // ファイルや javascript: を開かせない
    expect(validateNewEpisodeUrl("note", "javascript:alert(1)")).toContain(
      "http"
    );
  });
});

describe("台帳を読む", () => {
  test("無い項目は空として読む", () => {
    expect(parsePostingLedger({})).toEqual(emptyPostingLedger());
  });

  test("書いてあるものを、そのまま読む（パスの区切りは / へ揃える）", () => {
    const ledger = parsePostingLedger({
      schemaVersion: "1",
      sites: [{ site: "kakuyomu", newEpisodeUrl: url.kakuyomu }],
      posts: [
        {
          episodePath: "本文\\001.txt",
          site: "kakuyomu",
          postedAt: "2026-09-04T10:00:00.000Z",
        },
      ],
    });

    expect(ledger.sites).toEqual([
      { site: "kakuyomu", newEpisodeUrl: url.kakuyomu },
    ]);
    expect(ledger.posts[0].episodePath).toBe("本文/001.txt");
  });

  test("知らないサイトは読めないと言って止める", () => {
    expect(() =>
      parsePostingLedger({
        sites: [{ site: "pixiv", newEpisodeUrl: "https://www.pixiv.net/" }],
      })
    ).toThrow();
  });

  test("サイトのURLが別のサイトなら止める（黙って直さない）", () => {
    expect(() =>
      parsePostingLedger({
        sites: [{ site: "note", newEpisodeUrl: url.kakuyomu }],
      })
    ).toThrow();
  });

  test("同じサイトが2つ書いてあれば止める", () => {
    expect(() =>
      parsePostingLedger({
        sites: [
          { site: "note", newEpisodeUrl: url.note },
          { site: "note", newEpisodeUrl: "https://note.com/other" },
        ],
      })
    ).toThrow();
  });

  test("投稿の記録に日時が無ければ止める", () => {
    expect(() =>
      parsePostingLedger({
        posts: [{ episodePath: "本文/001.txt", site: "note" }],
      })
    ).toThrow();
  });
});

describe("未投稿の見分け", () => {
  const registered: PostingLedger = withSites(emptyPostingLedger(), [
    { site: "narou", newEpisodeUrl: url.narou },
    { site: "kakuyomu", newEpisodeUrl: url.kakuyomu },
  ]);
  const episodes = ["本文/001.txt", "本文/002.txt", "本文/003.txt"];

  test("記録が無ければ、登録したサイトすべてが未投稿", () => {
    expect(unpostedSites(registered, "本文/001.txt")).toEqual([
      "narou",
      "kakuyomu",
    ]);
  });

  test("登録していないサイトは数えない（noteに出さない作品）", () => {
    expect(unpostedSites(registered, "本文/001.txt")).not.toContain("note");
  });

  test("対象サイトを1つも登録していなければ、未投稿は0（印を出さない）", () => {
    expect(unpostedSites(emptyPostingLedger(), "本文/001.txt")).toEqual([]);
  });

  test("台帳が空なら、いちばん古い話から始める", () => {
    expect(firstUnpostedEpisodePath(registered, episodes)).toBe("本文/001.txt");
  });

  test("片方のサイトだけ出していれば、その話はまだ未投稿のまま", () => {
    const ledger = withPost(registered, "本文/001.txt", "narou", "2026-09-04T00:00:00.000Z");

    expect(unpostedSites(ledger, "本文/001.txt")).toEqual(["kakuyomu"]);
    expect(firstUnpostedEpisodePath(ledger, episodes)).toBe("本文/001.txt");
  });

  test("全部のサイトへ出した話は飛ばして、その次を返す", () => {
    let ledger = registered;
    for (const site of ["narou", "kakuyomu"] as const) {
      ledger = withPost(ledger, "本文/001.txt", site, "2026-09-04T00:00:00.000Z");
    }

    expect(firstUnpostedEpisodePath(ledger, episodes)).toBe("本文/002.txt");
  });

  test("全部済んでいれば、未投稿はありませんと分かる", () => {
    let ledger = registered;
    for (const episodePath of episodes) {
      for (const site of ["narou", "kakuyomu"] as const) {
        ledger = withPost(ledger, episodePath, site, "2026-09-04T00:00:00.000Z");
      }
    }

    expect(firstUnpostedEpisodePath(ledger, episodes)).toBeUndefined();
  });
});

describe("記録する", () => {
  test("元の台帳は書き換えない（保存に失敗したときに画面だけ進まない）", () => {
    const before = withSites(emptyPostingLedger(), [
      { site: "note", newEpisodeUrl: url.note },
    ]);
    const after = withPost(before, "本文/001.txt", "note", "2026-09-04T00:00:00.000Z");

    expect(before.posts).toEqual([]);
    expect(after.posts).toHaveLength(1);
    expect(isPosted(after, "本文/001.txt", "note")).toBe(true);
    expect(isPosted(before, "本文/001.txt", "note")).toBe(false);
  });

  test("同じ話・同じサイトを2度記録しても、記録は1件のまま（日時は新しいほう）", () => {
    let ledger = withSites(emptyPostingLedger(), [
      { site: "note", newEpisodeUrl: url.note },
    ]);
    ledger = withPost(ledger, "本文/001.txt", "note", "2026-09-01T00:00:00.000Z");
    ledger = withPost(ledger, "本文/001.txt", "note", "2026-09-04T00:00:00.000Z");

    expect(ledger.posts).toHaveLength(1);
    expect(ledger.posts[0].postedAt).toBe("2026-09-04T00:00:00.000Z");
  });

  test("パスの区切りが違っても、同じ話として扱う", () => {
    const ledger = withPost(
      emptyPostingLedger(),
      "本文\\001.txt",
      "note",
      "2026-09-04T00:00:00.000Z"
    );

    expect(isPosted(ledger, "本文/001.txt", "note")).toBe(true);
  });
});

/**
 * 投稿済みの基準線（設計書6.68.2）。
 *
 * **導入前に出した話まで「未投稿」と数えない。** 19話まで書いてから
 * この機能を使い始めた作品で、全話に「未投稿2」が並んでも役に立たない。
 * 初回に「どの話まで出しましたか」を1度だけ訊いて、そこまでを記録する。
 *
 * **実際に投稿した記録と見分けられるようにする**（`importedBaseline`）。
 * 「導入時にまとめて入れた」ものと「投稿しましたと答えた」ものは、
 * あとから台帳を読むときに意味が違う。
 */
describe("投稿済みの基準線", () => {
  const registered: PostingLedger = withSites(emptyPostingLedger(), [
    { site: "narou", newEpisodeUrl: url.narou },
    { site: "kakuyomu", newEpisodeUrl: url.kakuyomu },
  ]);
  const episodes = ["本文/001.txt", "本文/002.txt", "本文/003.txt"];

  test("選んだ話までを、選んだ全サイトへ記録する", () => {
    const ledger = withBaselinePosts(
      registered,
      ["本文/001.txt", "本文/002.txt"],
      ["narou", "kakuyomu"],
      "2026-09-04T00:00:00.000Z"
    );

    expect(ledger.posts).toHaveLength(4);
    expect(firstUnpostedEpisodePath(ledger, episodes)).toBe("本文/003.txt");
  });

  test("導入時に入れた印が付く（実際の投稿と見分けられる）", () => {
    const ledger = withBaselinePosts(
      registered,
      ["本文/001.txt"],
      ["narou"],
      "2026-09-04T00:00:00.000Z"
    );

    expect(ledger.posts[0].importedBaseline).toBe(true);
  });

  test("「投稿しました」の記録には、その印を付けない", () => {
    const ledger = withPost(
      registered,
      "本文/001.txt",
      "narou",
      "2026-09-04T00:00:00.000Z"
    );

    expect(ledger.posts[0].importedBaseline).toBeUndefined();
  });

  /** 実際に出した記録を、あとからの基準線で塗り替えない */
  test("既にある記録は書き換えない", () => {
    const posted = withPost(
      registered,
      "本文/001.txt",
      "narou",
      "2026-09-01T00:00:00.000Z"
    );
    const ledger = withBaselinePosts(
      posted,
      ["本文/001.txt"],
      ["narou", "kakuyomu"],
      "2026-09-04T00:00:00.000Z"
    );

    const narou = ledger.posts.find((post) => post.site === "narou");
    expect(narou?.postedAt).toBe("2026-09-01T00:00:00.000Z");
    expect(narou?.importedBaseline).toBeUndefined();
    // 足りないほうのサイトだけが基準線で埋まる
    expect(
      ledger.posts.find((post) => post.site === "kakuyomu")?.importedBaseline
    ).toBe(true);
  });

  test("「最初から」を選べば、1件も記録しない", () => {
    const ledger = withBaselinePosts(
      registered,
      [],
      ["narou", "kakuyomu"],
      "2026-09-04T00:00:00.000Z"
    );

    expect(ledger.posts).toEqual([]);
    expect(firstUnpostedEpisodePath(ledger, episodes)).toBe("本文/001.txt");
  });

  test("元の台帳は書き換えない", () => {
    withBaselinePosts(
      registered,
      episodes,
      ["narou"],
      "2026-09-04T00:00:00.000Z"
    );

    expect(registered.posts).toEqual([]);
  });

  test("印は読み書きで保たれる", () => {
    const ledger = parsePostingLedger({
      posts: [
        {
          episodePath: "本文/001.txt",
          site: "narou",
          postedAt: "2026-09-04T00:00:00.000Z",
          importedBaseline: true,
        },
      ],
    });

    expect(ledger.posts[0].importedBaseline).toBe(true);
  });

  test("印が真偽値でなければ、読めないと言って止める", () => {
    expect(() =>
      parsePostingLedger({
        posts: [
          {
            episodePath: "本文/001.txt",
            site: "narou",
            postedAt: "2026-09-04T00:00:00.000Z",
            importedBaseline: "はい",
          },
        ],
      })
    ).toThrow();
  });
});
