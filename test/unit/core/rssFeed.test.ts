import { describe, expect, test } from "vitest";
import { decodeXmlEntities, htmlToText, parseRssFeed } from "../../../src/core/rssFeed";

/**
 * RSS 2.0 の小さな読み手（設計書6.3.6.2）。
 *
 * DOMParser の無い Node（拡張機能の本体）でも、ブラウザ版でも同じに動くよう、
 * 外部のライブラリを足さずに読む。見本の公募はすべて作り物である。
 */

const FEED = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">',
  "<channel>",
  "<title>作り物の公募一覧</title>",
  "<link>https://example.com/kobo/novel/</link>",
  '<atom:link href="https://example.com/kobo/novel/feed.xml" rel="self" type="application/rss+xml"/>',
  "<item>",
  "<title>第9回 みずうみ短編賞</title>",
  "<link>https://example.com/kobo/abc</link>",
  '<guid isPermaLink="true">https://example.com/kobo/abc</guid>',
  "<description>湖を舞台にした短編を募集します。 応募資格 : プロ・アマ不問 〆切 : WEB応募：2026年10月31日</description>",
  "<pubDate>Fri, 18 Sep 2026 06:23:25 GMT</pubDate>",
  "<atom:updated>2026-09-18T09:25:18.000Z</atom:updated>",
  "<category>漫画</category>",
  "<category>小説</category>",
  "</item>",
  "<item>",
  "<title><![CDATA[「星と&海」大賞]]></title>",
  "<link>https://example.com/kobo/def?a=1&amp;b=2</link>",
  "<description><![CDATA[<p>SFを募集。</p><p>募集内容 : 10,000字以上 &amp; 未発表</p>]]></description>",
  "</item>",
  "<item>",
  "<title>R&amp;D &lt;新人&gt; 賞 &#x2764; &#12354;</title>",
  "<link>javascript:alert(1)</link>",
  "<description>&lt;b&gt;太字&lt;/b&gt;の説明&lt;br/&gt;次の行 〆切 : 2027年1月8日</description>",
  "</item>",
  "</channel>",
  "</rss>",
].join("\n");

describe("RSS を読む", () => {
  test("item ごとに title・link・guid・description・日付・分類を取る", () => {
    const result = parseRssFeed(FEED);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.channelTitle).toBe("作り物の公募一覧");
    // atom:link（フィード自身の場所）ではなく、一覧のページ
    expect(result.channelLink).toBe("https://example.com/kobo/novel/");
    expect(result.items).toHaveLength(3);
    const first = result.items[0];
    expect(first.title).toBe("第9回 みずうみ短編賞");
    expect(first.link).toBe("https://example.com/kobo/abc");
    expect(first.guid).toBe("https://example.com/kobo/abc");
    expect(first.description).toContain("〆切 : WEB応募：2026年10月31日");
    expect(first.pubDate).toBe("Fri, 18 Sep 2026 06:23:25 GMT");
    expect(first.updated).toBe("2026-09-18T09:25:18.000Z");
    expect(first.categories).toEqual(["漫画", "小説"]);
  });

  test("CDATA の中身はそのまま、外の実体参照は戻す", () => {
    const result = parseRssFeed(FEED);
    if (!result.ok) throw new Error(result.reason);
    const second = result.items[1];
    // CDATA の中の「&」は実体参照ではない
    expect(second.title).toBe("「星と&海」大賞");
    expect(second.link).toBe("https://example.com/kobo/def?a=1&b=2");
  });

  test("説明の HTML は文字にする（段落は改行、実体参照は戻す）", () => {
    const result = parseRssFeed(FEED);
    if (!result.ok) throw new Error(result.reason);
    expect(result.items[1].description).toBe("SFを募集。\n募集内容 : 10,000字以上 & 未発表");
    // 実体参照で書かれた HTML（RSS のよくある書き方）も文字にする
    expect(result.items[2].description).toBe("太字の説明\n次の行 〆切 : 2027年1月8日");
  });

  test("数値文字参照（10進・16進）を戻す", () => {
    const result = parseRssFeed(FEED);
    if (!result.ok) throw new Error(result.reason);
    expect(result.items[2].title).toBe("R&D <新人> 賞 ❤ あ");
  });

  test("http・https でないリンクは持たない", () => {
    const result = parseRssFeed(FEED);
    if (!result.ok) throw new Error(result.reason);
    expect(result.items[2].link).toBeNull();
  });

  test("RSS でない文は理由を言って止める（HTML のページ・空）", () => {
    const html = parseRssFeed("<!DOCTYPE html><html><body>メンテナンス中</body></html>");
    expect(html.ok).toBe(false);
    if (!html.ok) expect(html.reason).toContain("RSS");
    expect(parseRssFeed("").ok).toBe(false);
  });

  test("item が1つも無い RSS は、0件として返す（止めない。0件と言うのは呼ぶ側）", () => {
    const result = parseRssFeed('<rss version="2.0"><channel><title>空</title></channel></rss>');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.items).toEqual([]);
  });

  test("title の無い item は数えて外す", () => {
    const result = parseRssFeed(
      '<rss version="2.0"><channel><item><link>https://example.com/x</link></item>' +
        "<item><title>有る</title></item></channel></rss>"
    );
    if (!result.ok) throw new Error(result.reason);
    expect(result.items.map((item) => item.title)).toEqual(["有る"]);
    expect(result.skipped).toBe(1);
  });

  test("知らない実体参照は、そのまま残す（文字を作らない）", () => {
    expect(decodeXmlEntities("A &unknown; B &amp; C")).toBe("A &unknown; B & C");
    // 範囲外の数値は捨てずに残す
    expect(decodeXmlEntities("&#x110000;")).toBe("&#x110000;");
  });

  test("htmlToText：script・style の中身は落とし、空行を詰める", () => {
    expect(
      htmlToText("<div>一<script>alert(1)</script></div><style>p{}</style><br><br><br>二&nbsp;三")
    ).toBe("一\n二 三");
  });
});
