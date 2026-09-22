import { describe, expect, test } from "vitest";
import {
  buildReaderAdvice,
  READER_ADVICE_SOURCES,
  type ReaderAdvice,
} from "../../src/core/readerAdvice";
import { computeReaderRates } from "../../src/core/readerRates";
import { buildPostingSiteRecords } from "../../src/core/postingSiteRecords";
import {
  emptyPostingLedger,
  withReaderStats,
  type ReaderStatsRecord,
} from "../../src/models/posting";
import { buildWritingStatsPanelHtml } from "../../src/views/writingStatsPanelHtml";

/**
 * 読者の反応の助言（残課題 B9。作者の依頼、2026-09-23）。
 *
 * 助言の元は `docs/読者の反応の助言_作者の考え.md` だけ。**記事にある目安だけで
 * 判定する**——離脱率（100%／50話で約70%／約50%）、序盤（1話→2話で8割、
 * 序盤全体で7割）、評価率（3割を超えれば）。ブックマーク率には目安が無い。
 *
 * **見逃しと誤検出の両方**を見る。目安を超えない作品に助言が出ないことも確かめる。
 */

const readAt = "2026-09-23T03:00:00.000Z";
/** 3日以上前（基準の話になれる） */
const settled = "2026-09-01T12:00:00+09:00";

function episode(
  number: number,
  pv: number,
  patch: Partial<ReaderStatsRecord> = {}
): ReaderStatsRecord {
  return {
    site: "kakuyomu",
    readAt,
    scope: "episode",
    episode: number,
    metrics: { pv },
    source: "helper",
    ...patch,
  };
}

function work(metrics: ReaderStatsRecord["metrics"]): ReaderStatsRecord {
  return {
    site: "kakuyomu",
    readAt,
    scope: "work",
    metrics,
    source: "helper",
  };
}

/**
 * 話ごとのPVの並びから記録を作る。最後の話にだけ更新日を付ける
 * （＝最後の話が基準の話になる）。
 */
function series(
  pvs: readonly number[],
  workMetrics: ReaderStatsRecord["metrics"] = { bookmarks: 10, reviews: 10 }
): ReaderStatsRecord[] {
  return [
    work(workMetrics),
    ...pvs.map((pv, index) =>
      episode(
        index + 1,
        pv,
        index === pvs.length - 1 ? { updatedAt: settled } : {}
      )
    ),
  ];
}

function adviceOf(records: ReaderStatsRecord[]): ReaderAdvice {
  return buildReaderAdvice(computeReaderRates(records), records);
}

function topics(advice: ReaderAdvice): string[] {
  return advice.items.map((item) => item.topic);
}

/** 画面に出る文字を全部つなげたもの（言ってはいけない語を探す） */
function allText(advice: ReaderAdvice): string {
  return [
    ...advice.items.flatMap((item) => [
      item.title,
      item.text,
      ...item.suggestions,
      ...item.sources.map((source) => source.label),
    ]),
    ...advice.withheld.map((note) => note.text),
    ...advice.cautions.map((note) => note.text),
  ].join("\n");
}

describe("離脱率の目安（100%／中堅70%／書籍化50%）", () => {
  test("50%ちょうどは書籍化レベル。話ごとの減り方の助言は出さない（誤検出を見る）", () => {
    // 100 → 50：離脱率 50.0%
    const advice = adviceOf(series([100, 80, 70, 60, 50]));
    const dropout = advice.items.find((item) => item.topic === "dropout");
    expect(dropout?.text).toContain("50.0%");
    expect(dropout?.text).toContain("書籍化レベル");
    expect(topics(advice)).not.toContain("decline");
    expect(dropout?.suggestions).toEqual([]);
  });

  test("50%を少しでも超えたら、中堅と書籍化のあいだ。減った話を指す（見逃しを見る）", () => {
    // 100 → 49：離脱率 51.0%
    const advice = adviceOf(series([100, 90, 60, 58, 49]));
    const dropout = advice.items.find((item) => item.topic === "dropout");
    expect(dropout?.text).toContain("51.0%");
    expect(dropout?.text).toContain("あいだ");
    const decline = advice.items.find((item) => item.topic === "decline");
    // それまでの最少（第2話 90）から第3話 60 へ（−33.3%）がいちばん大きい
    expect(decline?.drops[0]).toMatchObject({
      episode: 3,
      pv: 60,
      fromEpisode: 2,
      fromPv: 90,
      percent: "33.3%",
    });
  });

  test("70%ちょうどは中堅の目安の内。70%を超えたら目安より高い", () => {
    const at = adviceOf(series([100, 60, 50, 40, 30]));
    expect(at.items.find((item) => item.topic === "dropout")?.text).toContain(
      "あいだ"
    );
    const over = adviceOf(series([100, 60, 50, 40, 29]));
    expect(
      over.items.find((item) => item.topic === "dropout")?.text
    ).toContain("より高い");
  });

  test("100%は「作品として成立していない」（目安の言葉のまま）", () => {
    const advice = adviceOf(series([100, 50, 10, 0]));
    expect(
      advice.items.find((item) => item.topic === "dropout")?.text
    ).toContain("作品として成立していない");
  });

  test("中堅の目安は50話時点の値。基準が50話を過ぎていれば、第50話時点の値を添える", () => {
    const pvs = Array.from({ length: 60 }, (_, index) => 1000 - index * 12);
    // 第50話 412 → 1 − 412 ÷ 1000 = 58.8%
    const advice = adviceOf(series(pvs));
    const text = advice.items.find((item) => item.topic === "dropout")?.text;
    expect(text).toContain("50話時点");
    expect(text).toContain("第50話時点では 58.8%");
  });

  test("基準が50話より前なら、まだそこまで来ていないと言う", () => {
    const text = adviceOf(series([100, 60, 40])).items.find(
      (item) => item.topic === "dropout"
    )?.text;
    expect(text).toContain("まだ50話まで来ていません");
  });
});

describe("話ごとの減り方（急に読者が減っている話）", () => {
  test("前の話が飛び抜けて多い（宣伝の跳ね）ときは、跳ねではなく、それまでの最少と比べる", () => {
    // 第4話だけ跳ねている。第5話は跳ねの前（第3話 80）から見れば −12.5%
    const advice = adviceOf(series([100, 90, 80, 300, 70, 69, 30]));
    const decline = advice.items.find((item) => item.topic === "decline");
    const episodes = decline?.drops.map((drop) => drop.episode);
    // いちばん大きいのは第7話（69 → 30）
    expect(episodes?.[0]).toBe(7);
    const fifth = decline?.drops.find((drop) => drop.episode === 5);
    expect(fifth?.fromEpisode).toBe(3);
    expect(fifth?.percent).toBe("12.5%");
  });

  test("指すのは3話まで・大きい順", () => {
    const advice = adviceOf(series([100, 95, 80, 70, 60, 30, 29, 10]));
    const drops =
      advice.items.find((item) => item.topic === "decline")?.drops ?? [];
    expect(drops).toHaveLength(3);
    expect(drops.map((drop) => drop.episode)).toEqual([8, 6, 3]);
  });

  test("基準の話より新しい話（まだ読まれ切っていない）は見ない", () => {
    const records = [
      ...series([100, 90, 80, 40]),
      // 第5話は昨日の更新で、PVが小さいのは当たり前
      episode(5, 1, {
        updatedAt: new Date(Date.parse(readAt) - 24 * 3600 * 1000).toISOString(),
      }),
    ];
    const drops =
      adviceOf(records).items.find((item) => item.topic === "decline")?.drops ??
      [];
    expect(drops.map((drop) => drop.episode)).not.toContain(5);
  });

  test("選択肢は再推敲・再校正・話の切れ目の調整。書き直しは出さない", () => {
    const decline = adviceOf(series([100, 90, 60, 58, 49])).items.find(
      (item) => item.topic === "decline"
    );
    const joined = (decline?.suggestions ?? []).join("\n");
    expect(joined).toContain("推敲");
    expect(joined).toContain("校正");
    expect(joined).toContain("話の切れ目");
    expect(joined).not.toContain("書き直");
    expect(decline?.sources).toContain(READER_ADVICE_SOURCES.article6);
    expect(decline?.sources).toContain(READER_ADVICE_SOURCES.article3);
  });
});

describe("序盤（1話→2話で8割、序盤全体で7割）", () => {
  test("1話→2話で8割ちょうどは、基礎から見直して書き直す（強い助言）", () => {
    const advice = adviceOf(series([100, 20, 18, 17]));
    const first = advice.items.find((item) => item.topic === "openingFirst");
    expect(first?.text).toContain("80.0%");
    expect(first?.suggestions.join("")).toContain("書き直");
    // 流入の少なさとは別の問題だと言う
    expect(first?.text).toContain("流入");
    // 第2話で7割を超えているが、同じことを2度言わない
    expect(topics(advice)).not.toContain("openingWhole");
  });

  test("1話→2話が8割に届かなければ、強い助言は出さない（誤検出を見る）", () => {
    const advice = adviceOf(series([100, 21, 20, 19]));
    expect(topics(advice)).not.toContain("openingFirst");
    const text = allText(advice);
    expect(text).not.toContain("書き直");
    // 第2話で7割を超えているので、序盤全体の目安には当たる
    const whole = advice.items.find((item) => item.topic === "openingWhole");
    expect(whole?.text).toContain("第2話までに");
  });

  test("序盤全体：7割を初めて超えた話を言い、序盤が何話までかは決めつけない", () => {
    const advice = adviceOf(series([100, 80, 50, 31, 30, 20]));
    const whole = advice.items.find((item) => item.topic === "openingWhole");
    // 第4話は 69.0%、第5話で 70.0%
    expect(whole?.text).toContain("第5話までに");
    expect(whole?.text).toContain("作者が判断");
    expect(whole?.text).toContain("流入");
    expect(whole?.suggestions.join("")).not.toContain("書き直");
  });

  test("7割まで離れていない作品には、序盤の助言を出さない（誤検出を見る）", () => {
    const advice = adviceOf(series([100, 80, 70, 60, 50]));
    expect(topics(advice)).not.toContain("openingFirst");
    expect(topics(advice)).not.toContain("openingWhole");
  });
});

describe("評価率（3割を超えれば）", () => {
  test("3割を超えたら「伸びている」とだけ言う", () => {
    const advice = adviceOf(
      series([100, 80, 70, 60, 50], { bookmarks: 1, reviews: 31 })
    );
    const rating = advice.items.find((item) => item.topic === "rating");
    expect(rating?.text).toContain("伸びている作品です");
    expect(rating?.suggestions).toEqual([]);
    expect(rating?.sources).toEqual([READER_ADVICE_SOURCES.article1]);
  });

  test("3割ちょうど・下回るときは、対策を出さない（記事に無い）", () => {
    for (const reviews of [30, 3]) {
      const advice = adviceOf(
        series([100, 80, 70, 60, 50], { bookmarks: 1, reviews })
      );
      expect(topics(advice)).not.toContain("rating");
      const note = advice.withheld.find((entry) => entry.topic === "rating");
      expect(note?.text).toContain("対策は記事に無い");
    }
  });
});

describe("ブックマーク率は、目安も助言も出さない", () => {
  test("どんな値でも助言の項目にならない", () => {
    for (const bookmarks of [0, 5, 50, 99]) {
      const advice = adviceOf(
        series([100, 80, 70, 60, 50], { bookmarks, reviews: 1 })
      );
      expect(
        advice.items.some((item) => item.text.includes("ブックマーク"))
      ).toBe(false);
      const note = advice.withheld.find((entry) => entry.topic === "bookmark");
      expect(note?.text).toContain("目安が無い");
      // 数字の目安（◯%）を作っていない
      expect(note?.text).not.toMatch(/\d+(\.\d+)?%/);
    }
  });
});

describe("材料が欠けたら、助言を出さずに理由を言う", () => {
  test("更新日が無く基準の話が決まらない：離脱率まわりは出さない", () => {
    const records = [
      work({ bookmarks: 1, reviews: 40 }),
      episode(1, 100),
      episode(2, 10),
      episode(3, 5),
    ];
    const advice = adviceOf(records);
    expect(topics(advice)).not.toContain("dropout");
    expect(topics(advice)).not.toContain("openingFirst");
    expect(topics(advice)).not.toContain("decline");
    const note = advice.withheld.find((entry) => entry.topic === "dropout");
    expect(note?.text).toContain("更新日の分かる話がありません");
    // 評価率は更新日が無くても出せる（率の側と同じ）
    expect(topics(advice)).toContain("rating");
  });

  test("評価の数が無ければ、評価率の助言は出さずに理由を言う", () => {
    const advice = adviceOf(
      series([100, 80, 70, 60, 50], { bookmarks: 1 })
    );
    expect(topics(advice)).not.toContain("rating");
    expect(
      advice.withheld.find((entry) => entry.topic === "rating")?.text
    ).toContain("がありません");
  });

  test("基準の話が第1話なら、離れ方は見られないと言う（0%を書籍化レベルと読まない）", () => {
    const records = [
      work({ bookmarks: 1, reviews: 1 }),
      episode(1, 100, { updatedAt: settled }),
      episode(2, 5, {
        updatedAt: new Date(Date.parse(readAt) - 3600 * 1000).toISOString(),
      }),
    ];
    const advice = adviceOf(records);
    expect(topics(advice)).not.toContain("dropout");
    expect(allText(advice)).not.toContain("書籍化");
    expect(
      advice.withheld.find((entry) => entry.topic === "dropout")?.text
    ).toContain("第1話");
  });
});

describe("出どころと、使わない事柄", () => {
  const advice = adviceOf(
    series([100, 20, 18, 17, 16, 3], { bookmarks: 30, reviews: 40 })
  );

  test("どの助言にも出どころが付く", () => {
    expect(advice.items.length).toBeGreaterThanOrEqual(4);
    for (const item of advice.items) {
      expect(item.sources.length, item.topic).toBeGreaterThan(0);
    }
    for (const caution of advice.cautions) {
      expect(caution.sources.length).toBeGreaterThan(0);
    }
  });

  test("出どころは記事の題と日付を持ち、開けるURLである", () => {
    for (const source of Object.values(READER_ADVICE_SOURCES)) {
      expect(source.label).toMatch(/\d{4}-\d{2}-\d{2}/);
      expect(source.url).toMatch(/^https:\/\//);
    }
    expect(READER_ADVICE_SOURCES.article1.label).toContain(
      "物言わぬ読者の可視化手法"
    );
  });

  test("【古い可能性】の事柄（更新の時刻・トップページ・完結欄・ランキングの仕様）を言わない", () => {
    const text = allText(advice);
    for (const word of [
      "更新時間",
      "更新時刻",
      "時台",
      "トップページ",
      "完結欄",
      "新規流入",
      "10ポイント",
      "PV500",
    ]) {
      expect(text, word).not.toContain(word);
    }
  });

  test("数字の読み方の注意（普遍のもの4つ）がいつも付く", () => {
    const text = advice.cautions.map((note) => note.text).join("\n");
    expect(advice.cautions).toHaveLength(4);
    expect(text).toContain("話数が少ない");
    expect(text).toContain("目安");
    expect(text).toContain("直接リンク");
    expect(text).toContain("長編");
  });
});

describe("サイトの記録へ載る", () => {
  test("話ごとの記録があれば助言が付き、無ければ付かない", () => {
    let ledger = emptyPostingLedger();
    for (const entry of series([100, 90, 60, 58, 49])) {
      ledger = withReaderStats(ledger, entry);
    }
    const record = buildPostingSiteRecords(ledger).find(
      (entry) => entry.site === "kakuyomu"
    );
    expect(record?.readerAdvice?.items.map((item) => item.topic)).toContain(
      "decline"
    );

    const workOnly = withReaderStats(
      emptyPostingLedger(),
      work({ pv: 10, bookmarks: 1 })
    );
    expect(
      buildPostingSiteRecords(workOnly).find((entry) => entry.site === "kakuyomu")
        ?.readerAdvice
    ).toBeNull();
  });
});

/**
 * 画面の組み立て（WebViewのスクリプト）を、そのまま呼べる形にして確かめる。
 * 手は readerRates.test.ts と同じ（中括弧の対応で切り出す）。
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

describe("画面：助言", () => {
  const render = () =>
    new Function(
      [
        extractFunction(panelScript, "escapeHtml"),
        extractFunction(panelScript, "formatCount"),
        extractFunction(panelScript, "readerAdviceSources"),
        extractFunction(panelScript, "renderReaderAdvice"),
        "return renderReaderAdvice;",
      ].join("\n")
    )() as (advice: ReaderAdvice | null) => string;

  test("助言・指した話・選択肢・出どころ（開けるリンク）・注意を並べる", () => {
    const html = render()(adviceOf(series([100, 90, 60, 58, 49])));
    expect(html).toContain("助言");
    expect(html).toContain("第3話");
    expect(html).toContain("推敲");
    expect(html).toContain(
      'data-url="' + READER_ADVICE_SOURCES.article1.url + '"'
    );
    expect(html).toContain("数字の読み方の注意");
    // ブックマーク率は助言にしない理由だけが出る
    expect(html).toContain("ブックマーク率");
  });

  test("助言が無ければ何も出さない", () => {
    expect(render()(null)).toBe("");
  });
});
