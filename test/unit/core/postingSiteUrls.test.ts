import { describe, expect, test } from "vitest";
import {
  authorOnlyPage,
  authorOnlyPageNotice,
  deriveSiteProfile,
  followNewEpisodeUrl,
  NEW_EPISODE_URL_FOLLOW_QUESTION,
  newEpisodeUrlDraft,
  planNewEpisodeUrlOnWorkIdChange,
  postingPageUrl,
  readerStatsPageUrl,
} from "../../../src/core/postingSiteUrls";

/**
 * 投稿ページのURLから作品IDと作品ページを導く（設計書6.68.5）。
 *
 * **作者の実機の指摘から**（2026-09-22）。「作品ID・作品ページ・ジャンルを
 * 入れる」で3つとも手で打たせていたが、**作品IDと作品ページは、直前に
 * 貼ってもらった投稿ページのURLに書いてある**——「ジャンル以外は更新用URLから
 * 抽出できます」。
 *
 * 材料は作者の台帳に実際に入った値をそのまま使う（教科書チート_確認用）。
 *
 * **サイトへは触りにいかない**（6.68.1）。ここで動くのは文字列の読み取りだけ。
 */

/** 作者の台帳に実際に入った値（2026-09-22の実機） */
const 実機 = {
  newEpisodeUrl:
    "https://kakuyomu.jp/my/works/1177354054934574437/episodes/new",
  workId: "1177354054934574437",
  workUrl: "https://kakuyomu.jp/works/1177354054934574437",
};

describe("投稿ページのURLから導く", () => {
  test("カクヨム：作品IDと作品ページが、作者が手で入れた値と同じになる", () => {
    expect(deriveSiteProfile("kakuyomu", 実機.newEpisodeUrl)).toEqual({
      workId: 実機.workId,
      pageUrl: 実機.workUrl,
    });
  });

  test("なろう：Nコードと作品トップを導く（大文字は小文字へ揃える）", () => {
    expect(
      deriveSiteProfile(
        "narou",
        "https://syosetu.com/usernovelmanage/isnoveluploadmenu/ncode/N1234AB/"
      )
    ).toEqual({
      workId: "n1234ab",
      pageUrl: "https://ncode.syosetu.com/n1234ab/",
    });
  });

  test("なろう：`ncode` の前の部分が違う画面でも導ける", () => {
    // 管理画面のパスは画面によって変わる。頼るのは `ncode` の次の区画だけ
    expect(
      deriveSiteProfile("narou", "https://syosetu.com/usernovelmanage/top/ncode/n9999zz/")
        .workId
    ).toBe("n9999zz");
  });

  /*
    アルファポリスの作者用ページは /mypage/ の下にあり、作品IDは数字9桁が1つだけ出る
    （2026-11-01 作者の Chrome で確かめた。ヘルパー 0.14.2 の照合と同じ形）。
    読者向けの作品ページは /novel/{作者ID}/{作品ID} で作者IDが要るので、pageUrl は作らない
  */
  test("アルファポリス：投稿画面・作品の管理画面から9桁の作品IDを導く（作品ページは作らない）", () => {
    expect(
      deriveSiteProfile(
        "alphapolis",
        "https://www.alphapolis.co.jp/mypage/novel/save_episode/637622366"
      )
    ).toEqual({ workId: "637622366" });
    expect(
      deriveSiteProfile(
        "alphapolis",
        "https://www.alphapolis.co.jp/mypage/content/detail/637622366"
      )
    ).toEqual({ workId: "637622366" });
    // 話の編集画面（作品IDのあとに話IDが続く）からも、作品IDは読める（ヘルパーの照合と同じ形）
    expect(
      deriveSiteProfile(
        "alphapolis",
        "https://www.alphapolis.co.jp/mypage/novel/save_episode/637622366/123456"
      )
    ).toEqual({ workId: "637622366" });
  });

  test("アルファポリス：9桁でない・形の違うURLからは導かない", () => {
    for (const url of [
      // 0.116.1 まで例に出していた、実在しない形
      "https://www.alphapolis.co.jp/novel/manage/123456/7890123",
      "https://www.alphapolis.co.jp/mypage/novel/save_episode/63762236",
      "https://www.alphapolis.co.jp/mypage/novel/save_episode/6376223660",
      // 読者向けの作品ページ（作者IDと作品ID）。どちらが作品IDかを推し量らない
      "https://www.alphapolis.co.jp/novel/123456789/637622366",
    ]) {
      expect(deriveSiteProfile("alphapolis", url), url).toEqual({});
    }
  });

  test("noteは導かない（作品の単位が無い）", () => {
    expect(deriveSiteProfile("note", "https://note.com/notes/new")).toEqual({});
  });
});

describe("導けない形は、空のまま返す", () => {
  test("カクヨム：作品IDの位置が数字でなければ導かない", () => {
    // 作品を作る前の画面など。ここで埋めると、押した先が存在しないページになる
    expect(
      deriveSiteProfile("kakuyomu", "https://kakuyomu.jp/my/works/new")
    ).toEqual({});
  });

  test("別のサイトのURLからは導かない（ドメインを確かめる）", () => {
    expect(
      deriveSiteProfile("kakuyomu", "https://evilkakuyomu.jp/my/works/168/episodes/new")
    ).toEqual({});
  });

  test("なろう：Nコードとして読めない区画は導かない", () => {
    expect(
      deriveSiteProfile("narou", "https://syosetu.com/usernovelmanage/ncode/あいうえお/")
    ).toEqual({});
  });

  test("空・URLでない文字列・http以外は導かない", () => {
    expect(deriveSiteProfile("kakuyomu", "")).toEqual({});
    expect(deriveSiteProfile("kakuyomu", undefined)).toEqual({});
    expect(deriveSiteProfile("kakuyomu", "作品ID: 123")).toEqual({});
    expect(
      deriveSiteProfile("kakuyomu", "javascript:alert(1)//kakuyomu.jp")
    ).toEqual({});
  });
});

/**
 * 読者の反応を読む管理画面（設計書6.79.7）。
 *
 * **開くだけで、読みにはいかない。** 数字を拾うのは貼り込み係の仕事である。
 */
describe("管理画面のURL", () => {
  test("台帳の作品IDから組む（カクヨムの作品管理）", () => {
    expect(readerStatsPageUrl("kakuyomu", { workId: 実機.workId })).toBe(
      `https://kakuyomu.jp/my/works/${実機.workId}`
    );
  });

  test("作品IDが無ければ、投稿ページのURLから取る", () => {
    expect(
      readerStatsPageUrl("kakuyomu", undefined, 実機.newEpisodeUrl)
    ).toBe(`https://kakuyomu.jp/my/works/${実機.workId}`);
  });

  test("台帳の作品IDが数字でなければ、投稿ページのURLへ落ちる", () => {
    // 作品IDの欄は自由入力なので、作品名が入っていることがある
    expect(
      readerStatsPageUrl("kakuyomu", { workId: "教科書チート" }, 実機.newEpisodeUrl)
    ).toBe(`https://kakuyomu.jp/my/works/${実機.workId}`);
  });

  test("どちらも取れなければ undefined（呼ぶ側はボタンを出さない）", () => {
    expect(readerStatsPageUrl("kakuyomu", undefined, undefined)).toBeUndefined();
    expect(readerStatsPageUrl("kakuyomu", { genre: "異世界ファンタジー" })).toBeUndefined();
  });

  test("カクヨム以外は導かない（読み取りの対応が無い、または形が未確認）", () => {
    expect(readerStatsPageUrl("narou", { workId: "n1234ab" })).toBeUndefined();
    expect(
      readerStatsPageUrl("alphapolis", { workId: "123456/7890123" })
    ).toBeUndefined();
    expect(readerStatsPageUrl("note", { workId: "1" })).toBeUndefined();
  });
});

/**
 * コピーのあとに開く投稿ページ（作者の依頼、2026-09-23）。
 *
 * **推測のURLを開かせない。** 違うページが開くと、作者はそこが投稿欄だと
 * 思って別の作品へ貼る恐れがある。組み立てるのは、形を実機で確かめた
 * カクヨムだけ。
 */
describe("コピーのあとに開く投稿ページ", () => {
  test("台帳の投稿ページのURLが、作品IDからの組み立てに勝つ", () => {
    // 作者が自分の画面から貼った値がいちばん確か
    expect(
      postingPageUrl("kakuyomu", 実機.newEpisodeUrl, { workId: "999" })
    ).toBe(実機.newEpisodeUrl);
  });

  test("前後の空白は落として返す", () => {
    expect(
      postingPageUrl("kakuyomu", `  ${実機.newEpisodeUrl}\n`, undefined)
    ).toBe(実機.newEpisodeUrl);
  });

  test("カクヨム：投稿ページが無ければ、作品IDから組み立てる", () => {
    expect(
      postingPageUrl("kakuyomu", undefined, { workId: 実機.workId })
    ).toBe(実機.newEpisodeUrl);
  });

  test("カクヨム：作品IDが数字だけでなければ組み立てない", () => {
    // 作品IDの欄は自由入力。作品名やURLの断片が入っていることがある
    expect(
      postingPageUrl("kakuyomu", undefined, { workId: "氷の街" })
    ).toBeUndefined();
    expect(
      postingPageUrl("kakuyomu", undefined, { workId: 実機.workUrl })
    ).toBeUndefined();
  });

  test("なろう：Nコードがあっても組み立てない（新しい話の画面は内部の番号で指す）", () => {
    expect(
      postingPageUrl("narou", undefined, { workId: "n1234ab" })
    ).toBeUndefined();
  });

  test("アルファポリス：9桁の作品IDから新しい話の投稿画面を組み立てる（2026-11-01 に形を確かめた）", () => {
    expect(
      postingPageUrl("alphapolis", undefined, { workId: "637622366" })
    ).toBe("https://www.alphapolis.co.jp/mypage/novel/save_episode/637622366");
  });

  test("アルファポリス：9桁でない作品IDからは組み立てない（作品を指せないIDで別の画面を開かせない）", () => {
    for (const workId of ["000000/0000", "123456/7890123", "12345678", "1234567890", "作品名"]) {
      expect(postingPageUrl("alphapolis", undefined, { workId }), workId).toBeUndefined();
    }
  });

  test("note：組み立てない（作品の単位が無い）", () => {
    expect(postingPageUrl("note", undefined, { workId: "123" })).toBeUndefined();
  });

  test("組み立てないサイトでも、台帳にあればそれを開く", () => {
    const narou = "https://syosetu.com/usernovelmanage/top/";
    expect(postingPageUrl("narou", narou, undefined)).toBe(narou);
    const alphapolis = "https://www.alphapolis.co.jp/mypage/novel/save_episode/000000000";
    expect(postingPageUrl("alphapolis", alphapolis, undefined)).toBe(alphapolis);
  });

  test("何も無ければ undefined（ボタンを出さない）", () => {
    for (const site of ["narou", "kakuyomu", "alphapolis", "note"] as const) {
      expect(postingPageUrl(site, undefined, undefined)).toBeUndefined();
      expect(postingPageUrl(site, "", {})).toBeUndefined();
    }
  });

  /**
   * **台帳は作者が手で直せる。** 開く直前にも確かめる——別のサイトや
   * `javascript:` のURLを、そのまま既定のブラウザへ渡さない。
   */
  test("別のサイトのURLや http(s) でないものは開かない", () => {
    expect(
      postingPageUrl("narou", "https://example.com/syosetu.com/", undefined)
    ).toBeUndefined();
    expect(
      postingPageUrl("narou", "javascript:alert(1)", undefined)
    ).toBeUndefined();
    // カクヨムは台帳の値を捨てて、作品IDからの組み立てへ戻る
    expect(
      postingPageUrl("kakuyomu", "https://evil.example/kakuyomu.jp", {
        workId: 実機.workId,
      })
    ).toBe(実機.newEpisodeUrl);
  });
});

/**
 * 「投稿サイト設定」の投稿ページのURLを、作品IDから下書きする（作者に約束済み、
 * 2026-10-12）。URL が入っている作品で作品IDを書き換えたときは**確認で一言訊く**
 * （作者の裁定、2026-10-12 22時台）。手で入れた URL を黙って消さない。
 */
describe("投稿ページのURLの下書きと、作品IDを変えたときの問い", () => {
  const kakuyomuUrl = (id: string) => `https://kakuyomu.jp/my/works/${id}/episodes/new`;

  test("URL が空で作品IDがあれば、作品IDから組み立てた URL を下書きに入れる", () => {
    expect(newEpisodeUrlDraft("kakuyomu", undefined, 実機.workId)).toBe(
      実機.newEpisodeUrl
    );
    expect(newEpisodeUrlDraft("kakuyomu", "  ", 実機.workId)).toBe(実機.newEpisodeUrl);
  });

  test("URL が入っていれば、そのまま（組み立てた値で上書きしない）", () => {
    expect(newEpisodeUrlDraft("kakuyomu", kakuyomuUrl("1"), "2")).toBe(kakuyomuUrl("1"));
  });

  test("作品IDが無い・組み立てられないサイトなら、下書きは無い", () => {
    expect(newEpisodeUrlDraft("kakuyomu", undefined, undefined)).toBeUndefined();
    expect(newEpisodeUrlDraft("kakuyomu", undefined, "作品名")).toBeUndefined();
    expect(newEpisodeUrlDraft("narou", undefined, "n1234ab")).toBeUndefined();
  });

  test("URL が入っていて作品IDを変えたら、合わせるかを訊く", () => {
    expect(
      planNewEpisodeUrlOnWorkIdChange("kakuyomu", kakuyomuUrl("111"), "111", "222")
    ).toEqual({ kind: "ask", rebuilt: kakuyomuUrl("222") });
    expect(NEW_EPISODE_URL_FOLLOW_QUESTION).toBe(
      "投稿ページの URL を新しい作品IDに合わせますか"
    );
  });

  test("作品IDを変えていない・消した・URL がもう新しい作品IDを指すなら訊かない", () => {
    const url = kakuyomuUrl("111");
    expect(planNewEpisodeUrlOnWorkIdChange("kakuyomu", url, "111", " 111 ")).toEqual({
      kind: "none",
    });
    expect(planNewEpisodeUrlOnWorkIdChange("kakuyomu", url, "111", "")).toEqual({
      kind: "none",
    });
    // 作品IDを初めて入れたが、URL がもうその作品を指している
    expect(planNewEpisodeUrlOnWorkIdChange("kakuyomu", url, undefined, "111")).toEqual({
      kind: "none",
    });
    // 作品IDが数字でない（組み立てられない）なら訊かない
    expect(planNewEpisodeUrlOnWorkIdChange("kakuyomu", url, "111", "作品名")).toEqual({
      kind: "none",
    });
    // 組み立てられないサイトでは訊かない（推測のURLを入れない）
    expect(
      planNewEpisodeUrlOnWorkIdChange(
        "narou",
        "https://syosetu.com/usernovelmanage/top/ncode/n1/",
        "n1",
        "n2"
      )
    ).toEqual({ kind: "none" });
  });

  test("はいなら組み直し、いいえなら URL は変わらない", () => {
    const sites = [
      { site: "kakuyomu" as const, newEpisodeUrl: kakuyomuUrl("111") },
      {
        site: "narou" as const,
        newEpisodeUrl: "https://syosetu.com/usernovelmanage/top/ncode/n1/",
      },
    ];
    expect(followNewEpisodeUrl(sites, "kakuyomu", kakuyomuUrl("222"), false)).toEqual(
      sites
    );
    expect(followNewEpisodeUrl(sites, "kakuyomu", kakuyomuUrl("222"), true)).toEqual([
      { site: "kakuyomu", newEpisodeUrl: kakuyomuUrl("222") },
      sites[1],
    ]);
  });
});

/**
 * 作者だけが開けるページを、読者向けの作品ページと見分ける（2026-10-25 の実機確認）。
 *
 * 作者は「SNS告知設定」の作品ページの欄へ、クリップボードに残っていた
 * カクヨムの投稿ページ（`/my/works/…/episodes/new`）を入れ、そのまま告知に載った。
 * 読者が押しても開けないページである。
 */
describe("作者だけが開けるページ", () => {
  test("カクヨムの投稿ページは作者用。読者向けの作品ページへ直す先を返す", () => {
    expect(authorOnlyPage(実機.newEpisodeUrl)).toEqual({
      site: "kakuyomu",
      readerUrl: 実機.workUrl,
    });
  });

  test("カクヨムの /my/ の下はどれも作者用（作品の番号が無ければ直す先は出さない）", () => {
    expect(authorOnlyPage(`https://kakuyomu.jp/my/works/${実機.workId}`)).toEqual({
      site: "kakuyomu",
      readerUrl: 実機.workUrl,
    });
    expect(authorOnlyPage("https://kakuyomu.jp/my/")).toEqual({ site: "kakuyomu" });
  });

  test("なろうの管理画面は作者用。Nコードから作品トップを返す", () => {
    expect(
      authorOnlyPage("https://syosetu.com/usernovelmanage/top/ncode/N1234AB/")
    ).toEqual({ site: "narou", readerUrl: "https://ncode.syosetu.com/n1234ab/" });
    expect(authorOnlyPage("https://syosetu.com/draftepisode/input/")).toEqual({
      site: "narou",
    });
  });

  test("アルファポリスの /mypage/ の下（投稿画面・作品の管理画面）・note の編集画面も作者用", () => {
    // 2026-11-01 作者の Chrome で確かめた形（作者用ページはすべて /mypage/ の下）
    expect(
      authorOnlyPage("https://www.alphapolis.co.jp/mypage/novel/save_episode/637622366")
    ).toEqual({ site: "alphapolis" });
    expect(
      authorOnlyPage("https://www.alphapolis.co.jp/mypage/content/detail/637622366")
    ).toEqual({ site: "alphapolis" });
    expect(authorOnlyPage("https://editor.note.com/notes/abc/edit/")).toEqual({
      site: "note",
    });
  });

  test("読者向けの作品ページ・ほかのサイト・URLでないものは作者用と言わない", () => {
    for (const url of [
      実機.workUrl,
      `${実機.workUrl}/episodes/16816452219000000000`,
      "https://ncode.syosetu.com/n1234ab/",
      "https://ncode.syosetu.com/n1234ab/13/",
      "https://www.alphapolis.co.jp/novel/123456789/987654321",
      // パスのどこかに manage があるだけでは作者用と言わない（0.116.1 までの見分けは実在しない形だった）
      "https://www.alphapolis.co.jp/novel/123456789/987654321/manage",
      "https://note.com/someone/m/abc",
      "https://example.com/my/works/1",
      "",
      "作品ページ",
    ]) {
      expect(authorOnlyPage(url), url).toBeUndefined();
    }
  });

  test("知らせの文：読者は開けないことと、直す先を言う", () => {
    const notice = authorOnlyPageNotice(実機.newEpisodeUrl);
    expect(notice).toContain("読者は開けません");
    expect(notice).toContain(実機.workUrl);
    // 直す先が分からないサイトは、読者向けのページを貼ってもらう
    expect(
      authorOnlyPageNotice("https://www.alphapolis.co.jp/mypage/novel/save_episode/637622366")
    ).toContain("読者が開ける作品ページ");
    expect(authorOnlyPageNotice(実機.workUrl)).toBeUndefined();
  });
});
