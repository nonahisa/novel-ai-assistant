import { describe, expect, test } from "vitest";
import {
  buildTuningStatsMarkdown,
  type TuningStatsEntry,
} from "../../src/core/tuningStats";
import type { ModelTuning } from "../../src/core/modelTuning";

/**
 * **実測と「そこまでは確かめた」を、一覧で見分けられるようにする**
 * （作者の指摘、2026-09-13）。
 *
 * 読める長さの測定には天井がある（申告の文脈長か、既定の上限）。そこまで
 * 全部通ってしまったときの値は、**そのモデルの限界ではなく検査の限界**で、
 * 「ここまでは確かめた」という下限値でしかない。
 *
 * 実機の一覧（2026-09-13）では、クラウドの31B（さくらのAI）と手元の12B
 * （Ollama）が**1字まで同じ 183,239字**だった。素性のまるで違う2つが
 * 一致するのは、どちらも128Kの天井で止まった印である。同じ行の
 * 「文脈の実効長 261,770トークン」と並べると、半分以下しか測っていない。
 *
 * **混ぜたままだと、小さいモデルのほうが多く読めるように見える。**
 * 12Bが天井・26Bが実測だったので、表の上では12Bが優秀に見えていた。
 */

function entry(
  providerLabel: string,
  model: string,
  tuning: ModelTuning
): TuningStatsEntry {
  return { providerLabel, model, tuning };
}

/** 表の本文から、そのモデルの行だけを取る */
function rowOf(markdown: string, model: string): string {
  const line = markdown
    .split("\n")
    .find((text) => text.includes(`| ${model} |`));
  if (!line) throw new Error(`${model} の行が無い`);
  return line;
}

describe("読める長さの列", () => {
  test("**天井まで通った行には、これ以上試していないと書く**", () => {
    const markdown = buildTuningStatsMarkdown([
      entry("さくらのAI", "preview/gemma-4-31B-it", {
        contextWindow: 261770,
        measuredChars: 183239,
        contextHitCeiling: true,
      }),
    ]);
    expect(rowOf(markdown, "preview/gemma-4-31B-it")).toContain(
      "183,239（これ以上は試していません）"
    );
  });

  test("天井に当たっていない行は、数字だけ", () => {
    const markdown = buildTuningStatsMarkdown([
      entry("さくらのAI", "gpt-oss-120b", {
        contextWindow: 197756,
        measuredChars: 138429,
      }),
    ]);
    const row = rowOf(markdown, "gpt-oss-120b");
    expect(row).toContain("138,429");
    expect(row).not.toContain("これ以上は試していません");
  });

  /**
   * **印が付く前に測った台帳は、これまでどおり。**
   *
   * `contextHitCeiling` を持たない台帳に「実測である」とも
   * 「天井である」とも書かない。分からないことを断定しない。
   */
  test("印を持たない古い台帳は、これまでどおり数字だけ", () => {
    const markdown = buildTuningStatsMarkdown([
      entry("Ollama", "gemma4:26b", { measuredChars: 160834 }),
    ]);
    const row = rowOf(markdown, "gemma4:26b");
    expect(row).toContain("160,834");
    expect(row).not.toContain("これ以上は試していません");
  });

  test("測っていない行には、何も足さない", () => {
    const markdown = buildTuningStatsMarkdown([
      entry("Ollama", "qwen3:8b", { contextHitCeiling: true }),
    ]);
    const row = rowOf(markdown, "qwen3:8b");
    expect(row).not.toContain("これ以上は試していません");
  });

  /**
   * **同じ数字が並んだときに、見分けられること。**
   *
   * これが実機で起きたことそのものである。印が無ければ、読む人には
   * 「クラウドの31Bと手元の12Bが同じだけ読める」としか見えない。
   */
  test("同じ字数でも、実測と天井が別に読める", () => {
    const markdown = buildTuningStatsMarkdown([
      entry("さくらのAI", "preview/gemma-4-31B-it", {
        measuredChars: 183239,
        contextHitCeiling: true,
      }),
      entry("Ollama", "gemma4:12b", {
        measuredChars: 183239,
        contextHitCeiling: true,
      }),
      entry("Ollama", "gemma4:26b", { measuredChars: 160834 }),
    ]);
    expect(rowOf(markdown, "preview/gemma-4-31B-it")).toContain(
      "これ以上は試していません"
    );
    expect(rowOf(markdown, "gemma4:12b")).toContain("これ以上は試していません");
    expect(rowOf(markdown, "gemma4:26b")).not.toContain(
      "これ以上は試していません"
    );
  });
});

/**
 * **書ける長さの「時間切れあり」と、書き方を揃える。**
 *
 * どちらも「その数字は当てにしすぎないでほしい」という同じ種類の断りである。
 * 片方が括弧書き、片方が記号、では読む側が2通り覚えることになる。
 */
describe("断りの書き方を揃える", () => {
  test("書ける長さの時間切れも、括弧書きのまま", () => {
    const markdown = buildTuningStatsMarkdown([
      entry("Ollama", "gemma4:12b", {
        measuredOutputTokens: 4290,
        outputMeasureTimedOut: true,
      }),
    ]);
    expect(rowOf(markdown, "gemma4:12b")).toContain("4,290（時間切れあり）");
  });

  test("両方の断りが、1行に並んでも読める", () => {
    const markdown = buildTuningStatsMarkdown([
      entry("Ollama", "gemma4:12b", {
        measuredChars: 183239,
        contextHitCeiling: true,
        measuredOutputTokens: 4290,
        outputMeasureTimedOut: true,
      }),
    ]);
    const row = rowOf(markdown, "gemma4:12b");
    expect(row).toContain("183,239（これ以上は試していません）");
    expect(row).toContain("4,290（時間切れあり）");
  });
});
