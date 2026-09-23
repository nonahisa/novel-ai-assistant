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
    width: number;
    labelWidth: number;
  }) => { x: number; y: number; anchor: "start" | "end" };

  const base = { padLeft: 56, width: 1000 };

  test("目標がいちばん上（=縦軸の上の数字と同じ高さ）なら、右端へ寄せる", () => {
    // 作者の実機：目標10字で、どの日も10字未満 → 目標の線がいちばん上
    const spot = place({ ...base, goalY: 12, occupiedYs: [20, 192], labelWidth: 38 });
    expect(spot.anchor).toBe("end");
    expect(spot.x).toBeGreaterThan(base.width - 20);
    // 線の上に載せる（線の下に置くと棒の頭と重なりやすい）
    expect(spot.y).toBeLessThan(12);
  });

  test("0の線のすぐそばでも、右端へ寄せる", () => {
    const spot = place({ ...base, goalY: 188, occupiedYs: [20, 195], labelWidth: 38 });
    expect(spot.anchor).toBe("end");
  });

  test("離れていれば、今までどおり左の縦軸の位置に置く", () => {
    const spot = place({ ...base, goalY: 100, occupiedYs: [20, 192], labelWidth: 38 });
    expect(spot).toEqual({ x: 4, y: 103, anchor: "start" });
  });

  test("札が左の余白に収まらない長さなら、右端へ寄せる（棒に被せない）", () => {
    // 「目標 10,000」は余白（56）より長い
    const spot = place({ ...base, goalY: 100, occupiedYs: [20, 192], labelWidth: 62 });
    expect(spot.anchor).toBe("end");
  });

  test("グラフは札の置き場所をこの関数で決め、棒のあとに描く（棒に隠れない）", () => {
    const chart = functionSource("renderChart");
    expect(chart).toContain("goalLabelPlacement(");
    const goalLabel = chart.indexOf("目標 ' + formatCount(goal)");
    expect(goalLabel).toBeGreaterThan(0);
    const bars = chart.indexOf("buckets.forEach(");
    expect(goalLabel).toBeGreaterThan(bars);
  });
});
