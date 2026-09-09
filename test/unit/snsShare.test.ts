import { describe, expect, test } from "vitest";
import {
  X_SHARE_LABEL,
  workListUrl,
  xIntentUrl,
} from "../../src/core/snsShare";

/**
 * SNSへの告知貼り付け（設計書6.79.8）の純粋関数。
 *
 * **確かめるのは2つ。** どこへ飛ばすURLを作るか（各話ではなく作品の
 * 一覧である）と、Xの投稿画面へ渡す形（余計な引数を足さない）である。
 *
 * **サイトへは1本もHTTPを発しない**ので、ここで作るのは文字列だけ。
 */

describe("作品の各話一覧のURL", () => {
  test("台帳の作品ページURLがあれば、それを使う", () => {
    expect(
      workListUrl("kakuyomu", {
        workId: "16816927859",
        workUrl: "https://kakuyomu.jp/works/1177354054883808252",
      })
    ).toBe("https://kakuyomu.jp/works/1177354054883808252");
  });

  test("なろうは、作品IDから作品トップ（＝目次）を合成する", () => {
    expect(workListUrl("narou", { workId: "n1234ab" })).toBe(
      "https://ncode.syosetu.com/n1234ab/"
    );
  });

  test("なろうのNコードは、大文字・前後の空白を揃えてから使う", () => {
    // 台帳の作品IDは自由入力なので、作者は大文字でも書く
    expect(workListUrl("narou", { workId: " N1234AB " })).toBe(
      "https://ncode.syosetu.com/n1234ab/"
    );
  });

  test("Nコードの形でない作品IDでは、URLを作らない", () => {
    // 作品名やURLの断片が入っていることがある。埋めると存在しないページになる
    expect(workListUrl("narou", { workId: "図書塔の魔女" })).toBeUndefined();
  });

  test("カクヨムは、数字だけの作品IDのときに合成する", () => {
    expect(workListUrl("kakuyomu", { workId: "16816927859" })).toBe(
      "https://kakuyomu.jp/works/16816927859"
    );
    expect(workListUrl("kakuyomu", { workId: "works/1681" })).toBeUndefined();
  });

  test("アルファポリスは合成しない（作品IDが2部構成のため）", () => {
    expect(workListUrl("alphapolis", { workId: "123456" })).toBeUndefined();
    // 作品ページのURLを入れてあれば、それは使える
    expect(
      workListUrl("alphapolis", {
        workId: "123456",
        workUrl: "https://www.alphapolis.co.jp/novel/123456/7890",
      })
    ).toBe("https://www.alphapolis.co.jp/novel/123456/7890");
  });

  test("作品IDも作品ページURLも無ければ undefined（＝手入力へ）", () => {
    expect(workListUrl("narou", undefined)).toBeUndefined();
    expect(workListUrl("note", { genre: "エッセイ" })).toBeUndefined();
  });

  test("http／https 以外のURLは使わない", () => {
    // 台帳は作者が手で開いて直せる。読み込みでも弾いているが、
    // 開く直前にも確かめる（通る経路が違う）
    expect(
      workListUrl("narou", {
        workId: "n1234ab",
        workUrl: "javascript:alert(1)",
      })
    ).toBe("https://ncode.syosetu.com/n1234ab/");
  });
});

describe("Xの投稿画面のURL", () => {
  test("text だけを載せる（余計な引数を足さない）", () => {
    const url = new URL(xIntentUrl("こんにちは"));
    expect(url.origin + url.pathname).toBe("https://x.com/intent/post");
    expect([...url.searchParams.keys()]).toEqual(["text"]);
  });

  test("日本語・改行・ハッシュタグ・記号がそのまま復元できる", () => {
    const text =
      "第13話「邂逅」 更新しました\n塔の内側の話です\n#創作 #小説 R&D\nhttps://ncode.syosetu.com/n1234ab/";
    const url = new URL(xIntentUrl(text));
    expect(url.searchParams.get("text")).toBe(text);
  });

  test("「#」は素で置かない（そこから先が断片として捨てられる）", () => {
    const raw = xIntentUrl("#創作 & 更新");
    expect(raw).not.toContain("#");
    expect(raw).toContain("%23");
    // 「&」を素で置くと、そこから先が別の引数として読まれる
    expect(raw).toContain("%26");
  });
});

describe("貼り付け先の名前", () => {
  test("画面に出す文言は1か所だけが持つ", () => {
    // BlueskyなどのSNSを足すときは、この表へ行を足す（6.79.8）
    expect(X_SHARE_LABEL).toContain("X");
    expect(X_SHARE_LABEL).toContain("投稿画面");
  });
});
