import { describe, expect, test } from "vitest";
import * as fs from "node:fs";
import * as nodePath from "node:path";
import {
  PLOT_MAX_CHARS,
  describePlotTrim,
  plotMaxChars,
  trimPlotForDeviation,
} from "../../src/features/checkDeviations";
import {
  buildDeviationCheckPrompt,
  DEVIATION_TYPES,
  deviationBudget,
} from "../../src/prompts/deviationCheck";

/**
 * 逸脱検知へ渡すプロットの上限（設計書6.77の第2段、6.27.4）。
 *
 * **プロットは話の数だけ繰り返し送られる。** 19話の作品なら19回、
 * 同じプロット全文が入力に積まれる。ここだけ上限が無かったので、
 * プロットの長い作品では送る量が話数ぶんに膨らんでいた。
 *
 * 世界観（`worldviewSelect.ts`）と同じ「モデル比＋頭打ち」で切る。
 * **大多数の作品では1バイトも変わらない**ことを、下のゴールデンが固定する。
 */

/** 行の区切りを含む、それらしいプロット。切り方の検査に使う */
function plotOf(lines: number): string {
  return Array.from(
    { length: lines },
    (_, index) => `${index + 1}行目：主人公が動く。ここは筋の骨格である。`
  ).join("\n");
}

describe("プロットの上限（モデル比＋頭打ち）", () => {
  test("コンテキスト長が分からないときは頭打ちを返す", () => {
    // **0を返さない。** 分からないことを「使ってはいけない」と読み替えると、
    // モデル情報を取れないプロバイダでプロットが丸ごと消える
    expect(plotMaxChars(undefined)).toBe(PLOT_MAX_CHARS);
    expect(plotMaxChars(0)).toBe(PLOT_MAX_CHARS);
  });

  test("131,072のモデルでは22,937字（25% × 0.7字/トークン）", () => {
    expect(plotMaxChars(131072)).toBe(22937);
  });

  test("8,192のモデルでは1,433字まで縮む", () => {
    // 固定字数だけだと、小さいモデルでは資料だけで上限を使い切る
    expect(plotMaxChars(8192)).toBe(1433);
  });

  test("十分に大きなモデルでも頭打ちで止まる", () => {
    expect(plotMaxChars(1_000_000)).toBe(PLOT_MAX_CHARS);
  });
});

describe("上限内のプロットは1バイトも変えない", () => {
  test("上限ちょうどまでは、そのまま返す", () => {
    const max = plotMaxChars(131072);
    const plot = "あ".repeat(max);
    const trimmed = trimPlotForDeviation(plot, max);

    expect(trimmed.text).toBe(plot);
    expect(trimmed.trimmed).toBe(false);
  });

  test("8k級のモデルでも、上限ちょうどまでは、そのまま返す", () => {
    const max = plotMaxChars(8192);
    const plot = "あ".repeat(max);

    expect(trimPlotForDeviation(plot, max).text).toBe(plot);
    expect(trimPlotForDeviation(plot, max).trimmed).toBe(false);
  });

  test("組み上がるプロンプトが、上限を入れる前と同一である（ゴールデン）", () => {
    const plot = plotOf(20);
    const body = "1: 本文の一行目\n2: 本文の二行目";
    const build = (plotText: string): string =>
      buildDeviationCheckPrompt({
        chapterLabel: "第1話",
        plot: plotText,
        chapterTextWithLineNumbers: body,
        surroundingSynopses: "",
        types: DEVIATION_TYPES,
        maxIssues: deviationBudget(body.length),
      });

    // 上限内なら、切る前（プロット全文）と1文字も違わない
    expect(build(trimPlotForDeviation(plot, plotMaxChars(131072)).text)).toBe(
      build(plot)
    );
  });
});

describe("上限を超えたら、先頭から行境界で切る", () => {
  const max = plotMaxChars(8192);

  test("先頭からの切り出しである（末尾を捨てる）", () => {
    // プロットは冒頭に設定・あらすじの骨子が来る書式（`plotTemplate`）で、
    // 末尾ほど細部になる。だから捨てるのは末尾のほう
    const plot = plotOf(200);
    const trimmed = trimPlotForDeviation(plot, max);

    expect(trimmed.trimmed).toBe(true);
    expect(plot.startsWith(trimmed.text)).toBe(true);
    expect(trimmed.text.length).toBeLessThanOrEqual(max);
    expect(trimmed.text.length).toBeGreaterThan(0);
  });

  test("行の途中では切らない（最後の改行まで戻す）", () => {
    const plot = plotOf(200);
    const trimmed = trimPlotForDeviation(plot, max);

    // 切った先が、元のプロットの行の切れ目に当たっている
    expect(plot[trimmed.text.length]).toBe("\n");
    // 切れ端の一行が残っていない
    for (const line of trimmed.text.split("\n")) {
      expect(line.endsWith("である。")).toBe(true);
    }
  });

  test("改行が一つも無いプロットは、上限で素直に切る", () => {
    // 行境界へ戻せないのに空を返すと、照らし合わせる相手が消える
    const plot = "あ".repeat(max * 2);
    const trimmed = trimPlotForDeviation(plot, max);

    expect(trimmed.text).toBe("あ".repeat(max));
    expect(trimmed.trimmed).toBe(true);
  });

  test("上限を1字超えたところから切り始める（境界）", () => {
    const under = "あ".repeat(max);
    expect(trimPlotForDeviation(under, max).trimmed).toBe(false);
    expect(trimPlotForDeviation(`${under}い`, max).trimmed).toBe(true);
  });
});

describe("切ったことを黙らない", () => {
  test("案内は、使った字数と全体の字数の両方を言う", () => {
    const note = describePlotTrim(1433, 52000);

    expect(note).toContain("1,433");
    expect(note).toContain("52,000");
    expect(note).toContain("先頭");
  });
});

/**
 * 案内を出すのは**1回だけ**であること。
 *
 * 話ごとに出すと、19話の作品では19回同じ通知が出る。ソースを見るのは
 * `outputTokensWiring.test.ts` と同じ理由——一括機能を本物どおりに
 * 走らせる仕掛けが、確かめたい1点に対して大きすぎるからである。
 */
describe("案内は一度だけ（配線）", () => {
  const source = fs.readFileSync(
    nodePath.join(__dirname, "..", "..", "src", "features", "checkDeviations.ts"),
    "utf8"
  );

  test("プロットを切るのは、話ごとの送信の外で一度だけ", () => {
    const calls = source.match(/trimPlotForDeviation\(/g) ?? [];
    // 宣言（`export function`）を除いた呼び出しが1つだけ
    expect(calls.length).toBe(2);
  });

  test("案内は結果に載せて、完了報告へ渡す", () => {
    expect(source).toContain("plotTrimmedNote");

    const extension = fs.readFileSync(
      nodePath.join(__dirname, "..", "..", "src", "extension.ts"),
      "utf8"
    );
    expect(extension).toContain("plotTrimmedNote");
  });

  test("送るプロットの字数が usage.md の内訳に載る", () => {
    // 全文ではなく、**実際に送った字数**が載っていないと、
    // 上限が効いたかどうかを記録から確かめられない
    expect(source).toContain("プロット: plotText.length");
  });
});
