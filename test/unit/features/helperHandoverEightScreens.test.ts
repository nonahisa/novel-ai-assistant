import { describe, expect, test } from "vitest";
import { computeReaderRates, latestEpisodeValues } from "../../../src/core/readerRates";
import { buildReaderCharts } from "../../../src/core/readerStatsCharts";
import { siteFactsFor, type ReaderStatsRecord } from "../../../src/models/posting";
import {
  eightScreenItems,
  entryCount,
  helperBundle,
  jstIso,
  kakuyomuAccessEnvelope,
  kakuyomuAccessPv,
  kakuyomuManagementEnvelope,
  kakuyomuManagementPv,
  KAKUYOMU_ACCESS_PAGES,
  KAKUYOMU_ACCESS_PAGE_SIZE,
  KAKUYOMU_EPISODES,
  KAKUYOMU_MANAGEMENT_READ_AT,
  KAKUYOMU_WORK_ID,
} from "../support/helperSamples";
import { onKakuyomu, setupHandoverHarness, workEntry } from "../support/helperHandoverHarness";

/**
 * ヘルパーが「まとめて渡す」で渡した、同じ作品の8画面の束（カクヨムの作品管理 1画面＋アクセス数 5ページ＋読み直した1・2ページ目）を
 * 受け口から取り込んだとき、受け手の記録に**全部**入るか。あわせて、アクセス数の2ページ目以降を足しても
 * 積み上がりが二重にならないか（ヘルパーの実機確認リスト「0.9.0：まとめて渡す」「アクセス数の画面を押して…」の、
 * 受け手の側）。
 *
 * 台帳は追記で、話ごとの行は**読み取りの日時が違えば別の行として積む**設計（「その時に見た数」）。
 * だから「二重にならない」は行の数で決めつけず、受け手が**数を読むところ**（話ごとの最新の数・話ごとの
 * グラフ・率）で、1つの話が1回だけ数えられることで見る。
 */

const harness = setupHandoverHarness();
const work = workEntry("w_kakuyomu", "架空の自分の題");

function register(): void {
  harness.addWork(work, onKakuyomu(KAKUYOMU_WORK_ID));
}

/** 行の「どの数か」の鍵（作品全体・話・日・月） */
function keyOf(row: ReaderStatsRecord): string {
  return JSON.stringify([row.scope, row.episode ?? null, row.period ?? null, row.periodKey ?? null]);
}

/** 欄の並びに左右されない比べ方（台帳は欄を表の順に書き直す） */
function sortedJson(value: unknown): string {
  const entries = Object.entries((value ?? {}) as Record<string, unknown>).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0
  );
  return JSON.stringify(entries);
}

describe("8画面の束が、受け手の記録に全部入る", () => {
  test("束の中の行（作品全体・日ごと30・月ごと・話ごと219 と、アクセス数の話ごと219＋読み直した100）が1行も欠けずに入る", async () => {
    register();
    const items = eightScreenItems();
    expect(items).toHaveLength(8);

    await harness.handOver(helperBundle(items, { ownedVia: "owner-page" }));

    expect(harness.warned).toEqual([]);
    const rows = harness.rowsOf(work);
    // 束の行の数 = 台帳の行の数（重なる行が無い束なので、積まなかった行は0）
    expect(rows).toHaveLength(entryCount(items));
    expect(harness.informed).toHaveLength(1);
    expect(harness.informed[0]).toContain("「架空の自分の題」8画面");
    expect(harness.informed[0]).not.toContain("同じ数で積まなかった");

    // 束の中の行の1つずつが、同じ読み取り日時・同じ数で台帳にある
    for (const item of items) {
      const readAt = item.readAt as string;
      for (const entry of item.entries as Array<Record<string, unknown>>) {
        const found = rows.find(
          (row) =>
            Date.parse(row.readAt) === Date.parse(readAt) &&
            keyOf(row) ===
              JSON.stringify([entry.scope, entry.episode ?? null, entry.period ?? null, entry.periodKey ?? null]) &&
            sortedJson(row.metrics) === sortedJson(entry.metrics) &&
            (row.updatedAt === undefined ? null : Date.parse(row.updatedAt)) ===
              (typeof entry.updatedAt === "string" ? Date.parse(entry.updatedAt) : null)
        );
        expect(found, `束の行が台帳にありません：${readAt} ${JSON.stringify(entry).slice(0, 100)}`).toBeDefined();
      }
    }

    // 作品管理の事柄（タグ・連載の状態・覚えた理由）も写っている
    const facts = siteFactsFor(harness.ledgerOf(work), "kakuyomu");
    expect(facts?.tags).toEqual(["異世界", "学園"]);
    expect(facts?.completion).toBe("ongoing");
    expect(facts?.ownedVia).toBe("owner-page");
    expect(harness.refreshed).toEqual(["w_kakuyomu"]);
  });

  test("受け手が数を読むところで、219話が1話ずつ・アクセス数のあとの数で出る（話ごとのグラフも219本）", async () => {
    register();
    await harness.handOver(helperBundle(eightScreenItems(), { ownedVia: "owner-page" }));

    const rows = harness.rowsOf(work);
    const latest = latestEpisodeValues(rows);
    expect(latest.pv.size).toBe(KAKUYOMU_EPISODES);
    for (let episode = 1; episode <= KAKUYOMU_EPISODES; episode++) {
      // 作品管理よりあとに読んだアクセス数の数（5増えている）が、その話の最新
      expect(latest.pv.get(episode)?.value, `第${episode}話`).toBe(kakuyomuAccessPv(episode));
    }
    const charts = buildReaderCharts(rows, null);
    expect(charts.episodes?.points).toHaveLength(KAKUYOMU_EPISODES);
    expect(new Set(charts.episodes?.points.map((point) => point.key)).size).toBe(KAKUYOMU_EPISODES);
    // 日ごとのPVは30日が1日1つ
    expect(charts.day?.points).toHaveLength(30);
    expect(charts.month?.points.map((point) => point.value)).toEqual([12500]);
  });

  test("率は、作品管理の更新日とアクセス数の数をあわせて出る（基準の話は更新から72時間たった最後の話）", async () => {
    register();
    await harness.handOver(helperBundle(eightScreenItems(), { ownedVia: "owner-page" }));

    const rates = computeReaderRates(harness.rowsOf(work));
    // 最後の2話は読んだ4時間前の更新なので基準にしない。基準は第318話
    expect(rates.base?.episode).toBe(KAKUYOMU_EPISODES - 2);
    expect(rates.dropout.missing).toBeUndefined();
    const first = kakuyomuAccessPv(1);
    const base = kakuyomuAccessPv(KAKUYOMU_EPISODES - 2);
    expect(rates.dropout.expression).toBe(
      `1 − ${base.toLocaleString("ja-JP")} ÷ ${first.toLocaleString("ja-JP")} = ${((1 - base / first) * 100).toFixed(1)}%`
    );
    // ブックマーク率 = 作品全体のブックマーク ÷ 第1話のPV
    expect(rates.bookmark.operands.map((operand) => operand.value)).toEqual([820, first]);
    expect(rates.rating.operands.map((operand) => operand.value)).toEqual([60, first]);
  });

  test("同じ束をもう一度渡しても、1行も増えない", async () => {
    register();
    const bundle = helperBundle(eightScreenItems(), { ownedVia: "owner-page" });
    await harness.handOver(bundle);
    const first = harness.rowsOf(work).length;

    await harness.handOver(bundle);

    expect(harness.rowsOf(work)).toHaveLength(first);
    expect(harness.informed.at(-1)).toContain("すでに取り込んだ数と同じでした");
  });
});

describe("アクセス数の2ページ目以降の積み上がり", () => {
  /** 最初に作品管理と1ページ目だけを渡し、あとで2ページ目を足した形 */
  async function firstThenSecondPage(): Promise<{ firstRows: number }> {
    register();
    const management = kakuyomuManagementEnvelope();
    const pageOne = kakuyomuAccessEnvelope(1);
    await harness.handOver(helperBundle([management, pageOne], { ownedVia: "owner-page" }));
    const firstRows = harness.rowsOf(work).length;
    // 「次へ」で2ページ目を開いたあと、もう一度押した束（1ページ目は溜まりに残っている）
    await harness.handOver(
      helperBundle([management, pageOne, kakuyomuAccessEnvelope(2)], { ownedVia: "owner-page" })
    );
    return { firstRows };
  }

  test("1ページ目の分は積み直さず、2ページ目の50話ぶんだけが増える", async () => {
    const { firstRows } = await firstThenSecondPage();

    expect(harness.rowsOf(work)).toHaveLength(firstRows + KAKUYOMU_ACCESS_PAGE_SIZE);
    // 積まなかったのは、作品管理の全行と1ページ目の50行（2回目の知らせに数が出る）
    const repeated = entryCount([kakuyomuManagementEnvelope(), kakuyomuAccessEnvelope(1)]);
    expect(harness.informed.at(-1)).toContain(`同じ数で積まなかったもの ${repeated}件`);
  });

  test("100話が1話ずつ数えられ、2ページ目の話の数は2ページ目の数", async () => {
    await firstThenSecondPage();

    const rows = harness.rowsOf(work);
    const latest = latestEpisodeValues(rows);
    // 作品管理が全話ぶん（219話）を持っているので、話の数は219のまま
    expect(latest.pv.size).toBe(KAKUYOMU_EPISODES);
    expect(latest.pv.get(1)?.value).toBe(kakuyomuAccessPv(1));
    expect(latest.pv.get(51)?.value).toBe(kakuyomuAccessPv(51));
    expect(latest.pv.get(100)?.value).toBe(kakuyomuAccessPv(100));
    // 3ページ目以降の話は、作品管理の数のまま（アクセス数をまだ読んでいない）
    expect(latest.pv.get(101)?.value).toBe(kakuyomuManagementPv(101));
    expect(buildReaderCharts(rows, null).episodes?.points).toHaveLength(KAKUYOMU_EPISODES);
    // 2ページ目の話は、2ページ目を読んだ回の日時を添えて言う（黙って混ぜない）
    const sources = computeReaderRates(rows).episodeSources;
    expect(sources.length).toBeGreaterThanOrEqual(2);
  });

  test("1ページ目を数分あとに読み直した束（数は同じ）を足しても、グラフと最新の数は二重にならない", async () => {
    await firstThenSecondPage();
    const laterRead = jstIso(Date.parse(KAKUYOMU_MANAGEMENT_READ_AT) + 2 * 60 * 60 * 1000);

    await harness.handOver(
      helperBundle([kakuyomuAccessEnvelope(1, { readAt: laterRead })], { ownedVia: "owner-page" })
    );

    const rows = harness.rowsOf(work);
    const latest = latestEpisodeValues(rows);
    expect(latest.pv.size).toBe(KAKUYOMU_EPISODES);
    // 読み直した1ページ目の話は、あとから読んだ日時の数（同じ数）で1話ぶんだけ
    expect(latest.pv.get(1)?.readAt).toBe(laterRead);
    expect(latest.pv.get(1)?.value).toBe(kakuyomuAccessPv(1));
    expect(buildReaderCharts(rows, null).episodes?.points).toHaveLength(KAKUYOMU_EPISODES);
    // 日ごとのPV（作品管理にだけある）は、1日1行のまま
    const days = rows.filter((row) => row.scope === "work" && row.period === "day");
    expect(days).toHaveLength(30);
    expect(KAKUYOMU_ACCESS_PAGES).toBe(5);
  });
});
