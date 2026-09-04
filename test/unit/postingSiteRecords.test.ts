import { describe, expect, test } from "vitest";
import {
  buildPostingSiteRecords,
  isOpenableWorkUrl,
} from "../../src/core/postingSiteRecords";
import {
  emptyPostingLedger,
  withRanking,
  withSiteProfile,
  withSites,
  type PostingLedger,
} from "../../src/models/posting";
import { buildWritingStatsPanelHtml } from "../../src/views/writingStatsPanelHtml";

/**
 * 執筆量パネルの「サイトの記録」（設計書6.68.5）。
 *
 * **サイトへは触りにいかない。** ここに出るのは、作者が「投稿サイトの設定」
 * で入れた作品情報と、「ランキングを記録する」で入れた順位だけである。
 *
 * **何も入っていない作品では、節ごと出さない。** 空の表が1つ増えるだけで、
 * 執筆量を見にきた人の邪魔になる。
 */

const url = {
  narou: "https://syosetu.com/usernovelmanage/isnoveluploadmenu/ncode/n1234ab/",
  kakuyomu: "https://kakuyomu.jp/my/works/1177354054892/episodes/new",
};

function registered(): PostingLedger {
  return withSites(emptyPostingLedger(), [
    { site: "narou", newEpisodeUrl: url.narou },
    { site: "kakuyomu", newEpisodeUrl: url.kakuyomu },
  ]);
}

describe("サイトの記録を組み立てる", () => {
  test("何も入れていなければ、1件も返さない（節ごと出さない）", () => {
    expect(buildPostingSiteRecords(emptyPostingLedger())).toEqual([]);
    // サイトを登録しただけ（投稿ページのURLだけ）でも、まだ見せるものが無い
    expect(buildPostingSiteRecords(registered())).toEqual([]);
  });

  test("作品情報を入れたサイトだけが並ぶ", () => {
    const ledger = withSiteProfile(registered(), "narou", {
      workId: "n1234ab",
      workUrl: "https://ncode.syosetu.com/n1234ab/",
      genre: "ハイファンタジー",
    });

    const records = buildPostingSiteRecords(ledger);
    expect(records).toHaveLength(1);
    expect(records[0].label).toBe("小説家になろう");
    expect(records[0].workId).toBe("n1234ab");
    expect(records[0].genre).toBe("ハイファンタジー");
    expect(records[0].workUrl).toBe("https://ncode.syosetu.com/n1234ab/");
    expect(records[0].history).toEqual([]);
    expect(records[0].latest).toBeNull();
  });

  test("履歴は新しい順に並び、いちばん新しいものが最新順位になる", () => {
    let ledger = registered();
    ledger = withRanking(ledger, {
      site: "narou",
      recordedAt: "2026-09-01T00:00:00.000Z",
      board: "日間",
      rank: 12,
    });
    ledger = withRanking(ledger, {
      site: "narou",
      recordedAt: "2026-09-05T00:00:00.000Z",
      board: "週間",
      rank: 3,
      note: "更新直後",
    });
    ledger = withRanking(ledger, {
      site: "narou",
      recordedAt: "2026-09-03T00:00:00.000Z",
      board: "日間",
      rank: 8,
    });

    const narou = buildPostingSiteRecords(ledger)[0];
    expect(narou.history.map((row) => row.rank)).toEqual([3, 8, 12]);
    expect(narou.latest).toEqual({
      recordedAt: "2026-09-05T00:00:00.000Z",
      board: "週間",
      rank: 3,
      note: "更新直後",
    });
    // メモの無い記録は null で埋める（画面の欄が消えないように）
    expect(narou.history[1].note).toBeNull();
  });

  /**
   * **サイトを外しても記録は消さない**（6.68.4の8）。台帳に残っている
   * 順位は、登録を外したあとも見られなければ「消えた」のと同じである。
   */
  test("登録を外したサイトの記録も、見えるところに残す", () => {
    const ledger = withRanking(emptyPostingLedger(), {
      site: "note",
      recordedAt: "2026-09-04T00:00:00.000Z",
      board: "急上昇",
      rank: 20,
    });

    const records = buildPostingSiteRecords(ledger);
    expect(records).toHaveLength(1);
    expect(records[0].site).toBe("note");
    expect(records[0].registered).toBe(false);
  });

  /**
   * **作品情報はサイトの登録から独立している**（設計書6.68.5）。順位と
   * 同じで、投稿先から外しても書いたものは残り、パネルにも出る。
   */
  test("登録を外したサイトでも、作品情報の行は出る", () => {
    const ledger = withSiteProfile(emptyPostingLedger(), "alphapolis", {
      workId: "123456",
      note: "完結済み",
    });

    const records = buildPostingSiteRecords(ledger);
    expect(records).toHaveLength(1);
    expect(records[0].site).toBe("alphapolis");
    expect(records[0].registered).toBe(false);
    expect(records[0].workId).toBe("123456");
    expect(records[0].note).toBe("完結済み");
  });

  test("並びは投稿サイトの一覧と同じ順（画面ごとに順番が変わらない）", () => {
    let ledger = registered();
    ledger = withRanking(ledger, {
      site: "kakuyomu",
      recordedAt: "2026-09-04T00:00:00.000Z",
      board: "週間",
      rank: 40,
    });
    ledger = withRanking(ledger, {
      site: "narou",
      recordedAt: "2026-09-05T00:00:00.000Z",
      board: "日間",
      rank: 12,
    });

    expect(buildPostingSiteRecords(ledger).map((entry) => entry.site)).toEqual([
      "narou",
      "kakuyomu",
    ]);
  });
});

/**
 * 作品ページを開く道（設計書6.68.5）。
 *
 * **開くのは `openExternal` だけ。** ページを読みにいく処理は無い。
 * 開く前に、http/https であることを確かめる（台帳は作者が手で開いて
 * 直せるファイルなので、`javascript:` が書かれていることがありうる）。
 */
describe("作品ページのリンク", () => {
  test("http・httpsだけを開く", () => {
    expect(isOpenableWorkUrl("https://ncode.syosetu.com/n1234ab/")).toBe(true);
    expect(isOpenableWorkUrl("http://example.com/")).toBe(true);
    expect(isOpenableWorkUrl("javascript:alert(1)")).toBe(false);
    expect(isOpenableWorkUrl("file:///C:/secret.txt")).toBe(false);
    expect(isOpenableWorkUrl("")).toBe(false);
  });
});

describe("執筆量パネルの側", () => {
  test("節の置き場と、開く道の配線がある", () => {
    const html = buildWritingStatsPanelHtml("nonce", "vscode-resource:");

    // 節の置き場（データが無ければ空のままにする）
    expect(html).toContain('id="site-records"');
    // リンクは画面から直接開かず、拡張機能側へ頼む（openExternal）
    expect(html).toContain("openExternal");
  });
});
