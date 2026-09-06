import { describe, expect, test } from "vitest";
import {
  TUNING_STATS_TITLE,
  buildTuningStatsMarkdown,
  formatMeasuredAt,
  modelPickDetail,
  outputTokensPerSecond,
  tuningStatsEntries,
  type TuningStatsEntry,
} from "../../src/core/tuningStats";

/**
 * AIチューニングの実測一覧（作者の要望、2026-09-06
 * 「速度が一番早いモデルがわかる統計の一覧が出ると嬉しい」）。
 *
 * 台帳（`core/modelTuning.ts`）はモデルごとに測った値を持っているが、
 * **設定のJSONを開いて読むしかなかった。** どのモデルがいちばん速いかは、
 * 鍵（`プロバイダ/モデル`）を目で追って数字を見比べる作業になる。
 *
 * ここで確かめるのは4つ。
 *
 * 1. **速い順に並ぶこと**——一覧の目的そのもの
 * 2. **測っていない項目を、測った0と取り違えないこと**（「—」で出す）
 * 3. **時間切れ混じりの実測に印が残ること**（設計書6.77の第2段。
 *    あれは上限としては使わない弱い値である）
 * 4. **台帳が空でも、次にすることが分かること**
 */

/** 表の行（見出しと区切りを除く）を、セルの配列にして返す */
function rows(markdown: string): string[][] {
  return markdown
    .split("\n")
    .filter((line) => line.startsWith("|"))
    .slice(2)
    .map((line) =>
      line
        .slice(1, -1)
        .split("|")
        .map((cell) => cell.trim())
    );
}

/** 表の見出し行 */
function header(markdown: string): string[] {
  return markdown
    .split("\n")
    .filter((line) => line.startsWith("|"))[0]
    .slice(1, -1)
    .split("|")
    .map((cell) => cell.trim());
}

function entry(
  providerLabel: string,
  model: string,
  tuning: TuningStatsEntry["tuning"]
): TuningStatsEntry {
  return { providerLabel, model, tuning };
}

describe("実測一覧の組み立て", () => {
  test("台帳が空なら、次にすることを言う", () => {
    const markdown = buildTuningStatsMarkdown([]);

    expect(markdown).toContain(`# ${TUNING_STATS_TITLE}`);
    expect(markdown).toContain(
      "まだ測っていません。「AIチューニング」を実行してください。"
    );
    // 空の表を出さない（見出しだけの表は「壊れている」と読める）
    expect(markdown).not.toContain("| AI |");
  });

  test("速い順に並べ、いちばん速い行に印を付ける", () => {
    const markdown = buildTuningStatsMarkdown([
      entry("Ollama", "gemma4:e4b", { outputTokensPerSecond: 12.3 }),
      entry("さくらのAI", "gpt-oss-120b", { outputTokensPerSecond: 98.7 }),
      entry("LM Studio", "qwen3-8b", { outputTokensPerSecond: 45 }),
    ]);

    const table = rows(markdown);
    expect(table.map((cells) => cells[1])).toEqual([
      "gpt-oss-120b",
      "qwen3-8b",
      "gemma4:e4b",
    ]);
    // 印は最速の1行だけ
    expect(table[0][2]).toContain("◎ 最速");
    expect(table[1][2]).not.toContain("最速");
    expect(table[2][2]).not.toContain("最速");
    // 小数1桁で見せる（整数でも桁を揃える）
    expect(table[1][2]).toContain("45.0");
  });

  test("速度を測っていない行は、末尾へ回して理由を添える", () => {
    const markdown = buildTuningStatsMarkdown([
      entry("Ollama", "測っていない", { contextWindow: 8192 }),
      entry("Ollama", "速い", { outputTokensPerSecond: 30 }),
      entry("Ollama", "遅い", { outputTokensPerSecond: 10 }),
    ]);

    const table = rows(markdown);
    expect(table.map((cells) => cells[1])).toEqual([
      "速い",
      "遅い",
      "測っていない",
    ]);
    // **「0トークン/秒」とは書かない。** 測っていないことと、
    // 測って遅かったことは別である
    expect(table[2][2]).toContain("速度は次に測ったとき");
    expect(table[2][2]).not.toContain("0.0");
  });

  test("測っていない項目は「—」で出す", () => {
    const markdown = buildTuningStatsMarkdown([
      entry("Ollama", "gemma4:e4b", { outputTokensPerSecond: 12.3 }),
    ]);

    const cells = rows(markdown)[0];
    // 出どころ・速度の日時・文脈の実効長・読める長さ・書ける長さ・日時
    expect(cells.slice(3)).toEqual(["—", "—", "—", "—", "—", "—"]);
  });

  test("そろっていれば、単位を見出しに置いて数字だけを並べる", () => {
    const markdown = buildTuningStatsMarkdown([
      entry("Ollama", "gemma4:e4b", {
        outputTokensPerSecond: 12.3,
        speedSource: "call",
        speedMeasuredAt: "2026-09-06T01:00:00.000Z",
        contextWindow: 131072,
        measuredChars: 91000,
        measuredOutputTokens: 3072,
        measuredAt: "2026-09-05T23:30:00.000Z",
      }),
    ]);

    expect(header(markdown)).toEqual([
      "AI",
      "モデル",
      "出力速度（トークン/秒）",
      "速度の出どころ",
      "速度を測った日時",
      "文脈の実効長（トークン）",
      "読める長さ（字）",
      "書ける長さ（トークン）",
      "測った日時",
    ]);
    const cells = rows(markdown)[0];
    expect(cells[0]).toBe("Ollama");
    expect(cells[3]).toBe("普段の呼び出し");
    expect(cells[4]).toBe("2026-09-06 10:00");
    expect(cells[5]).toBe("131,072");
    expect(cells[6]).toBe("91,000");
    expect(cells[7]).toBe("3,072");
    // 日本時間（UTC+9）。23:30Z は翌日の 8:30
    expect(cells[8]).toBe("2026-09-06 08:30");
  });

  /**
   * **速度の出どころを列に出す**（作者の裁定、2026-09-06）。
   *
   * チューニングで測った値と、普段の呼び出しでたまたま採れた値と、
   * 字数から換算した値は、**どれも同じ「トークン/秒」に見える**が
   * 重みが違う。並べるだけだと、推定値が「最速」に立つことがある。
   */
  describe("速度の出どころ", () => {
    test("3つの出どころを、それぞれの言葉で出す", () => {
      const markdown = buildTuningStatsMarkdown([
        entry("Ollama", "測った", {
          outputTokensPerSecond: 30,
          speedSource: "tuning",
        }),
        entry("さくらのAI", "普段", {
          outputTokensPerSecond: 20,
          speedSource: "call",
        }),
        entry("Claude", "推定", {
          outputTokensPerSecond: 10,
          speedSource: "estimated",
        }),
      ]);

      expect(rows(markdown).map((cells) => cells[3])).toEqual([
        "チューニング",
        "普段の呼び出し",
        "普段の呼び出し（推定）",
      ]);
    });

    test("出どころの分からない古い台帳は「—」（当て推量で埋めない）", () => {
      const markdown = buildTuningStatsMarkdown([
        entry("Ollama", "gemma4:e4b", { outputTokensPerSecond: 12.3 }),
      ]);

      expect(rows(markdown)[0][3]).toBe("—");
    });
  });

  test("時間切れ混じりの実測には、その印を残す", () => {
    // 設計書6.77の第2段。時間切れを「書けない」と数えた値は弱い証拠なので、
    // 一覧でもそれと分かるようにする（上限としては使っていない）
    const markdown = buildTuningStatsMarkdown([
      entry("Ollama", "gemma4:e4b", {
        measuredOutputTokens: 3072,
        outputMeasureTimedOut: true,
      }),
    ]);

    expect(rows(markdown)[0][7]).toBe("3,072（時間切れあり）");
  });

  test("冒頭に、速度の読み方を一文だけ置く", () => {
    const markdown = buildTuningStatsMarkdown([
      entry("Ollama", "gemma4:e4b", { outputTokensPerSecond: 12.3 }),
    ]);

    expect(markdown).toContain(
      "速度は出力の実測（トークン/秒）です。普段のAI呼び出しからも記録します。" +
        "同じモデルでも機械の負荷で変わるので目安です。"
    );
  });

  test("縦棒を含む名前でも、表が崩れない", () => {
    // 台帳は作者が手で編集できる。壊れた名前で表全体が読めなくなるより、
    // その1行が読めるほうがよい
    const markdown = buildTuningStatsMarkdown([
      entry("Ollama", "変|な名前", { outputTokensPerSecond: 1 }),
    ]);

    // セルの区切りと化けないよう、逃がしてある（ここは行を割らずに見る
    // ——割る側の助けが、逃がした縦棒でも割ってしまうため）
    expect(markdown).toContain("| 変\\|な名前 |");
  });
});

describe("台帳の鍵から一覧の行を作る", () => {
  test("プロバイダIDを表示名へ直す", () => {
    const entries = tuningStatsEntries(
      new Map([["ollama/gemma4:e4b", { outputTokensPerSecond: 12.3 }]]),
      (id) => (id === "ollama" ? "Ollama" : id)
    );

    expect(entries).toEqual([
      {
        providerLabel: "Ollama",
        model: "gemma4:e4b",
        tuning: { outputTokensPerSecond: 12.3 },
      },
    ]);
  });

  test("モデル名にスラッシュが入っていても割らない", () => {
    // Ollamaは `hf.co/作者/モデル:q4` のような名前を扱う。
    // 最初の1つでだけ割らないと、モデル名が切れて別物になる
    const entries = tuningStatsEntries(
      new Map([["ollama/hf.co/user/model:q4", {}]]),
      (id) => id
    );

    expect(entries[0].model).toBe("hf.co/user/model:q4");
  });

  test("プロバイダの分からない鍵は、そのまま見せる", () => {
    // 手で書いた覚え書きが混ざっていても、一覧ごと落とさない
    const entries = tuningStatsEntries(new Map([["謎", {}]]), (id) => id);

    expect(entries[0].providerLabel).toBe("謎");
    expect(entries[0].model).toBe("");
  });
});

describe("速度の求め方", () => {
  test("出力トークン数を所要秒で割り、小数1桁へ丸める", () => {
    expect(outputTokensPerSecond(3072, 4000)).toBe(768);
    expect(outputTokensPerSecond(100, 3000)).toBe(33.3);
  });

  test("測れないものは、無い（0にしない）", () => {
    // 所要0ミリ秒は「無限に速い」ではなく「測れていない」である
    expect(outputTokensPerSecond(3072, 0)).toBeUndefined();
    expect(outputTokensPerSecond(0, 4000)).toBeUndefined();
    expect(outputTokensPerSecond(undefined, 4000)).toBeUndefined();
    expect(outputTokensPerSecond(3072, Number.NaN)).toBeUndefined();
  });
});

describe("日時の見せ方", () => {
  test("日本時間の分までにする", () => {
    expect(formatMeasuredAt("2026-09-06T05:30:00.000Z")).toBe(
      "2026-09-06 14:30"
    );
  });

  test("無い・読めないものは「—」", () => {
    expect(formatMeasuredAt(undefined)).toBe("—");
    expect(formatMeasuredAt("いつか")).toBe("—");
  });
});

describe("モデル選択の説明", () => {
  test("速度が分かっていれば添える", () => {
    expect(modelPickDetail(["tools"], 12.3)).toBe(
      "対応: tools ／ 実測 12.3 トークン/秒"
    );
  });

  test("速度が無ければ、これまでどおり", () => {
    expect(modelPickDetail(["tools"], undefined)).toBe("対応: tools");
    expect(modelPickDetail([], undefined)).toBeUndefined();
  });

  test("対応が無くても、速度だけは見せる", () => {
    expect(modelPickDetail([], 12.3)).toBe("実測 12.3 トークン/秒");
  });
});
