import { describe, expect, test } from "vitest";
import {
  planReaderStatsPostingSite,
  planReaderStatsSiteId,
} from "../../../src/core/readerStatsHelperLink";
import {
  newEpisodeUrlFromWorkId,
  postingPageUrl,
} from "../../../src/core/postingSiteUrls";
import {
  emptyPostingLedger,
  withSiteProfile,
  withSites,
} from "../../../src/models/posting";

/**
 * 読者の反応から作品IDを登録したとき、投稿先（`sites[]`）にも入れるか
 * （作者の依頼 2026-10-12「投稿先へは自動登録してください」）。
 *
 * 足すのは「作品IDを新しく入れた・置き換えた」ときだけ。前から同じIDなら、
 * 作者が投稿先から外したサイトを戻さない。
 */

const ID = "1177354054934574437";
const NEW_EPISODE = `https://kakuyomu.jp/my/works/${ID}/episodes/new`;

describe("作品IDから投稿ページのURLを組み立てる", () => {
  test("カクヨムは数字の作品IDから組み立てる。開く口と同じ形", () => {
    expect(newEpisodeUrlFromWorkId("kakuyomu", ID)).toBe(NEW_EPISODE);
    expect(newEpisodeUrlFromWorkId("kakuyomu", ` ${ID} `)).toBe(NEW_EPISODE);
    expect(postingPageUrl("kakuyomu", undefined, { workId: ID })).toBe(NEW_EPISODE);
  });

  test("数字でない作品ID・組み立てられないサイトは undefined", () => {
    expect(newEpisodeUrlFromWorkId("kakuyomu", "作品名")).toBeUndefined();
    expect(newEpisodeUrlFromWorkId("kakuyomu", "")).toBeUndefined();
    expect(newEpisodeUrlFromWorkId("narou", "n1234ab")).toBeUndefined();
    expect(newEpisodeUrlFromWorkId("alphapolis", "123")).toBeUndefined();
    expect(newEpisodeUrlFromWorkId("note", "abc")).toBeUndefined();
  });
});

describe("登録のとき投稿先をどうするか", () => {
  test("新しく作品IDを入れる（add）とき、投稿先に無ければ足す", () => {
    const ledger = emptyPostingLedger();
    const idPlan = planReaderStatsSiteId(ledger, "kakuyomu", ID);
    expect(planReaderStatsPostingSite(ledger, "kakuyomu", ID, idPlan)).toEqual({
      kind: "add",
      entry: { site: "kakuyomu", newEpisodeUrl: NEW_EPISODE },
    });
  });

  test("置き換える（replace）ときも、投稿先に無ければ足す", () => {
    const ledger = withSiteProfile(emptyPostingLedger(), "kakuyomu", { workId: "1111" });
    const idPlan = planReaderStatsSiteId(ledger, "kakuyomu", ID);
    expect(idPlan.kind).toBe("replace");
    expect(planReaderStatsPostingSite(ledger, "kakuyomu", ID, idPlan).kind).toBe("add");
  });

  test("前から同じ作品ID（same）なら足さない——作者が投稿先から外したサイトを戻さない", () => {
    const ledger = withSiteProfile(emptyPostingLedger(), "kakuyomu", { workId: ID });
    const idPlan = planReaderStatsSiteId(ledger, "kakuyomu", ID);
    expect(idPlan.kind).toBe("same");
    expect(planReaderStatsPostingSite(ledger, "kakuyomu", ID, idPlan)).toEqual({
      kind: "none",
    });
  });

  test("既に投稿先にあれば触らない（作者が貼った投稿ページのURLのほうが確か）", () => {
    const ledger = withSites(emptyPostingLedger(), [
      { site: "kakuyomu", newEpisodeUrl: "https://kakuyomu.jp/my/works/2222/episodes/new" },
    ]);
    const idPlan = planReaderStatsSiteId(ledger, "kakuyomu", ID);
    expect(planReaderStatsPostingSite(ledger, "kakuyomu", ID, idPlan)).toEqual({
      kind: "none",
    });
  });

  test("組み立てられないサイト（なろう）は足さず、案内を添える印を返す", () => {
    const ledger = emptyPostingLedger();
    const idPlan = planReaderStatsSiteId(ledger, "narou", "n1234ab");
    expect(planReaderStatsPostingSite(ledger, "narou", "n1234ab", idPlan)).toEqual({
      kind: "unbuildable",
    });
  });

  test("カクヨムでも作品IDが数字でなければ組み立てられない", () => {
    const ledger = emptyPostingLedger();
    const idPlan = planReaderStatsSiteId(ledger, "kakuyomu", "abc");
    expect(planReaderStatsPostingSite(ledger, "kakuyomu", "abc", idPlan).kind).toBe(
      "unbuildable"
    );
  });

  test("別のサイトが投稿先にあっても、そのサイトが無ければ足す", () => {
    const ledger = withSites(emptyPostingLedger(), [
      { site: "narou", newEpisodeUrl: "https://syosetu.com/usernovelmanage/top/ncode/n1234ab/" },
    ]);
    const idPlan = planReaderStatsSiteId(ledger, "kakuyomu", ID);
    expect(planReaderStatsPostingSite(ledger, "kakuyomu", ID, idPlan).kind).toBe("add");
  });
});
