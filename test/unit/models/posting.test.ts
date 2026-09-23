import { describe, expect, test } from "vitest";
import {
  POSTING_SITES,
  emptyPostingLedger,
  firstUnpostedEpisodePath,
  isPosted,
  latestRanking,
  parsePostingLedger,
  parseRankInput,
  postingSiteInfo,
  postingSiteLabels,
  rankingBoards,
  rankingsForSite,
  siteProfile,
  unpostedSites,
  validateNewEpisodeUrl,
  validateRankInput,
  validateWorkPageUrl,
  withBaselinePosts,
  withPost,
  withRanking,
  withSiteProfile,
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

/**
 * サイトごとの作品情報（設計書6.68.5）。
 *
 * **サイトへ取りに行かない。** ここに入るのは作者が手で入れた値だけである
 * （作品ID・作品ページのURL・ジャンル・メモ）。どれも任意で、
 * **空のまま使い続けられる**こと自体が仕様である。
 */
describe("サイトごとの作品情報", () => {
  test("作品ページのURLは、そのサイトのドメインだけ受ける", () => {
    expect(validateWorkPageUrl("narou", "https://ncode.syosetu.com/n1234ab/")).toBeNull();
    expect(validateWorkPageUrl("kakuyomu", url.narou)).toContain("kakuyomu.jp");
    expect(validateWorkPageUrl("note", "note.com/nonahisa")).toContain("http");
  });

  /** **入れないまま進める。** 任意の情報なので、空を「間違い」と言わない */
  test("作品ページのURLは、空でもよい（投稿ページのURLとはここが違う）", () => {
    expect(validateWorkPageUrl("narou", "")).toBeNull();
    expect(validateWorkPageUrl("narou", "   ")).toBeNull();
    // 投稿ページのほうは、無いと投稿の案内が成り立たないので必須のまま
    expect(validateNewEpisodeUrl("narou", "")).toContain("URL");
  });

  test("書いてある作品情報を、そのまま読む", () => {
    const ledger = parsePostingLedger({
      sites: [{ site: "narou", newEpisodeUrl: url.narou }],
      siteProfiles: [
        {
          site: "narou",
          workId: "n1234ab",
          workUrl: "https://ncode.syosetu.com/n1234ab/",
          genre: "ハイファンタジー",
          note: "完結済みで再掲",
        },
      ],
    });

    expect(siteProfile(ledger, "narou")).toEqual({
      workId: "n1234ab",
      workUrl: "https://ncode.syosetu.com/n1234ab/",
      genre: "ハイファンタジー",
      note: "完結済みで再掲",
    });
  });

  test("別のサイトの作品ページURLは、直さずに止める", () => {
    expect(() =>
      parsePostingLedger({
        sites: [{ site: "note", newEpisodeUrl: url.note }],
        siteProfiles: [{ site: "note", workUrl: url.kakuyomu }],
      })
    ).toThrow();
  });

  test("空の作品情報は持ち歩かない（読み直すたびに中身が増えない）", () => {
    const ledger = parsePostingLedger({
      sites: [{ site: "note", newEpisodeUrl: url.note }],
      siteProfiles: [{ site: "note", workId: "  ", genre: "" }],
    });

    expect(ledger.siteProfiles).toEqual([]);
    expect(siteProfile(ledger, "note")).toBeUndefined();
  });

  /**
   * **作品情報はサイトの登録から独立している**（設計書6.68.5）。
   *
   * 台帳直下の `siteProfiles` に持つので、投稿サイトの設定でチェックを
   * 外しても消えない——作者が書いた `note` まで巻き添えにしない
   * （`rankings` を残しているのと同じ理由）。
   */
  test("サイトを外しても、そのサイトの作品情報は残る", () => {
    const before = withSiteProfile(
      withSites(emptyPostingLedger(), [
        { site: "narou", newEpisodeUrl: url.narou },
      ]),
      "narou",
      { workId: "n1234ab", note: "完結済みで再掲" }
    );

    // 「なろうのチェックを外す」＝サイトの一覧を空にして置き換える
    const after = withSites(before, []);

    expect(after.sites).toEqual([]);
    expect(siteProfile(after, "narou")).toEqual({
      workId: "n1234ab",
      note: "完結済みで再掲",
    });
  });

  test("作品情報を書き換えても、元の台帳は変わらない（写しで持つ）", () => {
    const before = withSiteProfile(emptyPostingLedger(), "narou", {
      workId: "n1234ab",
    });
    const after = withSiteProfile(before, "narou", { workId: "n9999zz" });

    expect(siteProfile(before, "narou")?.workId).toBe("n1234ab");
    expect(siteProfile(after, "narou")?.workId).toBe("n9999zz");
    // 並びは動かさない（Gitの差分が、直した1行だけになるように）
    expect(after.siteProfiles.map((entry) => entry.site)).toEqual(["narou"]);
  });

  test("全部の欄を空にすると、作品情報の行ごと消える", () => {
    const before = withSiteProfile(emptyPostingLedger(), "narou", {
      workId: "n1234ab",
    });
    const after = withSiteProfile(before, "narou", { workId: "  " });

    expect(after.siteProfiles).toEqual([]);
  });
});

/**
 * 旧形式（`sites[].profile`）の読み取り（設計書6.68.5）。
 *
 * 0.32.0 までは作品情報をサイトの欄の中に持っていた。**その台帳を読んでも
 * 値は1つも失わない**——読み込みで台帳直下の `siteProfiles` へ持ち上げる。
 * 書き出しは新形式だけで、`sites[].profile` はもう書かない。
 */
describe("旧形式の作品情報を持ち上げる", () => {
  test("`sites[].profile` は `siteProfiles` へ持ち上がる", () => {
    const ledger = parsePostingLedger({
      sites: [
        {
          site: "narou",
          newEpisodeUrl: url.narou,
          profile: {
            workId: "n1234ab",
            workUrl: "https://ncode.syosetu.com/n1234ab/",
            genre: "ハイファンタジー",
            note: "完結済みで再掲",
          },
        },
        { site: "kakuyomu", newEpisodeUrl: url.kakuyomu },
      ],
    });

    expect(siteProfile(ledger, "narou")).toEqual({
      workId: "n1234ab",
      workUrl: "https://ncode.syosetu.com/n1234ab/",
      genre: "ハイファンタジー",
      note: "完結済みで再掲",
    });
    // 持ち上げたら、サイトの欄には残さない（書き戻しで新形式になる）
    expect(
      (ledger.sites[0] as unknown as { profile?: unknown }).profile
    ).toBeUndefined();
    expect(siteProfile(ledger, "kakuyomu")).toBeUndefined();
  });

  test("旧形式の作品ページURLも、そのサイトのドメインだけ受ける", () => {
    expect(() =>
      parsePostingLedger({
        sites: [
          {
            site: "note",
            newEpisodeUrl: url.note,
            profile: { workUrl: url.kakuyomu },
          },
        ],
      })
    ).toThrow();
  });

  /**
   * **新形式を優先する。** 両方あるのは、新形式で書いたあとに古い版で
   * 開いた台帳などである。どちらか片方しか採れないので、新しいほうを採る。
   */
  test("`siteProfiles` と旧 `sites[].profile` が両方あれば、新形式が勝つ", () => {
    const ledger = parsePostingLedger({
      sites: [
        {
          site: "narou",
          newEpisodeUrl: url.narou,
          profile: { workId: "旧", genre: "旧ジャンル" },
        },
      ],
      siteProfiles: [{ site: "narou", workId: "新" }],
    });

    expect(siteProfile(ledger, "narou")).toEqual({ workId: "新" });
    expect(ledger.siteProfiles).toHaveLength(1);
  });

  test("同じサイトの作品情報が2つ書いてあれば、読めないと言って止める", () => {
    expect(() =>
      parsePostingLedger({
        sites: [{ site: "narou", newEpisodeUrl: url.narou }],
        siteProfiles: [
          { site: "narou", workId: "n1234ab" },
          { site: "narou", workId: "n9999zz" },
        ],
      })
    ).toThrow();
  });
});

/**
 * ランキングの記録（設計書6.68.5）。
 *
 * **サイトから取りに行かない**（6.68.1と同じ線）。記録するのは、作者が
 * 画面で見た値だけである。種別（日間・週間・ジャンル別…）はサイトごとに
 * 呼び方が違うので**自由入力**にし、こちらで一覧を決め打ちしない。
 */
describe("ランキングの記録", () => {
  const registered: PostingLedger = withSites(emptyPostingLedger(), [
    { site: "narou", newEpisodeUrl: url.narou },
    { site: "kakuyomu", newEpisodeUrl: url.kakuyomu },
  ]);

  function ranked(
    site: "narou" | "kakuyomu",
    recordedAt: string,
    board: string,
    rank: number
  ) {
    return { site, recordedAt, board, rank } as const;
  }

  test("追記しても、既にある記録は1つも変わらない", () => {
    const first = withRanking(
      registered,
      ranked("narou", "2026-09-01T00:00:00.000Z", "日間", 12)
    );
    const second = withRanking(
      first,
      ranked("narou", "2026-09-04T00:00:00.000Z", "日間", 5)
    );

    expect(first.rankings).toHaveLength(1);
    expect(second.rankings).toHaveLength(2);
    expect(second.rankings[0]).toEqual(first.rankings[0]);
  });

  test("順位は1以上の整数だけ（0・負・小数は断る）", () => {
    for (const rank of [0, -1, 1.5]) {
      expect(() =>
        withRanking(registered, {
          site: "narou",
          recordedAt: "2026-09-04T00:00:00.000Z",
          board: "日間",
          rank,
        })
      ).toThrow();
    }
  });

  test("メモは任意（無ければ項目ごと持たない）", () => {
    const ledger = withRanking(registered, {
      site: "narou",
      recordedAt: "2026-09-04T00:00:00.000Z",
      board: "日間",
      rank: 12,
    });

    expect(ledger.rankings[0].note).toBeUndefined();
  });

  test("新しい順で読める（画面はこの順に並べる）", () => {
    let ledger = withRanking(
      registered,
      ranked("narou", "2026-09-01T00:00:00.000Z", "日間", 12)
    );
    ledger = withRanking(
      ledger,
      ranked("narou", "2026-09-04T00:00:00.000Z", "週間", 3)
    );
    ledger = withRanking(
      ledger,
      ranked("kakuyomu", "2026-09-03T00:00:00.000Z", "週間", 40)
    );

    expect(rankingsForSite(ledger, "narou").map((entry) => entry.rank)).toEqual([
      3, 12,
    ]);
    expect(latestRanking(ledger, "narou")?.board).toBe("週間");
    // ほかのサイトの記録は混ざらない
    expect(latestRanking(ledger, "kakuyomu")?.rank).toBe(40);
    expect(latestRanking(ledger, "note")).toBeUndefined();
  });

  /** **候補は作者が使った言葉から作る。** こちらで種別を決め打ちしない */
  test("過去に使った種別が、そのサイトのぶんから先に並ぶ", () => {
    let ledger = withRanking(
      registered,
      ranked("narou", "2026-09-01T00:00:00.000Z", "日間", 12)
    );
    ledger = withRanking(
      ledger,
      ranked("narou", "2026-09-04T00:00:00.000Z", "週間", 3)
    );
    ledger = withRanking(
      ledger,
      ranked("narou", "2026-09-05T00:00:00.000Z", "日間", 8)
    );
    ledger = withRanking(
      ledger,
      ranked("kakuyomu", "2026-09-03T00:00:00.000Z", "ジャンル別", 40)
    );

    // 新しく使ったものが先。同じ種別は1つにまとめる
    expect(rankingBoards(ledger, "narou")).toEqual([
      "日間",
      "週間",
      "ジャンル別",
    ]);
    // そのサイトの記録が無ければ、ほかのサイトで使った種別を新しい順に出す
    expect(rankingBoards(ledger, "note")).toEqual([
      "日間",
      "週間",
      "ジャンル別",
    ]);
  });

  test("読み書きで、記録がそのまま残る", () => {
    const ledger = parsePostingLedger({
      rankings: [
        {
          site: "narou",
          recordedAt: "2026-09-04T00:00:00.000Z",
          board: "日間",
          rank: 12,
          note: "更新直後",
        },
      ],
    });

    expect(ledger.rankings[0]).toEqual({
      site: "narou",
      recordedAt: "2026-09-04T00:00:00.000Z",
      board: "日間",
      rank: 12,
      note: "更新直後",
    });
  });

  test("順位が壊れていれば、読めないと言って止める（黙って直さない）", () => {
    for (const rank of [0, -3, 2.5, "12位"]) {
      expect(() =>
        parsePostingLedger({
          rankings: [
            {
              site: "narou",
              recordedAt: "2026-09-04T00:00:00.000Z",
              board: "日間",
              rank,
            },
          ],
        })
      ).toThrow();
    }
  });

  test("種別が空なら止める（何の順位か分からない記録を残さない）", () => {
    expect(() =>
      parsePostingLedger({
        rankings: [
          {
            site: "narou",
            recordedAt: "2026-09-04T00:00:00.000Z",
            board: "  ",
            rank: 3,
          },
        ],
      })
    ).toThrow();
  });

  /**
   * **古い台帳がそのまま読めること。** この機能より前に作られた
   * `投稿状態.json` には `rankings` も `profile` も無い。
   */
  test("欄の無い古い台帳は、空として読める", () => {
    const ledger = parsePostingLedger({
      schemaVersion: "1",
      sites: [{ site: "narou", newEpisodeUrl: url.narou }],
      posts: [
        {
          episodePath: "本文/001.txt",
          site: "narou",
          postedAt: "2026-09-01T00:00:00.000Z",
        },
      ],
    });

    expect(ledger.rankings).toEqual([]);
    expect(ledger.siteProfiles).toEqual([]);
    // 既にある記録は、読み直しで1つも変わらない
    expect(ledger.posts).toHaveLength(1);
  });
});

/**
 * 順位の入力（設計書6.68.5）。
 *
 * **日本語入力のまま打つと全角になる。** 「１２」を断ると、作者は
 * 変換の仕方を疑うことになる——読めるものは読む。
 */
describe("順位の入力", () => {
  test("半角も全角も、同じ数として読む", () => {
    expect(parseRankInput("12")).toBe(12);
    expect(parseRankInput("１２")).toBe(12);
    expect(parseRankInput(" 3 ")).toBe(3);
  });

  test("1未満・小数・数でないものは読まない", () => {
    for (const value of ["0", "-1", "1.5", "", "十二", "12位"]) {
      expect(parseRankInput(value), value).toBeNull();
    }
  });

  test("断るときは、理由を日本語で返す", () => {
    expect(validateRankInput("12")).toBeNull();
    expect(validateRankInput("0")).toContain("1");
    expect(validateRankInput("")).toContain("順位");
  });
});
