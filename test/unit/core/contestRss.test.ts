import { describe, expect, test } from "vitest";
import { CONTEST_RSS_URL, contestsFromRss } from "../../../src/core/contestRss";
import { parseRssFeed } from "../../../src/core/rssFeed";
import { readDeadlines } from "../../../src/core/contestDeadline";

/**
 * ツクリテミライの RSS から公募を読む（設計書6.3.6.2）。
 *
 * **1件の読み取りは既存の `parseContestCard` を通す**（締切・字数の読み替えを
 * 2か所に持たない）。見本の公募名・説明はすべて作り物で、書き方だけを
 * 2026-09-23 に読んだ本物のフィードに合わせてある。
 */

const FEED = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom"><channel>',
  "<title>作り物の公募一覧</title>",
  "<item>",
  "<title>第3回 あおぞらBL大賞</title>",
  "<link>https://tsukuritemirai.com/kobo/aaa</link>",
  '<guid isPermaLink="true">https://tsukuritemirai.com/kobo/aaa</guid>',
  "<description>作り物の投稿サイトで小説と漫画を募集する賞です。様々なテーマのBL作品を幅広く募集します。 " +
    "応募資格 : 作り物サイトに登録しているWeb上の小説 賞金 : 大賞：書籍化 読者賞：賞金10万円 " +
    "〆切 : WEB応募：2026年10月31日</description>",
  "<pubDate>Fri, 18 Sep 2026 06:23:25 GMT</pubDate>",
  "<category>漫画</category><category>小説</category>",
  "</item>",
  "<item>",
  "<title>第2回 ほしぞらメディア大賞</title>",
  "<link>https://tsukuritemirai.com/kobo/bbb</link>",
  "<description>次のレーベルの顔となる作品を募る小説賞です。 応募資格 : プロ・アマ不問 " +
    "募集内容 : ジャンル不問 文字数の規定なし 完結・未完不問 " +
    "賞金 : 大賞：賞金300万円 〆切 : WEB応募：2027年1月8日 2</description>",
  "</item>",
  "<item>",
  "<title>締切の書かれていない募集</title>",
  "<link>https://tsukuritemirai.com/kobo/ccc</link>",
  "<description>随時募集しています。</description>",
  "</item>",
  "<item>",
  "<title>第5回 うみかぜ文学賞</title>",
  "<link>https://tsukuritemirai.com/kobo/ddd</link>",
  "<description>海の出てくる物語を募集。 募集内容 : 400字詰原稿用紙換算で50枚以上100枚以内 〆切 : 郵送：2026年11月30日</description>",
  "</item>",
  "</channel></rss>",
].join("\n");

function listings() {
  const parsed = parseRssFeed(FEED);
  if (!parsed.ok) throw new Error(parsed.reason);
  return contestsFromRss(parsed);
}

describe("RSS の item を公募として読む", () => {
  test("フィードの場所は1か所の定数", () => {
    expect(CONTEST_RSS_URL).toBe("https://tsukuritemirai.com/kobo/novel/feed.xml");
  });

  test("締切・字数・募集内容・応募資格・賞金を既存の読み取りで読む", () => {
    const result = listings();
    expect(result.listings.map((entry) => entry.name)).toEqual([
      "第3回 あおぞらBL大賞",
      "第2回 ほしぞらメディア大賞",
      "第5回 うみかぜ文学賞",
    ]);
    const [aozora, hoshizora, umikaze] = result.listings;
    expect(aozora.deadlines).toEqual(["2026-10-31"]);
    expect(aozora.eligibility).toContain("作り物サイト");
    expect(aozora.prize).toContain("書籍化");
    expect(aozora.source).toBe("tsukuritemirai");
    // 詳しいページへのリンク（一覧に公式のリンクが無いので、サイトの公募のページ）
    expect(aozora.url).toBe("https://tsukuritemirai.com/kobo/aaa");

    expect(hoshizora.deadlines).toEqual(["2027-01-08"]);
    expect(hoshizora.genre).toContain("ジャンル不問");
    expect(hoshizora.charLimit.kind).toBe("none");

    expect(umikaze.charLimit).toEqual({ kind: "range", min: 20000, max: 40000, converted: true });
  });

  test("締切の無い item は公募と読まない（数だけ返す）", () => {
    expect(listings().skipped).toBe(1);
  });

  test("説明の書き出し（欄の前の文）を要約として持つ（AIの提案と近さの材料）", () => {
    const [aozora] = listings().listings;
    expect(aozora.summary).toContain("様々なテーマのBL作品");
    // 名前は要約に重ねない
    expect(aozora.summary).not.toContain("第3回 あおぞらBL大賞");
  });

  test("分類は見出し（section）に入れる", () => {
    const [aozora] = listings().listings;
    expect(aozora.section).toBe("漫画・小説");
  });
});

/**
 * 締切の専用欄 `<kobo:deadline date=… time=… timezone=…/>` を先に読む
 * （2026-09-26 精査 R10。引継ぎ書 8章【メモ】2026-09-23 深夜）。
 *
 * 作者がサイトに頼んで足してもらった欄。説明の先頭の「〆切：」でも読めて
 * いたが、専用欄のほうが確実で時刻も取れる。**欄が無い・壊れているときは、
 * 今までどおり説明の「〆切：」で読む。**
 */
const KOBO_FEED = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<rss version="2.0" xmlns:kobo="https://tsukuritemirai.com/kobo/ns"><channel>',
  "<title>作り物の公募一覧</title>",
  "<item>",
  "<title>第1回 こもれび小説賞</title>",
  "<link>https://tsukuritemirai.com/kobo/k1</link>",
  // 説明の「〆切」は日付として読めない書き方でも、専用欄から読む
  "<description>木漏れ日の物語を募集。 〆切 : 年明けすぐ</description>",
  '<kobo:deadline date="2027-01-08" time="23:59" timezone="Asia/Tokyo"/>',
  "</item>",
  "<item>",
  "<title>第2回 ゆうなぎ文芸賞</title>",
  "<link>https://tsukuritemirai.com/kobo/k2</link>",
  // 説明に「〆切」が無くても、専用欄があれば公募として読む
  "<description>夕凪の短編を募集。</description>",
  '<kobo:deadline date="2026-12-15"/>',
  "</item>",
  "<item>",
  "<title>第3回 あさつゆ大賞</title>",
  "<link>https://tsukuritemirai.com/kobo/k3</link>",
  // 専用欄が壊れていれば、説明の「〆切」へ戻る
  "<description>朝露の物語を募集。 〆切 : WEB応募：2026年11月30日</description>",
  '<kobo:deadline date="2026-13-45" time="25:99"/>',
  "</item>",
  "</channel></rss>",
].join("\n");

function koboListings() {
  const parsed = parseRssFeed(KOBO_FEED);
  if (!parsed.ok) throw new Error(parsed.reason);
  return contestsFromRss(parsed);
}

describe("締切の専用欄 kobo:deadline", () => {
  test("専用欄の日付と時刻を読む（説明の「〆切」が日付として読めなくても）", () => {
    const [komorebi] = koboListings().listings;
    expect(komorebi.name).toBe("第1回 こもれび小説賞");
    expect(komorebi.deadlines).toEqual(["2027-01-08"]);
    expect(komorebi.deadlineText).toBe("2027-01-08 23:59");
  });

  test("説明に「〆切」が無くても、専用欄があれば公募として読む", () => {
    const result = koboListings();
    const yunagi = result.listings.find((entry) => entry.name.includes("ゆうなぎ"));
    expect(yunagi?.deadlines).toEqual(["2026-12-15"]);
    expect(yunagi?.deadlineText).toBe("2026-12-15");
    expect(result.skipped).toBe(0);
  });

  test("専用欄が壊れていれば、説明の「〆切」で読む", () => {
    const asatsuyu = koboListings().listings.find((entry) => entry.name.includes("あさつゆ"));
    expect(asatsuyu?.deadlines).toEqual(["2026-11-30"]);
    expect(asatsuyu?.deadlineText).toContain("2026年11月30日");
  });

  test("置き場へ保存して読み戻しても、締切の日付が変わらない", () => {
    // 置き場（`contestInbox.ts`）は締切の日付を deadlineText から読み直す。
    // 専用欄の日付を deadlines にだけ入れると、読み戻したときに消える
    for (const listing of koboListings().listings) {
      expect(readDeadlines(listing.deadlineText), listing.name).toEqual(listing.deadlines);
    }
  });

  test("専用欄の無いフィードは、今までと同じに読む", () => {
    const [aozora] = listings().listings;
    expect(aozora.deadlineText).toBe("WEB応募：2026年10月31日");
  });
});
