import { describe, expect, test } from "vitest";
import {
  buildReaderStatsEnvelope,
  matchReaderStatsEnvelope,
  parseReaderStatsEnvelope,
  type ReaderStatsEnvelope,
} from "../../../src/core/readerStatsEnvelope";
import {
  pickReaderStatsWork,
  planReaderStatsSiteId,
  routeReaderStatsBundleItem,
} from "../../../src/core/readerStatsHelperLink";
import {
  emptyPostingLedger,
  withSiteProfile,
  withSites,
  type PostingLedger,
} from "../../../src/models/posting";

/**
 * なろうファンDB（Narou.fun）の封筒の作品ID（Nコード）は、大文字・小文字を問わず照合する
 * （2026-11-01 のサイトの変更）。
 *
 * リニューアルで作品のページが `db.narou.fun/novels/{小文字のNコード}` になり、ヘルパー 0.14.2 の
 * 封筒の workId も**小文字**で届くようになった（0.14.1 までは大文字の URL から読んだ大文字）。
 * 作者の台帳には、大文字で入れた作品ID・小文字の作品ページの URL・投稿ページの URL のどれかが
 * 入っている。どの組み合わせでも同じ作品として通ること、別の作品は止まることを確かめる。
 * Nコードはすべて架空。
 */

function narouFunEnvelope(workId: string): ReaderStatsEnvelope {
  const parsed = parseReaderStatsEnvelope(
    buildReaderStatsEnvelope({
      site: "narou",
      source: "narou.fun",
      workId,
      // データ取得 2026/11/01 の 0:00（日本時間）
      readAt: "2026-10-31T15:00:00.000Z",
      readAtBasis: "fetched",
      entries: [{ scope: "work", metrics: { points: 1200 } }],
    })
  );
  if (!parsed.ok) throw new Error(parsed.reason);
  return parsed.envelope;
}

function ledgerWithWorkId(workId: string): PostingLedger {
  return withSiteProfile(emptyPostingLedger(), "narou", { workId });
}

describe("なろうファンDB の封筒：Nコードの大文字・小文字を問わない", () => {
  const cases: { name: string; ledger: PostingLedger; envelope: string }[] = [
    { name: "台帳が大文字・封筒が小文字（いまのヘルパー）", ledger: ledgerWithWorkId("N2600GO"), envelope: "n2600go" },
    { name: "台帳が小文字・封筒が大文字（0.14.1 までのヘルパー）", ledger: ledgerWithWorkId("n2600go"), envelope: "N2600GO" },
    { name: "台帳も封筒も小文字", ledger: ledgerWithWorkId("n2600go"), envelope: "n2600go" },
    {
      name: "台帳は作品ページの URL だけ・封筒が小文字",
      ledger: withSiteProfile(emptyPostingLedger(), "narou", {
        workUrl: "https://ncode.syosetu.com/n2600go/",
      }),
      envelope: "n2600go",
    },
    {
      name: "台帳は投稿ページの URL だけ（大文字）・封筒が小文字",
      ledger: withSites(emptyPostingLedger(), [
        { site: "narou", newEpisodeUrl: "https://syosetu.com/usernovelmanage/top/ncode/N2600GO/" },
      ]),
      envelope: "n2600go",
    },
  ];

  for (const one of cases) {
    test(`${one.name}：関所を通り、1件の封筒も束の1件も同じ作品に決まる`, () => {
      const envelope = narouFunEnvelope(one.envelope);
      expect(matchReaderStatsEnvelope(envelope, one.ledger)).toBeNull();
      const candidates = [
        { id: "this", ledger: one.ledger },
        // 別の作品（別の Nコード）は候補に混ざっても選ばれない
        { id: "other", ledger: ledgerWithWorkId("N9999ZZ") },
      ];
      expect(pickReaderStatsWork(envelope, candidates)).toEqual({ kind: "one", id: "this" });
      expect(routeReaderStatsBundleItem(envelope, candidates)).toEqual({ kind: "work", id: "this" });
    });
  }

  test("別の Nコードは、大文字・小文字に関わらず取り違えとして止まる", () => {
    for (const received of ["n9999zz", "N9999ZZ"]) {
      const reason = matchReaderStatsEnvelope(narouFunEnvelope(received), ledgerWithWorkId("N2600GO"));
      expect(reason, received).toContain("違います");
    }
  });

  test("作品IDの登録：大文字と小文字だけの違いは、同じIDとして扱う（上書きを訊かない）", () => {
    expect(planReaderStatsSiteId(ledgerWithWorkId("N2600GO"), "narou", "n2600go")).toEqual({
      kind: "same",
    });
  });
});
