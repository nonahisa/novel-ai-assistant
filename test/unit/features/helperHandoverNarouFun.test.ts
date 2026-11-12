import { describe, expect, test } from "vitest";
import { computeReaderRates } from "../../../src/core/readerRates";
import { buildReaderCharts, type ReaderCharts } from "../../../src/core/readerStatsCharts";
import { siteFactsFor } from "../../../src/models/posting";
import { buildWritingStatsPanelHtml } from "../../../src/views/writingStatsPanelHtml";
import {
  helperBundle,
  jstDay,
  narouFunHelperEnvelope,
  NAROU_FUN_BOOKMARK_DELTAS,
  NAROU_FUN_FETCHED_AT,
  NAROU_FUN_FIRST_DAY,
  NAROU_FUN_NCODE,
  NAROU_FUN_OTHERS_NCODE,
  NAROU_FUN_RATING_DELTAS,
  NAROU_FUN_WORK_METRICS,
} from "../support/helperSamples";
import { onNarou, setupHandoverHarness, workEntry } from "../support/helperHandoverHarness";

/**
 * ヘルパー（なろうファンDB＝Narou.fun の作品ページを読む）が「まとめて渡す」で渡した束を、
 * 受け口から取り込んだとき、受け手の記録に何が入るか（ヘルパーの実機確認リスト
 * 「Narou.fun から読んだデータを…取り込めるか」「日ごとの表を…」「記録の日時が…」の、受け手の側）。
 *
 * 束の形は、リニューアル後（ヘルパー 0.14.2 以降）の実物の形（`support/helperSamples.ts`）。
 * 既存の `readerStatsNarouFun`・`readerStatsDailyChange` は、封筒の読み口と1件の取り込みを古い形で
 * 見ている。ここは **束の受け口を通し、ディスクの台帳を読み直す**ところが違う。
 *
 * 見張ること：
 * 1. 取り込んだ記録の中身（作品全体の1行・日ごと27行・タグと連載の状態・メモ・出どころ）
 * 2. ほかの方の作品のページの束を断る（自分の作品の分だけ入り、ほかの方の分は1行も入らない）
 * 3. 記録の日時が「データ取得」の日の 0:00（日本時間）。同じページを2度渡しても、データ取得の日が
 *    進んで日ごとの表が重なっても、重なった日は積まない
 * 4. 日ごとのブックマークの増減のグラフで、減った日は0の線より下・赤の棒（画面の組み立ての文字列を読む。
 *    色と写真は画面の自動テスト `e2e/readerStatsNarouFunDaily.test.ts`）
 */

const harness = setupHandoverHarness();
const work = workEntry("w_narou", "星を継ぐ者たち");

const FETCHED_TIME = Date.parse(NAROU_FUN_FETCHED_AT);

/** 手元に覚えたなろうの作品（台帳のNコードは、なろうのURLの形の小文字） */
function registerNarouWork(): void {
  harness.addWork(work, onNarou(NAROU_FUN_NCODE));
}

/** 台帳に書かれた日ごとの行（作品全体）。キー→行 */
function dayRows() {
  return harness.rowsOf(work).filter((row) => row.scope === "work" && row.period === "day");
}

describe("1. 取り込んだ記録の中身", () => {
  test("作品全体の1行・日ごとの27行が、ヘルパーの出した数のまま入る（出どころはメモ、台帳の出どころは貼り付けのまま）", async () => {
    registerNarouWork();
    await harness.handOver(
      helperBundle([narouFunHelperEnvelope()], { ownedVia: "approved" })
    );

    expect(harness.warned).toEqual([]);
    const rows = harness.rowsOf(work);
    expect(rows).toHaveLength(1 + NAROU_FUN_BOOKMARK_DELTAS.length);

    const total = rows.filter((row) => row.period === undefined);
    expect(total).toHaveLength(1);
    expect(total[0]).toMatchObject({
      site: "narou",
      scope: "work",
      source: "helper",
      metrics: NAROU_FUN_WORK_METRICS,
    });
    // 出どころが分かるメモ（なろう本体の管理画面の数と取り違えないため）
    expect(total[0].note).toBe("Narou.funから読み取り（日時はNarou.funのデータ取得の日）");

    // 日ごと：日付も数も、ヘルパーが前の日との差にした数のまま（負の日も残る）
    const days = dayRows();
    expect(days).toHaveLength(NAROU_FUN_BOOKMARK_DELTAS.length);
    NAROU_FUN_BOOKMARK_DELTAS.forEach((bookmarks, index) => {
      const key = jstDay(NAROU_FUN_FIRST_DAY, index);
      const row = days.find((candidate) => candidate.periodKey === key);
      expect(row, `${key} の行がありません`).toBeDefined();
      expect(row?.metrics).toEqual({
        bookmarks,
        narou_ratingPoints: NAROU_FUN_RATING_DELTAS[index],
      });
      expect(row?.source).toBe("helper");
    });
    expect(
      days.filter((row) => (row.metrics.bookmarks ?? 0) < 0).map((row) => [row.periodKey, row.metrics.bookmarks])
    ).toEqual([
      ["2026-10-12", -2],
      ["2026-10-19", -1],
      ["2026-10-28", -1],
    ]);

    // タグと連載の状態（束の1件に載ってきた省いてよい欄）は、作品の印には触らず事柄の欄へ
    const facts = siteFactsFor(harness.ledgerOf(work), "narou");
    expect(facts?.tags).toEqual(["異世界", "魔法"]);
    expect(facts?.completion).toBe("ongoing");
    expect(facts?.ownedVia).toBe("approved");

    // 知らせは1つ。作品の名前と画面の数を言い、失敗は無い
    expect(harness.informed).toHaveLength(1);
    expect(harness.informed[0]).toContain("「星を継ぐ者たち」1画面");
    expect(harness.refreshed).toEqual(["w_narou"]);
  });
});

describe("2. ほかの方の作品のページの束を断る", () => {
  test("自分の作品の分だけ入り、ほかの方の作品のページの分は1行も入らず、断った分を知らせる", async () => {
    registerNarouWork();
    await harness.handOver(
      helperBundle([
        narouFunHelperEnvelope(),
        narouFunHelperEnvelope({ ncode: NAROU_FUN_OTHERS_NCODE }),
      ])
    );

    expect(harness.rowsOf(work)).toHaveLength(1 + NAROU_FUN_BOOKMARK_DELTAS.length);
    expect(harness.warned).toHaveLength(1);
    const notice = harness.warned[0];
    expect(notice).toContain("「星を継ぐ者たち」1画面");
    expect(notice).toContain("取り込めなかったもの（1画面）");
    expect(notice.toLowerCase()).toContain(NAROU_FUN_OTHERS_NCODE);
    // ほかの方の作品の番号を、その場で登録して取り込むボタンは出さない（作者の裁定 2026-10-11）。
    // 文面は、作品IDの食い違いの一般の直し方（「投稿サイト設定」でNコードを登録）が添う
    expect(notice).not.toContain("［作品に登録する］");
  });

  test("ほかの方の作品のページだけの束は、台帳を1文字も書き換えない", async () => {
    registerNarouWork();
    const before = harness.rawLedgerOf(work);

    await harness.handOver(
      helperBundle([narouFunHelperEnvelope({ ncode: NAROU_FUN_OTHERS_NCODE })])
    );

    expect(harness.rawLedgerOf(work)).toBe(before);
    expect(harness.rowsOf(work)).toHaveLength(0);
    expect(harness.refreshed).toEqual([]);
    expect(harness.warned).toHaveLength(1);
    expect(harness.warned[0]).toContain("読者の反応を取り込めませんでした。");
    expect(harness.warned[0].toLowerCase()).toContain(NAROU_FUN_OTHERS_NCODE);
  });

  test("台帳になろうのNコードが無い作品へは、自分の作品のページでも入れない（照合できないため）", async () => {
    harness.addWork(work, { ...onNarou(NAROU_FUN_NCODE), siteProfiles: [] });
    const before = harness.rawLedgerOf(work);

    await harness.handOver(helperBundle([narouFunHelperEnvelope()]));

    expect(harness.rawLedgerOf(work)).toBe(before);
    expect(harness.rowsOf(work)).toHaveLength(0);
    expect(harness.warned).toHaveLength(1);
  });
});

describe("3. 記録の日時と、同じページを2度取り込んだとき", () => {
  test("記録の日時は、押した時刻でなく「データ取得」の日の 0:00（日本時間）", async () => {
    registerNarouWork();
    // 渡した時刻（handedAt）は取得の日と別の日にして、押した時刻に引きずられないことを見る
    await harness.handOver(
      helperBundle([narouFunHelperEnvelope()], { handedAt: "2026-11-03T08:00:00.000Z" })
    );

    const total = harness.rowsOf(work).find((row) => row.period === undefined);
    expect(Date.parse(total?.readAt ?? "")).toBe(FETCHED_TIME);
    // データ取得 2026/10/31 の 0:00（日本時間）＝ 10/30 15:00 UTC
    expect(Date.parse("2026-10-31T00:00:00+09:00")).toBe(FETCHED_TIME);
    for (const row of dayRows()) {
      expect(Date.parse(row.readAt)).toBe(FETCHED_TIME);
    }
  });

  test("メモの言い方は「データ取得の日」。古い「最終取得日時」は出さない", async () => {
    registerNarouWork();
    await harness.handOver(helperBundle([narouFunHelperEnvelope()]));

    const notes = new Set(harness.rowsOf(work).map((row) => row.note));
    expect([...notes]).toEqual(["Narou.funから読み取り（日時はNarou.funのデータ取得の日）"]);
    for (const note of notes) expect(note).not.toContain("最終取得日時");
    // 知らせにも、履歴の欄の文言にも古い言い方は出ない
    expect([...harness.informed, ...harness.warned].join("\n")).not.toContain("最終取得日時");
  });

  test("データ取得の日が読めなかった封筒は、押した時刻に落ち、メモがそう言う", async () => {
    registerNarouWork();
    const clicked = narouFunHelperEnvelope();
    clicked.readAt = "2026-11-03T08:00:00.000Z";
    clicked.readAtBasis = "clicked";

    await harness.handOver(helperBundle([clicked]));

    const total = harness.rowsOf(work).find((row) => row.period === undefined);
    expect(total?.readAt).toBe("2026-11-03T08:00:00.000Z");
    expect(total?.note).toBe("Narou.funから読み取り（日時は押した時刻。Narou.funのデータ取得の日は読めず）");
  });

  test("同じ束をもう一度渡しても、記録は1行も増えない", async () => {
    registerNarouWork();
    const bundle = helperBundle([narouFunHelperEnvelope()]);
    await harness.handOver(bundle);
    const first = harness.rowsOf(work).length;

    await harness.handOver(bundle);

    expect(harness.rowsOf(work)).toHaveLength(first);
    expect(harness.informed.at(-1)).toContain("すでに取り込んだ数と同じでした");
    expect(harness.informed.at(-1)).toContain("記録は変えていません");
  });

  test("あとで押し直して渡した束（渡した時刻だけ違う）でも、記録は増えない", async () => {
    registerNarouWork();
    await harness.handOver(
      helperBundle([narouFunHelperEnvelope()], { handedAt: "2026-10-31T01:30:00.000Z" })
    );
    const first = harness.rowsOf(work).length;

    await harness.handOver(
      helperBundle([narouFunHelperEnvelope()], { handedAt: "2026-10-31T23:10:00.000Z" })
    );

    expect(harness.rowsOf(work)).toHaveLength(first);
  });

  test("あくる日のデータ取得で日ごとの表が1日ずれても、重なった26日は積まず、新しい1日と作品全体だけが増える", async () => {
    registerNarouWork();
    await harness.handOver(helperBundle([narouFunHelperEnvelope()]));
    const first = harness.rowsOf(work).length;

    await harness.handOver(helperBundle([narouFunHelperEnvelope({ shiftDays: 1 })]));

    const rows = harness.rowsOf(work);
    // 作品全体（取得の日が違うので別の記録）＋ 新しい日1つ
    expect(rows).toHaveLength(first + 2);
    expect(dayRows()).toHaveLength(NAROU_FUN_BOOKMARK_DELTAS.length + 1);
    expect(harness.informed.at(-1)).toContain("同じ数で積まなかったもの 26件");
  });

  test("サイトが数え直した日（同じ日で数が違う）は、読むときに新しい取得の数が勝つ", async () => {
    registerNarouWork();
    await harness.handOver(helperBundle([narouFunHelperEnvelope()]));
    const recount = narouFunHelperEnvelope({ shiftDays: 1 });
    // 10/12 の数を数え直した形（外された −2 が −3 になった）
    const entry = (recount.entries as Array<Record<string, unknown>>).find(
      (candidate) => candidate.periodKey === "2026-10-12"
    );
    (entry?.metrics as Record<string, number>).bookmarks = -3;

    await harness.handOver(helperBundle([recount]));

    const charts = buildReaderCharts(
      harness.rowsOf(work).filter((row) => row.site === "narou"),
      null
    );
    const bookmark = charts.changes.find((chart) => chart.metric === "bookmarks" && chart.period === "day");
    expect(bookmark?.points.find((point) => point.key === "2026-10-12")?.value).toBe(-3);
    // 同じ日が2本にならない
    expect(new Set(bookmark?.points.map((point) => point.key)).size).toBe(bookmark?.points.length);
  });
});

describe("4. 日ごとのブックマークの増減のグラフ（減った日は0の線より下・赤）", () => {
  const panelHtml = buildWritingStatsPanelHtml("NONCE123", "vscode-resource:");
  const panelScript = (() => {
    const found = panelHtml.match(/<script nonce="NONCE123">([\s\S]*?)<\/script>/);
    if (!found) throw new Error("スクリプトが見つかりません");
    return found[1];
  })();

  /** 画面のスクリプトから、関数を名前で切り出す（`readerStatsDailyChange.test.ts` と同じ手） */
  function extractFunction(name: string): string {
    const head = panelScript.indexOf("function " + name + "(");
    expect(head, name + " が見つからない").toBeGreaterThanOrEqual(0);
    let depth = 0;
    let started = false;
    for (let index = head; index < panelScript.length; index++) {
      if (panelScript[index] === "{") {
        depth++;
        started = true;
      } else if (panelScript[index] === "}") {
        depth--;
        if (started && depth === 0) return panelScript.slice(head, index + 1);
      }
    }
    throw new Error(name + " の終わりが見つからない");
  }
  const needs = [
    "escapeHtml",
    "formatCount",
    "formatWhen",
    "estimateLabelWidth",
    "readerTickIndices",
    "readerBarChart",
    "readerLineChart",
    "readerChartBlock",
    "readerSignedCount",
  ];
  const render = (charts: ReaderCharts | null): string =>
    (
      new Function(
        [...needs, "renderReaderCharts"].map(extractFunction).join("\n") + "\nreturn renderReaderCharts;"
      )() as (charts: ReaderCharts | null) => string
    )(charts);

  /** 画面の組み立ての文字列から、棒グラフの 0 の線の高さと、各棒（向き・位置・高さ・負の印）を読む */
  function bars(html: string): { zeroY: number; bars: Array<{ y: number; height: number; negative: boolean; title: string }> } {
    // ブックマークの増減のグラフの塊だけを取る（評価ポイントのグラフと混ざらないように）
    const start = html.indexOf("日ごとのブックマークの増減");
    expect(start, "ブックマークの増減のグラフが出ていません").toBeGreaterThanOrEqual(0);
    const rest = html.slice(start);
    const end = rest.indexOf("日ごとの評価ポイントの増減");
    const block = end >= 0 ? rest.slice(0, end) : rest;
    const zero = /<line class="axis" x1="[\d.]+" y1="([\d.]+)"/.exec(block);
    expect(zero, "0の線がありません").not.toBeNull();
    const found = [...block.matchAll(/<rect class="bar( negative)?[^"]*" x="[\d.]+" y="([\d.]+)" width="[\d.]+" height="([\d.]+)" rx="1"><title>([^<]*)<\/title>/g)];
    return {
      zeroY: Number(zero?.[1]),
      bars: found.map((match) => ({
        negative: match[1] !== undefined,
        y: Number(match[2]),
        height: Number(match[3]),
        title: match[4],
      })),
    };
  }

  test("取り込んだ束から組んだグラフで、減った3日だけが 0 の線より下へ伸びる赤の棒（negative）になる", async () => {
    registerNarouWork();
    await harness.handOver(helperBundle([narouFunHelperEnvelope()]));
    const records = harness.rowsOf(work).filter((row) => row.site === "narou");
    const html = render(buildReaderCharts(records, computeReaderRates(records).base?.episode ?? null));

    const chart = bars(html);
    expect(chart.bars).toHaveLength(NAROU_FUN_BOOKMARK_DELTAS.length);
    const negatives = chart.bars.filter((bar) => bar.negative);
    expect(negatives.map((bar) => bar.title)).toEqual([
      expect.stringContaining("−2"),
      expect.stringContaining("−1"),
      expect.stringContaining("−1"),
    ]);
    // 0の線は上端でも下端でもない（負の棒の分だけ上がる）
    expect(chart.zeroY).toBeGreaterThan(16);
    expect(chart.zeroY).toBeLessThan(156);
    for (const bar of chart.bars) {
      if (bar.negative) {
        // 負の棒は0の線から下へ（上端が0の線と同じ高さ）、高さがある
        expect(bar.y).toBeCloseTo(chart.zeroY, 5);
        expect(bar.height).toBeGreaterThan(0);
      } else if (bar.height > 0) {
        // 増えた日は0の線から上へ（下端が0の線と同じ高さ）
        expect(bar.y + bar.height).toBeCloseTo(chart.zeroY, 5);
      }
    }
    // 棒の長さは数に比例する（−2 は −1 の2倍）
    const lengths = negatives.map((bar) => bar.height);
    expect(lengths[0]).toBeCloseTo(lengths[1] * 2, 5);
    // 減った日があるときだけ出る読み方の添え書き
    expect(html).toContain("0の線より下");
  });
});
