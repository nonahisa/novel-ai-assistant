import { describe, expect, test } from "vitest";
import {
  CONTESTS_ENVELOPE_VERSION,
  parseContestCard,
  parseContestsClipboard,
  splitContestPageText,
} from "../../../src/core/contestListing";

/**
 * 公募の一覧の読み取り（設計書6.3.6.1）。
 *
 * 入り口は2つあり、**どちらも同じ読み取りを通る**：
 *
 *   A. ヘルパーが一覧のページを読んで、1件ずつの文をクリップボードへ置く（`novelai-contests` v1）
 *   D. 作者がページの文を全部選んでコピーし、そのまま貼り付ける
 *
 * 見本の文は**実物の構造を写した作り物**である（公募名・主催・賞典はすべて架空）。
 * 実物のページを丸ごとリポジトリへ置くと、他人の文章の転載になる。
 */

/** ノベルポータル（creative-story.net）の一覧を、画面から全部選んでコピーした形 */
const PORTAL_PAGE = [
  "小説の文学賞・新人賞・公募一覧（作り物）",
  "人気の公募ランキング",
  "1",
  "第3回 みずうみ文学賞",
  "💎 12",
  "目次",
  "2026年10月締切",
  "2026年10月締切",
  "第3回 みずうみ文学賞",
  " 締切：2026年10月31日（土）23:59",
  " 賞典：賞状＋賞金10万円",
  " 字数：400字詰原稿用紙で50枚以上100枚以下",
  " 主催：みずうみ文学振興会",
  " 選考：山田一郎／川村花子",
  " 募集作品：未発表の短編小説",
  " 応募資格：不問",
  " 応募料：無料",
  "◇",
  "気になる！",
  "12",
  "第1回 そらいろ小説コンテスト",
  " 締切：2026年11月15日(日)",
  " 賞典：賞金5万円",
  " 字数：制限なし",
  " 募集作品：空をテーマにした小説",
  "◇",
  "気になる！",
  "3",
  "地域限定公募",
  "第9回 かわべ市民文芸賞",
  "締切：2026年12月1日（火） 賞典：賞状＋記念品 字数：400字詰め原稿用紙で30枚以上50枚以内 主催：かわべ市 募集作品：小説 応募資格：市内在住の方",
  "◇",
  "気になる！",
  "0",
  "随時募集",
  "ラジオ風短編賞",
  " 締切",
  "上期：募集期間：毎年1月〜6月",
  "下期：募集期間：毎年7月〜12月",
  " 賞典：番組で朗読",
  " 字数：4,000字以下",
  " 主催：作り物オフィス",
  "◇",
  "気になる！",
  "0",
  "小説公募に応募する前に",
].join("\n");

/** ツクリテミライ（tsukuritemirai.com）の一覧を、画面から全部選んでコピーした形 */
const TSUKURI_PAGE = [
  "小説の公募一覧",
  "該当する公募：3件",
  "〆切が近い順",
  "漫画",
  "小説",
  "〆切：2026/10/31",
  "第2回 ほしぞらBL大賞",
  "",
  "作り物サイトにて小説と漫画を対象とした大賞が開催です。 応募資格 : 作り物サイトに登録しているWeb上の作品 賞金 : 大賞：書籍化 〆切 : WEB応募：2026年10月31日",
  "",
  "#WEB応募",
  "#BL",
  "小説",
  "〆切：2026/11/25",
  "告白エッセイコンテスト",
  "",
  "心に残る告白を綴る企画です。 募集内容 : 自身の告白を綴ったエッセイ 1,000文字以上、5,000文字以下の日本語作品 作品種別は「短編」 〆切 : WEB応募：2026年11月25日 23:59",
  "",
  "#WEB応募",
  "小説",
  "〆切：2026/8/5",
  "終了",
  "百文字ミステリーコンテスト",
  "",
  "100文字以内の謎解き短編を募集しています。 〆切 : 2026/8/5",
  "",
  "#短編",
  "前へ",
  "1",
  "2",
  "次へ",
].join("\n");

describe("D：ページの文をそのまま貼り付けたとき", () => {
  test("ノベルポータルの一覧を1件ずつに分ける（ランキング・目次は拾わない）", () => {
    const cards = splitContestPageText(PORTAL_PAGE);
    expect(cards.map((card) => card.name)).toEqual([
      "第3回 みずうみ文学賞",
      "第1回 そらいろ小説コンテスト",
      "第9回 かわべ市民文芸賞",
      "ラジオ風短編賞",
    ]);
  });

  test("ノベルポータルの1件から、締切・賞典・字数・主催・募集作品・応募資格を読む", () => {
    const [first, , third, fourth] = splitContestPageText(PORTAL_PAGE).map((card) =>
      parseContestCard({ ...card, source: "pasted" })
    );
    expect(first).toMatchObject({
      name: "第3回 みずうみ文学賞",
      deadlineText: "2026年10月31日（土）23:59",
      deadlines: ["2026-10-31"],
      prize: "賞状＋賞金10万円",
      charText: "400字詰原稿用紙で50枚以上100枚以下",
      organizer: "みずうみ文学振興会",
      judges: "山田一郎／川村花子",
      genre: "未発表の短編小説",
      eligibility: "不問",
      fee: "無料",
      charLimit: { kind: "range", min: 20000, max: 40000, converted: true },
    });
    // 1行に並んだ形（地域限定の欄）も、欄の名前で区切って読む
    expect(third).toMatchObject({
      deadlines: ["2026-12-01"],
      prize: "賞状＋記念品",
      organizer: "かわべ市",
      eligibility: "市内在住の方",
      charLimit: { kind: "range", min: 12000, max: 20000 },
    });
    // 締切が日付でなければ、原文だけを持つ（作者に入れてもらう）
    expect(fourth?.deadlines).toEqual([]);
    expect(fourth?.deadlineText).toContain("上期");
    // 「気になる！」の数は、どの欄にも混ざらない
    expect(fourth?.organizer).toBe("作り物オフィス");
  });

  test("ツクリテミライの一覧を1件ずつに分ける（〆切の行が名前の前に来る形）", () => {
    const listings = splitContestPageText(TSUKURI_PAGE).map((card) =>
      parseContestCard({ ...card, source: "pasted" })
    );
    expect(listings.map((listing) => listing?.name)).toEqual([
      "第2回 ほしぞらBL大賞",
      "告白エッセイコンテスト",
      "百文字ミステリーコンテスト",
    ]);
    expect(listings[0]).toMatchObject({
      deadlines: ["2026-10-31"],
      eligibility: "作り物サイトに登録しているWeb上の作品",
    });
    // 字数が書かれていなければ読めない（0や空で埋めない）
    expect(listings[0]?.charLimit.kind).toBe("unreadable");
    // 字数は説明文の中から拾う
    expect(listings[1]?.charLimit).toEqual({
      kind: "range",
      min: 1000,
      max: 5000,
      converted: false,
    });
    expect(listings[1]?.charText).toContain("1,000文字以上、5,000文字以下");
    // タグ・ページ送りは、どの欄にも混ざらない
    expect(listings[2]?.genre ?? "").not.toContain("次へ");
  });

  test("説明文の「文字数の規定なし」は、字数の制限なしと読む", () => {
    const listing = parseContestCard({
      name: "作り物メディア大賞",
      text: [
        "〆切：2027/1/8",
        "作り物メディア大賞",
        "",
        "作り物の説明です。 募集内容 : ジャンル不問 文字数の規定なし 完結・未完不問 〆切 : WEB応募：2027年1月8日 23:59",
      ].join("\n"),
      source: "pasted",
    });
    expect(listing?.charLimit).toEqual({ kind: "none" });
  });

  test("公募の一覧でない文からは何も拾わない", () => {
    expect(splitContestPageText("今日の買い物：卵、牛乳\n締切りは明日")).toEqual([]);
    expect(splitContestPageText("")).toEqual([]);
  });
});

describe("A：ヘルパーが渡した一覧（novelai-contests v1）", () => {
  function envelope(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
      "novelai-contests": CONTESTS_ENVELOPE_VERSION,
      source: "novelportal",
      pageUrl: "https://creative-story.net/bungakusyou/",
      readAt: "2026-09-23T10:00:00.000+09:00",
      items: [
        {
          name: "第3回 みずうみ文学賞",
          url: "https://example.com/mizuumi",
          section: "2026年10月締切",
          text: [
            "第3回 みずうみ文学賞",
            " 締切：2026年10月31日（土）23:59",
            " 字数：5,000〜10,000字",
            " 主催：みずうみ文学振興会",
            "◇",
            "気になる！",
            "12",
          ].join("\n"),
        },
        {
          name: "開催予定",
          url: null,
          section: "小説家になろう",
          text: "開催予定\n公式企画　冬の作り物祭\t 2026年12月10日～2027年1月21日",
        },
      ],
      ...overrides,
    });
  }

  test("1件ずつ同じ読み取りを通す（開催予定の表は公募に数えない）", () => {
    const result = parseContestsClipboard(envelope());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.from).toBe("helper");
    expect(result.listings).toHaveLength(1);
    expect(result.listings[0]).toMatchObject({
      name: "第3回 みずうみ文学賞",
      url: "https://example.com/mizuumi",
      section: "2026年10月締切",
      source: "novelportal",
      deadlines: ["2026-10-31"],
      organizer: "みずうみ文学振興会",
      charLimit: { kind: "range", min: 5000, max: 10000 },
    });
  });

  test("版が違えば読まない（理由を言う）", () => {
    const result = parseContestsClipboard(envelope({ "novelai-contests": 2 }));
    expect(result).toMatchObject({ ok: false, kind: "invalid" });
    if (!result.ok && result.kind === "invalid") expect(result.reason).toContain("版");
  });

  test("知らない出どころは読まない", () => {
    const result = parseContestsClipboard(envelope({ source: "somewhere" }));
    expect(result).toMatchObject({ ok: false, kind: "invalid" });
  });

  test("https でないリンクは持たない（開かせない）", () => {
    const text = envelope({
      items: [
        {
          name: "作り物賞",
          url: "javascript:alert(1)",
          section: null,
          text: "作り物賞\n 締切：2026年10月31日",
        },
      ],
    });
    const result = parseContestsClipboard(text);
    expect(result.ok && result.listings[0].url).toBeNull();
  });

  test("ほかのデータ（読者の反応の封筒・ただの文）は公募と読まない", () => {
    expect(parseContestsClipboard(JSON.stringify({ "novelai-stats": 1 }))).toEqual({
      ok: false,
      kind: "notFound",
    });
    expect(parseContestsClipboard("今日の買い物：卵、牛乳")).toEqual({
      ok: false,
      kind: "notFound",
    });
  });

  test("貼り付けた文（D）も同じ関数で受ける", () => {
    const result = parseContestsClipboard(PORTAL_PAGE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.from).toBe("text");
    expect(result.listings).toHaveLength(4);
    expect(result.listings[0].source).toBe("pasted");
  });
});
