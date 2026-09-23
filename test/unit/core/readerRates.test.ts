import { describe, expect, test } from "vitest";
import {
  computeReaderRates,
  episodeRanges,
  formatPercent,
  type ReaderRates,
} from "../../../src/core/readerRates";
import {
  buildReaderCharts,
  type ReaderCharts,
} from "../../../src/core/readerStatsCharts";
import { buildPostingSiteRecords } from "../../../src/core/postingSiteRecords";
import {
  emptyPostingLedger,
  withReaderStats,
  type ReaderStatsRecord,
} from "../../../src/models/posting";
import { buildWritingStatsPanelHtml } from "../../../src/views/writingStatsPanelHtml";

/**
 * 離脱率・ブックマーク率・評価率と、PVのグラフ（作者の依頼、2026-09-23）。
 *
 * 数字は**教科書チートの実データ**の形である（1話PV 23,299・219話PV 1,398・
 * フォロワー 2,814・評価した人数 611。219話の最終更新は 2024-07-31、
 * 読み取りは 2026-09-23）。
 *
 * **分母は第1話のPV**（作者の訂正「ブックマーク率等は第一話読者でした」）。
 * 基準の話を使うのは離脱率だけである。
 */

const readAt = "2026-09-23T03:00:00.000Z";
const HOUR = 60 * 60 * 1000;

function episode(
  number: number,
  pv: number | undefined,
  patch: Partial<ReaderStatsRecord> = {}
): ReaderStatsRecord {
  return {
    site: "kakuyomu",
    readAt,
    scope: "episode",
    episode: number,
    metrics: pv === undefined ? { likes: 1 } : { pv },
    source: "helper",
    ...patch,
  };
}

function work(
  metrics: ReaderStatsRecord["metrics"],
  patch: Partial<ReaderStatsRecord> = {}
): ReaderStatsRecord {
  return {
    site: "kakuyomu",
    readAt,
    scope: "work",
    metrics,
    source: "helper",
    ...patch,
  };
}

/** 教科書チートの1回ぶん（220話は更新したばかり） */
function textbook(): ReaderStatsRecord[] {
  return [
    work({ pv: 1053339, bookmarks: 2814, reviews: 611 }),
    episode(1, 23299, { updatedAt: "2021-01-10T12:00:00+09:00" }),
    episode(2, 15000, { updatedAt: "2021-01-11T12:00:00+09:00" }),
    episode(219, 1398, { updatedAt: "2024-07-31T08:13:00+09:00" }),
    // 1日前に更新した話は、まだ読まれ切っていないので基準にしない
    episode(220, 12, {
      updatedAt: new Date(Date.parse(readAt) - 24 * HOUR).toISOString(),
    }),
  ];
}

describe("率の計算（教科書チート）", () => {
  test("基準の話は219話、3つの率は式と実際の数つきで出る", () => {
    const rates = computeReaderRates(textbook());

    expect(rates.base?.episode).toBe(219);
    expect(rates.base?.pv).toBe(1398);

    expect(rates.dropout.value).toBeCloseTo(1 - 1398 / 23299, 10);
    expect(rates.dropout.percent).toBe("94.0%");
    expect(rates.dropout.expression).toBe("1 − 1,398 ÷ 23,299 = 94.0%");
    expect(rates.dropout.formula).toBe("1 − 第219話のPV ÷ 第1話のPV");

    expect(rates.bookmark.value).toBeCloseTo(2814 / 23299, 10);
    expect(rates.bookmark.percent).toBe("12.1%");
    expect(rates.bookmark.expression).toBe("2,814 ÷ 23,299 = 12.1%");

    expect(rates.rating.value).toBeCloseTo(611 / 23299, 10);
    expect(rates.rating.percent).toBe("2.6%");
    expect(rates.rating.expression).toBe("611 ÷ 23,299 = 2.6%");
    expect(rates.rating.operands.map((operand) => operand.value)).toEqual([
      611, 23299,
    ]);
  });

  test("丸めるのは表示だけ", () => {
    expect(formatPercent(611 / 23299)).toBe("2.6%");
    expect(formatPercent(0.9999)).toBe("100.0%");
  });
});

describe("3日の境目", () => {
  function withLatestUpdatedHoursAgo(hours: number): ReaderStatsRecord[] {
    return [
      episode(1, 100, { updatedAt: "2021-01-10T12:00:00+09:00" }),
      episode(5, 40, {
        updatedAt: new Date(Date.parse(readAt) - hours * HOUR).toISOString(),
      }),
    ];
  }

  test("71時間前の更新は基準にしない", () => {
    expect(computeReaderRates(withLatestUpdatedHoursAgo(71)).base?.episode).toBe(1);
  });

  test("72時間ちょうど前の更新は基準にする", () => {
    const rates = computeReaderRates(withLatestUpdatedHoursAgo(72));
    expect(rates.base?.episode).toBe(5);
    expect(rates.dropout.expression).toBe("1 − 40 ÷ 100 = 60.0%");
  });
});

describe("材料が欠けたら、0%にせず理由を返す", () => {
  test("更新日の分かる話が無ければ、離脱率だけ出さない（ほかの2つは出す）", () => {
    const rates = computeReaderRates([
      work({ bookmarks: 2814, reviews: 611 }),
      episode(1, 23299),
      episode(219, 1398),
    ]);
    expect(rates.base).toBeNull();
    expect(rates.dropout.value).toBeUndefined();
    expect(rates.dropout.percent).toBeUndefined();
    expect(rates.dropout.missing).toBe("更新日の分かる話がありません");
    expect(rates.bookmark.percent).toBe("12.1%");
    expect(rates.rating.percent).toBe("2.6%");
  });

  test("3日以上前に更新された話が無ければ、そう言う", () => {
    const rates = computeReaderRates([
      episode(1, 100, {
        updatedAt: new Date(Date.parse(readAt) - 10 * HOUR).toISOString(),
      }),
    ]);
    expect(rates.dropout.missing).toBe("更新から3日以上たった話がありません");
  });

  test("第1話のPVが無ければ、3つとも出さない", () => {
    const rates = computeReaderRates([
      work({ bookmarks: 2814, reviews: 611 }),
      episode(1, undefined, { updatedAt: "2021-01-10T12:00:00+09:00" }),
      episode(219, 1398, { updatedAt: "2024-07-31T08:13:00+09:00" }),
    ]);
    expect(rates.dropout.missing).toBe("第1話のPVがありません");
    expect(rates.bookmark.missing).toBe("第1話のPVがありません");
    expect(rates.rating.missing).toBe("第1話のPVがありません");
    // 読めたぶんの数は残す（画面で「何が足りないか」を見比べられる）
    expect(rates.bookmark.operands.map((operand) => operand.value)).toEqual([
      2814,
    ]);
  });

  test("第1話のPVが0なら割らない", () => {
    const rates = computeReaderRates([
      work({ bookmarks: 5 }),
      episode(1, 0),
    ]);
    expect(rates.bookmark.value).toBeUndefined();
    expect(rates.bookmark.missing).toContain("0では割れません");
  });

  test("基準の話のPVが無ければ、離脱率だけ出さない", () => {
    const rates = computeReaderRates([
      work({ bookmarks: 2814 }),
      episode(1, 23299, { updatedAt: "2021-01-10T12:00:00+09:00" }),
      episode(219, undefined, { updatedAt: "2024-07-31T08:13:00+09:00" }),
    ]);
    expect(rates.base?.episode).toBe(219);
    expect(rates.dropout.missing).toBe("第219話のPVがありません");
    expect(rates.bookmark.percent).toBe("12.1%");
  });

  test("作品全体の数が無ければ、その率だけ出さない", () => {
    const rates = computeReaderRates([
      work({ pv: 100 }),
      episode(1, 23299),
    ]);
    expect(rates.bookmark.missing).toBe("作品全体のブックマークがありません");
    expect(rates.rating.missing).toBe(
      "作品全体のレビュー（評価した人数）がありません"
    );
  });

  test("話ごとの記録が1件も無ければ、画面へは渡さない", () => {
    const rates = computeReaderRates([work({ bookmarks: 1, reviews: 1 })]);
    expect(rates.episodeReadAt).toBeNull();
    expect(rates.bookmark.missing).toBe("話ごとの記録がありません");

    let ledger = emptyPostingLedger();
    ledger = withReaderStats(ledger, work({ bookmarks: 1, reviews: 1 }));
    const [record] = buildPostingSiteRecords(ledger);
    expect(record.readerRates).toBeNull();
  });
});

describe("同じ話が何度も入っているとき", () => {
  test("各話の、その話のいちばん新しい記録で計算する", () => {
    const older = "2026-09-20T03:00:00.000Z";
    const rates = computeReaderRates([
      // 新しい回を先に足してあっても、日時で選ぶ
      episode(1, 23299, { updatedAt: "2021-01-10T12:00:00+09:00" }),
      episode(1, 20000, { readAt: older, updatedAt: "2021-01-10T12:00:00+09:00" }),
      episode(219, 1398, { updatedAt: "2024-07-31T08:13:00+09:00" }),
      episode(219, 1200, { readAt: older, updatedAt: "2024-07-31T08:13:00+09:00" }),
      work({ bookmarks: 2814, reviews: 611 }),
      work({ bookmarks: 2700, reviews: 600 }, { readAt: older }),
    ]);
    expect(rates.episodeReadAt).toBe(readAt);
    expect(rates.dropout.expression).toBe("1 − 1,398 ÷ 23,299 = 94.0%");
    expect(rates.bookmark.expression).toBe("2,814 ÷ 23,299 = 12.1%");
  });

  test("同じ日時に同じ話が2件あれば、あとから足したほう", () => {
    const rates = computeReaderRates([
      work({ bookmarks: 10 }),
      episode(1, 999),
      episode(1, 1000),
    ]);
    expect(rates.bookmark.expression).toBe("10 ÷ 1,000 = 1.0%");
  });

  test("作品全体の数が話ごとと別の回にしか無ければ、いつの数かを添える", () => {
    const older = "2026-09-20T03:00:00.000Z";
    const rates = computeReaderRates([
      work({ bookmarks: 2814 }, { readAt: older }),
      episode(1, 23299),
    ]);
    expect(rates.bookmark.percent).toBe("12.1%");
    expect(rates.bookmark.operands[0].readAt).toBe(older);
    // 同じ回にあれば添えない
    const same = computeReaderRates([work({ bookmarks: 2814 }), episode(1, 23299)]);
    expect(same.bookmark.operands[0].readAt).toBeUndefined();
  });
});

describe("グラフの点", () => {
  test("各話：各話の最新の記録を話数順に、基準の話に印", () => {
    const records = [
      episode(3, 30, { readAt: "2026-09-20T03:00:00.000Z" }),
      ...textbook(),
    ];
    const charts = buildReaderCharts(records, 219);
    // 3話は前の回にしか無いが、その話の最新の記録として並ぶ
    expect(charts.episodes?.points.map((point) => point.key)).toEqual([
      "1", "2", "3", "219", "220",
    ]);
    expect(charts.episodes?.points[0].value).toBe(23299);
    expect(
      charts.episodes?.points.filter((point) => point.marked).map((p) => p.key)
    ).toEqual(["219"]);
  });

  test("日：同じ日が何度も入っていたら、いちばん新しい取り込みの値", () => {
    const day = (key: string, pv: number, at: string) =>
      work({ pv }, { period: "day", periodKey: key, readAt: at });
    const charts = buildReaderCharts(
      [
        day("2026-08-25", 7, "2026-08-25T10:00:00.000Z"),
        day("2026-08-24", 5, "2026-08-24T10:00:00.000Z"),
        // あとの取り込みで、同じ日の数が増えている
        day("2026-08-24", 9, "2026-08-26T10:00:00.000Z"),
      ],
      null
    );
    expect(charts.day?.points).toEqual([
      { key: "2026-08-24", label: "8/24", value: 9 },
      { key: "2026-08-25", label: "8/25", value: 7 },
    ]);
  });

  test("月：同じ扱い。年は記録が無ければ出さない", () => {
    const charts = buildReaderCharts(
      [
        work({ pv: 667 }, { period: "month", periodKey: "2026-08" }),
        work({ pv: 120 }, { period: "month", periodKey: "2026-09" }),
      ],
      null
    );
    expect(charts.month?.points.map((point) => point.label)).toEqual([
      "2026/08",
      "2026/09",
    ]);
    expect(charts.year).toBeNull();
    expect(charts.day).toBeNull();
    expect(charts.episodes).toBeNull();
  });

  test("合計：作品全体のPV（その時点）を、取り込みの日時順に1点ずつ", () => {
    const charts = buildReaderCharts(
      [
        work({ pv: 1053339 }, { readAt: "2026-09-23T03:00:00.000Z" }),
        work({ pv: 1050000 }, { readAt: "2026-09-20T03:00:00.000Z" }),
        // 日ごとの記録は合計に混ぜない
        work({ pv: 5 }, { period: "day", periodKey: "2026-09-20" }),
      ],
      null
    );
    expect(charts.total?.points.map((point) => point.value)).toEqual([
      1050000, 1053339,
    ]);
  });

  test("材料が1つも無ければ、どのグラフも null", () => {
    const charts = buildReaderCharts([work({ bookmarks: 3 })], null);
    expect(charts).toEqual({
      episodes: null,
      day: null,
      month: null,
      year: null,
      total: null,
      // 増減のグラフ（残課題 B11 の続き）も、材料が無ければ1つも無い
      changes: [],
    });
  });
});

/**
 * 画面の組み立て（WebViewのスクリプト）を、そのまま呼べる形にして確かめる。
 * 手は postingSiteRecords.test.ts と同じ（中括弧の対応で切り出す）。
 */
const panelHtml = buildWritingStatsPanelHtml("NONCE123", "vscode-resource:");
const panelScript = (() => {
  const found = panelHtml.match(/<script nonce="NONCE123">([\s\S]*?)<\/script>/);
  if (!found) throw new Error("スクリプトが見つかりません");
  return found[1];
})();

function extractFunction(source: string, name: string): string {
  const head = source.indexOf("function " + name + "(");
  expect(head, name + " が見つからない").toBeGreaterThanOrEqual(0);
  let depth = 0;
  let started = false;
  for (let index = head; index < source.length; index++) {
    if (source[index] === "{") {
      depth++;
      started = true;
    } else if (source[index] === "}") {
      depth--;
      if (started && depth === 0) return source.slice(head, index + 1);
    }
  }
  throw new Error(name + " の終わりが見つからない");
}

function panelFunction<T>(name: string, needs: string[]): T {
  return new Function(
    [
      ...needs.map((dependency) => extractFunction(panelScript, dependency)),
      extractFunction(panelScript, name),
      "return " + name + ";",
    ].join("\n")
  )() as T;
}

const CHART_NEEDS = [
  "escapeHtml",
  "formatCount",
  "formatWhen",
  "estimateLabelWidth",
  "readerTickIndices",
  "readerBarChart",
  "readerLineChart",
  "readerChartBlock",
];

describe("画面：グラフ", () => {
  const render = () =>
    panelFunction<(charts: ReaderCharts | null) => string>(
      "renderReaderCharts",
      CHART_NEEDS
    );

  test("材料のあるグラフだけを出す", () => {
    const charts = buildReaderCharts(
      [
        ...textbook(),
        work({ pv: 5 }, { period: "day", periodKey: "2026-09-22" }),
      ],
      219
    );
    const html = render()(charts);
    expect(html).toContain("話ごとのPV");
    expect(html).toContain("日ごとのPV");
    expect(html).toContain("作品全体のPV（取り込みごとの累計）");
    expect(html).not.toContain("月ごとのPV");
    expect(html).not.toContain("年ごとのPV");
    // 執筆量のグラフと同じ作り
    expect(html).toContain('class="chart-wrap"');
    expect(html).toContain('class="bar mark"');
    expect(html).toContain("離脱率の基準の話");
  });

  test("何も無ければ空（見出しも出さない）", () => {
    expect(render()(buildReaderCharts([], null))).toBe("");
    expect(render()(null)).toBe("");
  });

  test("年ごとの記録があれば、年のグラフが出る", () => {
    const html = render()(
      buildReaderCharts(
        [work({ pv: 9000 }, { period: "year", periodKey: "2025" })],
        null
      )
    );
    expect(html).toContain("年ごとのPV");
  });
});

describe("画面：率", () => {
  const render = () =>
    panelFunction<(rates: ReaderRates | null) => string>("renderReaderRates", [
      "escapeHtml",
      "formatCount",
      "formatWhen",
      "readerEpisodeSourcesText",
    ]);

  test("率と、実際の数を入れた式と、言葉の式が出る", () => {
    const html = render()(computeReaderRates(textbook()));
    expect(html).toContain("94.0%");
    expect(html).toContain("1 − 1,398 ÷ 23,299 = 94.0%");
    expect(html).toContain("2,814 ÷ 23,299 = 12.1%");
    expect(html).toContain("611 ÷ 23,299 = 2.6%");
    expect(html).toContain("作品全体のブックマーク ÷ 第1話のPV");
    expect(html).toContain("離脱率の基準は第219話");
  });

  test("出せない率は — と理由", () => {
    const html = render()(
      computeReaderRates([work({ bookmarks: 2814 }), episode(1, 23299)])
    );
    expect(html).toContain("更新日の分かる話がありません");
    expect(html).toContain("—");
    expect(html).not.toContain("0.0%");
  });

  test("率が無ければ何も出さない", () => {
    expect(render()(null)).toBe("");
  });

  test("サイトの記録の組み立てから、率とグラフが画面へ渡る", () => {
    let ledger = emptyPostingLedger();
    for (const record of textbook()) ledger = withReaderStats(ledger, record);
    const [record] = buildPostingSiteRecords(ledger);
    expect(record.readerRates?.rating.percent).toBe("2.6%");
    expect(record.readerCharts.episodes?.points).toHaveLength(4);
    // 台帳は1件も捨てていない
    expect(ledger.readerStats).toHaveLength(5);
  });
});

/**
 * **あとから別の取り込みが入っても、率が消えない**（2026-09-23 の見直し）。
 *
 * 作品管理ページは全話ぶん（更新日つき）、アクセス数ページは50話ずつ
 * （更新日なし）。以前の「いちばん新しい取り込み1回ぶん」では、アクセス数
 * ページをあとから取り込んだだけで基準の話が消えていた。
 */
describe("話ごとに、その話の最新の記録を拾う", () => {
  const later = new Date(Date.parse(readAt) + HOUR).toISOString();

  /** アクセス数ページの1ページ目（1〜50話、更新日なし）。数は同じ時点のもの */
  function accessPage(at: string): ReaderStatsRecord[] {
    const pages: ReaderStatsRecord[] = [];
    for (let number = 1; number <= 50; number++) {
      const pv = number === 1 ? 23299 : number === 2 ? 15000 : 1000 + number;
      pages.push(episode(number, pv, { readAt: at }));
    }
    return pages;
  }

  test("アクセス数ページをあとから取り込んでも、作品管理で決まる率は変わらない", () => {
    const before = computeReaderRates(textbook());
    const after = computeReaderRates([...textbook(), ...accessPage(later)]);

    expect(after.base?.episode).toBe(219);
    expect(after.dropout.expression).toBe(before.dropout.expression);
    expect(after.bookmark.expression).toBe(before.bookmark.expression);
    expect(after.rating.expression).toBe(before.rating.expression);
    expect(after.dropout.percent).toBe("94.0%");
    expect(after.bookmark.percent).toBe("12.1%");
    expect(after.rating.percent).toBe("2.6%");
  });

  test("話ごとの数が複数の取り込みにまたがれば、どの話がいつの数かを持つ", () => {
    const rates = computeReaderRates([...textbook(), ...accessPage(later)]);
    expect(rates.episodeSources).toEqual([
      { readAt: later, episodes: "第1〜50話" },
      { readAt, episodes: "第219〜220話" },
    ]);
    // 第219話のPVは前の回の数なので、いつの数かを添える
    expect(rates.dropout.operands[0]).toEqual({
      label: "第219話のPV",
      value: 1398,
      readAt,
    });

    const html = panelFunction<(rates: ReaderRates | null) => string>(
      "renderReaderRates",
      ["escapeHtml", "formatCount", "formatWhen", "readerEpisodeSourcesText"]
    )(rates);
    expect(html).toContain("最新の取り込み（");
    expect(html).toContain("第1〜50話");
    expect(html).toContain("それ以前（");
    expect(html).toContain("第219〜220話");
  });

  test("1回ぶんだけなら、その日時だけを言う", () => {
    const rates = computeReaderRates(textbook());
    expect(rates.episodeSources).toHaveLength(1);
  });

  test("最終更新とPVが別の回でも、基準の話が決まる", () => {
    const rates = computeReaderRates([
      // 作品管理（古い回）：更新日だけ・PVなし
      episode(1, undefined, { updatedAt: "2021-01-10T12:00:00+09:00" }),
      episode(9, undefined, { updatedAt: "2024-07-31T08:13:00+09:00" }),
      // アクセス数（新しい回）：PVだけ
      episode(1, 500, { readAt: later }),
      episode(9, 100, { readAt: later }),
    ]);
    expect(rates.base?.episode).toBe(9);
    expect(rates.base?.updatedReadAt).toBe(readAt);
    expect(rates.dropout.expression).toBe("1 − 100 ÷ 500 = 80.0%");
  });

  test("3日の境目は、更新日を読んだ時点で見る（あとの取り込みの日時では見ない）", () => {
    const updated = new Date(Date.parse(readAt) - 24 * HOUR).toISOString();
    const fiveDaysLater = new Date(
      Date.parse(readAt) + 5 * 24 * HOUR
    ).toISOString();
    const rates = computeReaderRates([
      episode(1, 100, { updatedAt: "2021-01-10T12:00:00+09:00" }),
      // 更新の1日後に読んだ——このときはまだ読まれ切っていない
      episode(5, 40, { updatedAt: updated }),
      // 5日後にアクセス数ページで読み直した（更新日は持たない）
      episode(5, 60, { readAt: fiveDaysLater }),
    ]);
    expect(rates.base?.episode).toBe(1);
  });

  test("話数の範囲の言い方", () => {
    expect(episodeRanges([5, 1, 2, 3])).toBe("第1〜3話、第5話");
    expect(episodeRanges([7])).toBe("第7話");
  });
});

/**
 * **「今日」の欄は、読み取った日の記録だけ**（2026-09-23）。貼り込み係 0.5.0 は
 * 日ごとのPVを30日ぶん送ってくるので、全部を並べると今日の欄が30日ぶんになる。
 */
describe("今日の欄", () => {
  // 正午（UTC）にしておけば、どの時間帯でも手元の日付は 9/23 になる
  const noon = "2026-09-23T12:00:00.000Z";

  function withDays(days: string[]): ReturnType<typeof buildPostingSiteRecords> {
    let ledger = emptyPostingLedger();
    ledger = withReaderStats(ledger, work({ pv: 1053339 }, { readAt: noon }));
    days.forEach((key, index) => {
      ledger = withReaderStats(
        ledger,
        work(
          { pv: index + 1 },
          { readAt: noon, period: "day", periodKey: key }
        )
      );
    });
    return buildPostingSiteRecords(ledger);
  }

  test("30日ぶん入っていても、今日の1日ぶんだけを出す", () => {
    const days: string[] = [];
    for (let day = 25; day <= 31; day++) days.push(`2026-08-${day}`);
    for (let day = 1; day <= 23; day++) {
      days.push(`2026-09-${String(day).padStart(2, "0")}`);
    }
    const [record] = withDays(days);
    // 9/23 は30件目
    expect(record.readerLatest?.day).toBe("PV 30");
    expect(record.readerWork?.rows[0].day).toBe("PV 30");
    // ほかの日はグラフの材料として残っている
    expect(record.readerCharts.day?.points).toHaveLength(30);
  });

  test("今日の記録が無い回は、いちばん新しい日を1件だけ日付つきで出す", () => {
    const [record] = withDays(["2026-09-20", "2026-09-22", "2026-09-21"]);
    expect(record.readerLatest?.day).toBe("PV 2（9/22）");
  });
});
