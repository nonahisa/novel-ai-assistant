import { describe, expect, test } from "vitest";
import {
  buildTuningStatsMarkdown,
  type TuningStatsEntry,
} from "../../../src/core/tuningStats";
import { parseModelTuning, type ModelTuning } from "../../../src/core/modelTuning";

/**
 * **書ける長さにも字数を添える**（作者の依頼、2026-09-13
 * 「こちら、書ける長さの文字数は出せないでしょうか？」）。
 *
 * 読める長さは字、書ける長さはトークンで出していた。単位が揃っていないと、
 * 作者は頭の中で換算しながら読むことになる。**作者が数えるのは字である。**
 *
 * ただし**添えるのは、そのモデルの換算を実測しているときだけ。** かつての
 * 当て推量（0.7字/トークン）で割ると実測の半分以下が出る。
 */

function entry(model: string, tuning: ModelTuning): TuningStatsEntry {
  return { providerLabel: "Ollama", model, tuning };
}

function rowOf(markdown: string, model: string): string {
  const line = markdown.split("\n").find((t) => t.includes(`| ${model} |`));
  if (!line) throw new Error(`${model} の行が無い`);
  return line;
}

describe("書ける長さの字数", () => {
  test("**実測の換算があれば、字数を添える**", () => {
    const markdown = buildTuningStatsMarkdown([
      entry("gemma4:26b", {
        measuredOutputTokens: 5235,
        charsPerToken: 1.511,
      }),
    ]);
    // 5,235 × 1.511 ≒ 7,910
    expect(rowOf(markdown, "gemma4:26b")).toContain("5,235（約7,910字）");
  });

  test("**実測が無ければ、字数を出さない**（当て推量で埋めない）", () => {
    const markdown = buildTuningStatsMarkdown([
      entry("qwen3:8b", { measuredOutputTokens: 2865 }),
    ]);
    const row = rowOf(markdown, "qwen3:8b");
    expect(row).toContain("2,865");
    expect(row).not.toContain("字）");
  });

  test("時間切れの断りと、字数が両方出る", () => {
    const markdown = buildTuningStatsMarkdown([
      entry("gemma4:12b", {
        measuredOutputTokens: 4290,
        outputMeasureTimedOut: true,
        charsPerToken: 1.592,
      }),
    ]);
    // 4,290 × 1.592 ≒ 6,830
    expect(rowOf(markdown, "gemma4:12b")).toContain(
      "4,290（約6,830字。時間切れあり）"
    );
  });

  test("時間切れだけのときは、これまでどおり", () => {
    const markdown = buildTuningStatsMarkdown([
      entry("gemma4:12b", {
        measuredOutputTokens: 4290,
        outputMeasureTimedOut: true,
      }),
    ]);
    expect(rowOf(markdown, "gemma4:12b")).toContain("4,290（時間切れあり）");
  });

  test("測っていない行には、何も足さない", () => {
    const markdown = buildTuningStatsMarkdown([
      entry("qwen3:8b", { charsPerToken: 1.359 }),
    ]);
    expect(rowOf(markdown, "qwen3:8b")).not.toContain("字）");
  });

  test("壊れた換算では、字数を出さない", () => {
    for (const ratio of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const markdown = buildTuningStatsMarkdown([
        entry("x", { measuredOutputTokens: 1000, charsPerToken: ratio }),
      ]);
      expect(rowOf(markdown, "x"), String(ratio)).not.toContain("字）");
    }
  });
});

/**
 * **台帳から読めていること。**
 *
 * 0.58.0 で「これ以上は試していません」の印を足したとき、`ModelTuning` の
 * 型と保存の側だけを直し、**`parseModelTuning` に読む側を足し忘れた。**
 * 表のテストは組み立てたレコードを直に渡していたので通ってしまい、
 * **実際には一度も画面に出ていなかった**（CLAUDE.mdの「繰り返し起きた失敗」
 * 1番、単体テストが通っても実データで動かない）。
 *
 * 同じ取りこぼしを繰り返さないために、**設定から読んだ値が表まで届くこと**
 * をここで見る。
 */
describe("台帳から表まで、値が届く", () => {
  const raw = {
    "ollama/gemma4:26b": {
      measuredChars: 160834,
      measuredOutputTokens: 5235,
      charsPerToken: 1.511,
      charsPerTokenSamples: 12,
      contextHitCeiling: true,
      contextMeasuredBy: "words",
      outputMeasureTimedOut: true,
    },
  };

  test("**書ける長さの字数に要る換算が、読めている**", () => {
    const tuning = parseModelTuning(raw).get("ollama/gemma4:26b");
    expect(tuning?.charsPerToken).toBe(1.511);
  });

  test("天井の印が読めている（0.58.0で読み落としていた欄）", () => {
    const tuning = parseModelTuning(raw).get("ollama/gemma4:26b");
    expect(tuning?.contextHitCeiling).toBe(true);
  });

  test("どう測ったかの印が読めている", () => {
    const tuning = parseModelTuning(raw).get("ollama/gemma4:26b");
    expect(tuning?.contextMeasuredBy).toBe("words");
  });

  test("**設定から読んだものを表にすると、断りが全部出る**", () => {
    const tuning = parseModelTuning(raw).get("ollama/gemma4:26b");
    if (!tuning) throw new Error("読めていない");
    const markdown = buildTuningStatsMarkdown([entry("gemma4:26b", tuning)]);
    const row = rowOf(markdown, "gemma4:26b");
    expect(row).toContain("これ以上は試していません");
    expect(row).toContain("合言葉で測定");
    expect(row).toContain("約7,910字");
    expect(row).toContain("時間切れあり");
  });
});
