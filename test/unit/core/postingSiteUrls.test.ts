import { describe, expect, test } from "vitest";
import {
  deriveSiteProfile,
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

  test("アルファポリスとnoteは導かない（形が確かめられていない／作品の単位が無い）", () => {
    expect(
      deriveSiteProfile(
        "alphapolis",
        "https://www.alphapolis.co.jp/novel/manage/123456/7890123"
      )
    ).toEqual({});
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

  test("アルファポリス：作品IDがあっても組み立てない（IDの形が確かでない）", () => {
    expect(
      postingPageUrl("alphapolis", undefined, { workId: "123456789" })
    ).toBeUndefined();
    expect(
      postingPageUrl("alphapolis", undefined, { workId: "000000/0000" })
    ).toBeUndefined();
  });

  test("note：組み立てない（作品の単位が無い）", () => {
    expect(postingPageUrl("note", undefined, { workId: "123" })).toBeUndefined();
  });

  test("組み立てないサイトでも、台帳にあればそれを開く", () => {
    const narou = "https://syosetu.com/usernovelmanage/top/";
    expect(postingPageUrl("narou", narou, undefined)).toBe(narou);
    const alphapolis = "https://www.alphapolis.co.jp/novel/manage/000000/0000";
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
