import { describe, expect, test } from "vitest";
import { buildPostingSiteRecords, readerSiteTabs } from "../../../src/core/postingSiteRecords";
import {
  emptyPostingLedger,
  withReaderStats,
  withSiteProfile,
  withSites,
  type PostingLedger,
} from "../../../src/models/posting";

/**
 * 「読者の反応」の中のサイトのタブ（作者の指示 2026-11-01「サイトごとにタブをわけてください。
 * 配信されているサイトのみタブを表示し、なろうを最後尾にしてください」）。
 */

const urls = {
  narou: "https://syosetu.com/usernovelmanage/isnoveluploadmenu/ncode/n1234ab/",
  kakuyomu: "https://kakuyomu.jp/my/works/1177354054892/episodes/new",
  alphapolis: "https://www.alphapolis.co.jp/mypage/novel/save_episode/123456789",
};

function tabsOf(ledger: PostingLedger): string[] {
  return readerSiteTabs(ledger, buildPostingSiteRecords(ledger)).map((tab) => tab.site);
}

describe("サイトのタブ", () => {
  test("なろうを最後尾にし、ほかは今の表示の順のまま", () => {
    const ledger = withSites(emptyPostingLedger(), [
      { site: "narou", newEpisodeUrl: urls.narou },
      { site: "alphapolis", newEpisodeUrl: urls.alphapolis },
      { site: "kakuyomu", newEpisodeUrl: urls.kakuyomu },
    ]);
    expect(tabsOf(ledger)).toEqual(["kakuyomu", "alphapolis", "narou"]);
  });

  test("配信していないサイトのタブは出さない", () => {
    const ledger = withSites(emptyPostingLedger(), [{ site: "kakuyomu", newEpisodeUrl: urls.kakuyomu }]);
    expect(tabsOf(ledger)).toEqual(["kakuyomu"]);
  });

  test("サイトが1つだけでもタブを1つ出す（どのサイトの数か分かるように）", () => {
    const ledger = withSites(emptyPostingLedger(), [{ site: "narou", newEpisodeUrl: urls.narou }]);
    const tabs = readerSiteTabs(ledger, buildPostingSiteRecords(ledger));
    expect(tabs).toEqual([{ site: "narou", label: "小説家になろう" }]);
  });

  test("投稿先から外したサイトでも、記録（作品IDや読者の反応）が残っていればタブを出す", () => {
    let ledger = withSiteProfile(emptyPostingLedger(), "alphapolis", { workId: "123456789" });
    ledger = withReaderStats(ledger, {
      site: "narou",
      readAt: "2026-11-01T00:00:00.000Z",
      scope: "work",
      metrics: { bookmarks: 3 },
      source: "helper",
    });
    expect(tabsOf(ledger)).toEqual(["alphapolis", "narou"]);
  });

  test("何も無い作品ではタブが無い（画面は案内だけを出す）", () => {
    expect(tabsOf(emptyPostingLedger())).toEqual([]);
  });
});
