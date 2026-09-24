import { describe, expect, test } from "vitest";
import { buildWritingStatsPanelHtml } from "../../../src/views/writingStatsPanelHtml";

/**
 * 執筆量パネルの**棒と目標の札**（ノートPCの実機確認、0.82.6、2026-09-23〜24）。
 *
 * (a) 今日の欄の進み具合の棒が、目標未達（今日0字・あと10字）なのに
 *     満杯の青に見えた。割合の計算（writingStats.ts）は 0% を返していた。
 *     **原因は描き方**——画面の CSP（style-src が nonce だけ）が HTML に
 *     書いた style="width:0%" を捨て、中の棒が幅いっぱいに描かれていた。
 *     割合に関係なく、いつも満杯だった（話ごとの一覧の小さな棒は逆に、
 *     幅が付かずに何も出ていなかった）。
 * (b) 日ごとのグラフで「目標 10」の札と、縦軸のいちばん上の「10字」が
 *     同じ高さに重なって読めなかった。
 *
 * WebView のスクリプトは文字列として埋め込まれているので、関数を
 * 切り出して動かす（writingStatsCelebration.test.ts と同じ手）。
 */

const html = buildWritingStatsPanelHtml("NONCE123", "vscode-resource:");
const script = (() => {
  const found = html.match(/<script nonce="NONCE123">([\s\S]*?)<\/script>/);
  if (!found) throw new Error("スクリプトが見つかりません");
  return found[1];
})();

/** スクリプトの最上位にある関数を1つ切り出す（字下げの無い `}` で終わる） */
function functionSource(name: string): string {
  const start = script.indexOf(`\nfunction ${name}(`);
  if (start < 0) throw new Error(`関数 ${name} が見つかりません`);
  const end = script.indexOf("\n}\n", start);
  return script.slice(start, end + 3);
}

interface Progress {
  written: number;
  goal: number;
  remaining: number;
  rate: number;
  achieved: boolean;
}

describe("(a) 進み具合の棒は、割合どおりの長さで描く", () => {
  test("画面の CSP はインラインの style を許していない（だから style 属性で幅を付けない）", () => {
    const csp = html.match(/Content-Security-Policy"\s+content="([^"]*)"/);
    expect(csp?.[1]).toContain("style-src");
    expect(csp?.[1]).not.toContain("unsafe-inline");
  });

  test("画面のどこにも style 属性を書いていない（書いても CSP に捨てられる）", () => {
    expect(html).not.toContain('style="');
  });

  const card = new Function(
    [
      functionSource("escapeHtml"),
      functionSource("meterSvg"),
      functionSource("card"),
      "return card;",
    ].join("\n")
  )() as (
    label: string,
    value: string,
    sub: string,
    progress: Progress | null
  ) => string;

  /** 棒の中身（塗った長さ。0〜100）を読む */
  function filled(markup: string): number | null {
    const found = markup.match(/<rect class="meter-fill[^"]*"[^>]*\swidth="([0-9.]+)"/);
    return found ? Number(found[1]) : null;
  }

  test("今日0字・目標10字なら、棒は空（作者の実機で満杯に見えた場面）", () => {
    const markup = card("今日", "0字", "あと 10字", {
      written: 0,
      goal: 10,
      remaining: 10,
      rate: 0,
      achieved: false,
    });
    expect(filled(markup)).toBe(0);
    expect(markup).not.toContain("achieved");
  });

  test("途中なら途中まで、越えたら満杯で止める", () => {
    const at = (rate: number) =>
      filled(
        card("今日", "", "", {
          written: rate,
          goal: 100,
          remaining: Math.max(0, 100 - rate),
          rate,
          achieved: rate >= 100,
        })
      );
    expect(at(37)).toBe(37);
    expect(at(150)).toBe(100);
    expect(at(-5)).toBe(0);
  });

  test("目標が無ければ棒を出さない", () => {
    const markup = card("今日", "0字", "目標は未設定", {
      written: 0,
      goal: 0,
      remaining: 0,
      rate: 0,
      achieved: false,
    });
    expect(markup).not.toContain("meter");
  });

  test("話ごとの一覧の小さな棒も、同じ部品で描く", () => {
    expect(script).toContain("'<td><div class=\"mini\">' + meterSvg(");
  });
});

describe("(b) 目標の札を、縦軸の数字と重ねない", () => {
  const place = new Function(
    [functionSource("goalLabelPlacement"), "return goalLabelPlacement;"].join("\n")
  )() as (input: {
    goalY: number;
    occupiedYs: number[];
    padLeft: number;
    barsRight: number;
    labelWidth: number;
  }) => { x: number; y: number; anchor: "start" | "end"; extraRight: number };

  const base = { padLeft: 56, barsRight: 1000 };

  test("目標がいちばん上（=縦軸の上の数字と同じ高さ）なら、棒の並びの右へ出す", () => {
    // 作者の実機：目標10字で、どの日も10字未満 → 目標の線がいちばん上
    const spot = place({ ...base, goalY: 12, occupiedYs: [20, 192], labelWidth: 38 });
    expect(spot.anchor).toBe("start");
    // **棒の並びより右**（右端の棒の上に載せると、今日の棒に被って読めない。
    // ノートPCの実機確認、2026-09-25）
    expect(spot.x).toBeGreaterThanOrEqual(base.barsRight);
    // 札のぶん、グラフの幅を足してもらう
    expect(spot.extraRight).toBeGreaterThanOrEqual(38);
  });

  test("0の線のすぐそばでも、棒の並びの右へ出す", () => {
    const spot = place({ ...base, goalY: 188, occupiedYs: [20, 195], labelWidth: 38 });
    expect(spot.x).toBeGreaterThanOrEqual(base.barsRight);
  });

  test("離れていれば、今までどおり左の縦軸の位置に置く", () => {
    const spot = place({ ...base, goalY: 100, occupiedYs: [20, 192], labelWidth: 38 });
    expect(spot).toEqual({ x: 4, y: 103, anchor: "start", extraRight: 0 });
  });

  test("札が左の余白に収まらない長さなら、棒の並びの右へ出す（棒に被せない）", () => {
    // 「目標 10,000」は余白（56）より長い
    const spot = place({ ...base, goalY: 100, occupiedYs: [20, 192], labelWidth: 62 });
    expect(spot.x).toBeGreaterThanOrEqual(base.barsRight);
    expect(spot.extraRight).toBeGreaterThanOrEqual(62);
  });

  test("グラフは札の置き場所をこの関数で決め、棒のあとに描く（棒に隠れない）", () => {
    const chart = functionSource("renderChart");
    expect(chart).toContain("goalLabelPlacement(");
    const goalLabel = chart.indexOf("goal-label");
    expect(goalLabel).toBeGreaterThan(0);
    const bars = chart.indexOf("buckets.forEach(");
    expect(goalLabel).toBeGreaterThan(bars);
  });
});

/**
 * 日ごとのグラフを実際に描いて確かめる（ノートPCの実機確認、2026-09-25）。
 *
 * (c) 「目標 10」の札の「目標」が、右端（今日）の棒に被って読めなかった。
 *     右端へ寄せた札は、グラフの右端から左へ伸びるので、最後の棒の上に載る。
 * (d) グラフは左端（古い日）から見え、今日の棒は横に送らないと見えなかった。
 */
describe("(c)(d) 日ごとのグラフを描く", () => {
  interface Wrap {
    scrollLeft: number;
    scrollWidth: number;
    clientWidth: number;
  }

  function draw(
    values: number[],
    goal: number
  ): { markup: string; width: number; wrap: Wrap } {
    const attributes: Record<string, string> = {};
    const wrap: Wrap = { scrollLeft: 0, scrollWidth: 2000, clientWidth: 400 };
    const svg = {
      innerHTML: "",
      parentElement: wrap,
      setAttribute: (name: string, value: string) => {
        attributes[name] = value;
      },
    };
    const note = { textContent: "" };
    const fakeDocument = {
      getElementById: (id: string) =>
        id === "chart" ? svg : id === "chart-note" ? note : null,
    };
    const buckets = values.map((net, index) => ({
      key: `2026-09-${String(index + 1).padStart(2, "0")}`,
      label: `9/${index + 1}`,
      net,
      activeDays: net > 0 ? 1 : 0,
    }));
    const state = {
      buckets: { daily: buckets },
      goal: { daily: goal },
      currentBucketKey: { daily: buckets[buckets.length - 1].key },
      notice: "",
    };
    const run = new Function(
      "document",
      "state",
      [
        "let granularity = 'daily';",
        "let chartFollowLatest = true;",
        "const GRANULARITY_LABELS = { daily: '日次', weekly: '週次', monthly: '月次', yearly: '年次' };",
        functionSource("escapeHtml"),
        functionSource("formatCount"),
        functionSource("estimateLabelWidth"),
        functionSource("amount"),
        functionSource("goalLabelPlacement"),
        functionSource("pinChartToLatest"),
        functionSource("renderChart"),
        "renderChart();",
      ].join("\n")
    );
    run(fakeDocument, state);
    return { markup: svg.innerHTML, width: Number(attributes.width), wrap };
  }

  const estimate = new Function(
    [functionSource("estimateLabelWidth"), "return estimateLabelWidth;"].join("\n")
  )() as (label: string) => number;

  test("札は、どの棒にも被らず、グラフの幅に収まる（作者の実機：目標10・どの日も10字未満）", () => {
    const { markup, width } = draw([3, 0, 5, 8, 0, 2, 9], 10);
    const label = markup.match(
      /<text class="tick goal-label" x="([0-9.]+)" y="[0-9.-]+" text-anchor="(start|end)">([^<]*)<\/text>/
    );
    expect(label).not.toBeNull();
    const x = Number(label![1]);
    const textWidth = estimate(label![3]);
    const left = label![2] === "start" ? x : x - textWidth;
    const right = left + textWidth;

    const bars = [
      ...markup.matchAll(
        /<rect class="bar[^"]*" x="([0-9.]+)" y="[0-9.-]+" width="([0-9.]+)"/g
      ),
    ];
    expect(bars.length).toBe(7);
    for (const bar of bars) {
      const barLeft = Number(bar[1]);
      const barRight = barLeft + Number(bar[2]);
      // 横に重なる棒が1本でもあれば、札が棒に被っている
      expect(right <= barLeft || left >= barRight).toBe(true);
    }
    expect(right).toBeLessThanOrEqual(width);
  });

  test("最初に見える位置は右端（今日の側）", () => {
    const { wrap } = draw([3, 0, 5, 8, 0, 2, 9], 10);
    expect(wrap.scrollLeft).toBeGreaterThanOrEqual(
      wrap.scrollWidth - wrap.clientWidth
    );
  });

  test("作者が左へ送って見ているあいだは、描き直しで右端へ引き戻さない", () => {
    expect(script).toMatch(/chartFollowLatest\s*=/);
    expect(functionSource("pinChartToLatest")).toContain(
      "if (!chartFollowLatest) return;"
    );
  });

  test("執筆量の見開きへ戻ったときと、日次・週次を切り替えたときも右端から見せる", () => {
    expect(script).toContain("if (tab.dataset.page === 'writing') pinChartToLatest();");
    expect(functionSource("renderGranularity")).toContain("chartFollowLatest = true;");
  });
});
