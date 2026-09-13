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
import { parseModelTuning } from "../../src/core/modelTuning";

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
    expect(cells.slice(3, 9)).toEqual(["—", "—", "—", "—", "—", "—"]);
    // 字/トークンは普段の呼び出しから埋まるので、次に何をすれば出るかを書く
    expect(cells[9]).toBe("—（次の呼び出しから記録）");
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
        charsPerToken: 1.461,
        charsPerTokenSamples: 12,
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
      "字/トークン（実測）",
    ]);
    const cells = rows(markdown)[0];
    expect(cells[0]).toBe("Ollama");
    expect(cells[3]).toBe("普段の呼び出し");
    expect(cells[4]).toBe("2026-09-06 10:00");
    expect(cells[5]).toBe("131,072");
    expect(cells[6]).toBe("91,000");
    // **実測の換算があるので、字数が添う**（作者の依頼、2026-09-13
    // 「書ける長さの文字数は出せないでしょうか？」）。3,072 × 1.461 ≒ 4,488
    expect(cells[7]).toBe("3,072（約4,488字）");
    // 日本時間（UTC+9）。23:30Z は翌日の 8:30
    expect(cells[8]).toBe("2026-09-06 08:30");
    // **実際に見積もりへ使う値まで書く**（設計書6.77）。台帳の数字だけ
    // 出すと、「1.461と出ているのにチャンクが増えない」の理由が読めない
    expect(cells[9]).toBe("1.461（12回。余白を取って 1.315 で見積もり）");
  });

  /**
   * 字/トークンの実測（設計書6.77）。
   *
   * **数字が変わったのに、なぜ変わったかが読めないのがいちばん困る。**
   * 使っているのか・使っていないのか、使っていないならなぜかを欄に書く。
   */
  describe("字/トークンの実測", () => {
    test("件数が足りないうちは、まだ使わないと書く", () => {
      const markdown = buildTuningStatsMarkdown([
        entry("Ollama", "gemma4:e4b", {
          charsPerToken: 1.461,
          charsPerTokenSamples: 3,
        }),
      ]);
      expect(rows(markdown)[0][9]).toBe("1.461（3回。5回に満たないため 0.7 で見積もります）");
    });

    test("実測が低いモデルは、これまでどおり0.7のままと書く", () => {
      const markdown = buildTuningStatsMarkdown([
        entry("Ollama", "gemma4:e4b", {
          charsPerToken: 0.6,
          charsPerTokenSamples: 20,
        }),
      ]);
      expect(rows(markdown)[0][9]).toBe("0.600（20回。低いため 0.7 のまま）");
    });
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

    /**
     * **推定は、実測より速く出るようにできている。** 換算の係数は
     * 安全側（多め）に採ってあるので、同じモデルでも推定のほうが大きな
     * 数字になる。速い順にそのまま並べると、**一度も測っていないモデルが
     * 先頭に立つ**——速さを見に来た人が、いちばん当てにならない行を最初に
     * 読むことになる。
     */
    test("推定は、数字が大きくても実測の下へ回す", () => {
      const markdown = buildTuningStatsMarkdown([
        entry("Claude", "推定", {
          outputTokensPerSecond: 90,
          speedSource: "estimated",
        }),
        entry("Ollama", "測った", {
          outputTokensPerSecond: 20,
          speedSource: "tuning",
        }),
        entry("さくらのAI", "普段", {
          outputTokensPerSecond: 10,
          speedSource: "call",
        }),
        entry("LM Studio", "測っていない", {}),
      ]);

      expect(rows(markdown).map((cells) => cells[1])).toEqual([
        "測った",
        "普段",
        "推定",
        // 速度の無い行は、これまでどおりいちばん後ろ
        "測っていない",
      ]);
    });

    test("◎ 最速は実測の行にだけ付ける", () => {
      // 推定しか無いときは、誰にも印を付けない。**測れば分かることを、
      // 推定で決めてしまわない**
      const onlyEstimated = buildTuningStatsMarkdown([
        entry("Claude", "推定", {
          outputTokensPerSecond: 90,
          speedSource: "estimated",
        }),
        entry("ChatGPT", "推定2", {
          outputTokensPerSecond: 50,
          speedSource: "estimated",
        }),
      ]);

      expect(onlyEstimated).not.toContain("最速");

      // 実測が混じっていれば、その中のいちばん速い行に付く
      const mixed = buildTuningStatsMarkdown([
        entry("Claude", "推定", {
          outputTokensPerSecond: 90,
          speedSource: "estimated",
        }),
        entry("Ollama", "測った", {
          outputTokensPerSecond: 20,
          speedSource: "tuning",
        }),
      ]);
      const table = rows(mixed);
      expect(table[0][1]).toBe("測った");
      expect(table[0][2]).toContain("◎ 最速");
      expect(table[1][2]).not.toContain("最速");
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
    expect(modelPickDetail(["tools"], { outputTokensPerSecond: 12.3 })).toBe(
      "対応: tools ／ 実測 12.3 トークン/秒"
    );
  });

  test("速度が無ければ、これまでどおり", () => {
    expect(modelPickDetail(["tools"], undefined)).toBe("対応: tools");
    expect(modelPickDetail([], undefined)).toBeUndefined();
    expect(modelPickDetail([], {})).toBeUndefined();
  });

  test("対応が無くても、速度だけは見せる", () => {
    expect(modelPickDetail([], { outputTokensPerSecond: 12.3 })).toBe(
      "実測 12.3 トークン/秒"
    );
  });

  /*
    **読める長さと書ける長さを、選ぶ場にも出す**（作者の依頼、2026-09-13
    「モデルの一覧ですが、書ける文字数追加もやることリストに入れておいて
    ください」）。

    表と違って、ここは1行しかない。**断りは「以上」の二文字へ畳む**——
    理由まで書くと、対応している機能も速さも押し出されて読めなくなる。
    畳んでも「弱い数字だ」と分かることは落とさない。
  */
  test("**読める長さを出す**", () => {
    expect(modelPickDetail([], { measuredChars: 50209 })).toBe(
      "読める 50,209字"
    );
  });

  test("**天井で止まった値には「以上」を付ける**", () => {
    expect(
      modelPickDetail([], { measuredChars: 50209, contextHitCeiling: true })
    ).toBe("読める 50,209字以上");
  });

  test("**書ける長さは、実測の換算があれば字で出す**", () => {
    expect(
      modelPickDetail([], { measuredOutputTokens: 5235, charsPerToken: 1.511 })
    ).toBe("書ける 約7,910字");
  });

  test("換算が無ければ、トークンのまま出す（当て推量で割らない）", () => {
    expect(modelPickDetail([], { measuredOutputTokens: 2865 })).toBe(
      "書ける 2,865トークン"
    );
  });

  test("時間切れで打ち切った測定にも「以上」を付ける", () => {
    expect(
      modelPickDetail([], {
        measuredOutputTokens: 4290,
        charsPerToken: 1.383,
        outputMeasureTimedOut: true,
      })
    ).toBe("書ける 約5,933字以上");
  });

  test("壊れた換算では、字を出さない", () => {
    for (const ratio of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        modelPickDetail([], {
          measuredOutputTokens: 1000,
          charsPerToken: ratio,
        }),
        String(ratio)
      ).toBe("書ける 1,000トークン");
    }
  });

  test("**全部そろうと、この並びになる**", () => {
    expect(
      modelPickDetail(["completion", "tools"], {
        outputTokensPerSecond: 11.4,
        measuredChars: 50209,
        contextHitCeiling: true,
        measuredOutputTokens: 2865,
        charsPerToken: 1.234,
        outputMeasureTimedOut: true,
      })
    ).toBe(
      "対応: completion, tools ／ 実測 11.4 トークン/秒 ／ " +
        "読める 50,209字以上 ／ 書ける 約3,535字以上"
    );
  });
});

/**
 * **分あたりの上限で頭打ちになった値には、印を付ける**（作者の裁定、
 * 2026-09-13夜）。
 *
 * 実機の Gemini（無料枠）は、60秒待って送り直してもなお上限に当たる長さが
 * あった。そこは「その長さでは送れない」として降りるので、**出てくる値は
 * そのモデルの実力より低い**——待ってから測り直せば伸びることがある。
 *
 * **天井の印（`contextHitCeiling`）とは弱さの向きが逆である。** あちらは
 * 「本当はもっと読めるかもしれない（下限値）」、こちらは「低めに出ている」。
 * どちらも数字が弱いことを言うが、理由が違うので別の言葉で出す。
 */
describe("分あたりの上限で決まった読める長さ", () => {
  test("表に断りが出る", () => {
    const markdown = buildTuningStatsMarkdown([
      entry("Gemini", "gemini-flash-lite-latest", {
        measuredChars: 186_435,
        contextLimitedByRate: true,
      }),
    ]);
    expect(rows(markdown)[0][6]).toBe("186,435（分あたりの上限で決まった値）");
  });

  test("**当たっていなければ、断りは出ない**（`false` を書いた台帳）", () => {
    const markdown = buildTuningStatsMarkdown([
      entry("Gemini", "gemini-flash-lite-latest", {
        measuredChars: 186_435,
        contextLimitedByRate: false,
      }),
    ]);
    expect(rows(markdown)[0][6]).toBe("186,435");
  });

  test("天井・合言葉の断りと、同じ列に並ぶ", () => {
    // **弱さの理由は重なる。** 片方だけ出すと、もう片方の弱さが隠れる
    const markdown = buildTuningStatsMarkdown([
      entry("Gemini", "x", {
        measuredChars: 1000,
        contextHitCeiling: true,
        contextLimitedByRate: true,
        contextMeasuredBy: "words",
      }),
    ]);
    expect(rows(markdown)[0][6]).toBe(
      "1,000（これ以上は試していません。分あたりの上限で決まった値。合言葉で測定）"
    );
  });

  test("**選ぶ画面では「以上」を付けない**（印の意味が逆である）", () => {
    /*
      天井の印なら「以上」でよい——本当はもっと読めるかもしれないからで
      ある。こちらは逆で、値そのものが低く出ている。同じ「以上」を付けると、
      待てば伸びる数字を**強い実測だと誤解させる。**
    */
    const detail = modelPickDetail([], {
      measuredChars: 186_435,
      contextLimitedByRate: true,
    });
    expect(detail).toBe("読める 186,435字（分あたりの上限で頭打ち）");
    expect(detail).not.toContain("字以上");
  });

  test("当たっていなければ、選ぶ画面もこれまでどおり", () => {
    expect(
      modelPickDetail([], {
        measuredChars: 186_435,
        contextLimitedByRate: false,
      })
    ).toBe("読める 186,435字");
  });

  test("天井の印と重なったときは、弱いほうを出す", () => {
    // 強く見せて外すより、弱く見せて外すほうが害が小さい
    expect(
      modelPickDetail([], {
        measuredChars: 1000,
        contextHitCeiling: true,
        contextLimitedByRate: true,
      })
    ).toBe("読める 1,000字（分あたりの上限で頭打ち）");
  });
});

/**
 * **設定の生の値から、表と選ぶ画面まで届くこと**（作者の依頼、
 * 2026-09-13夜）。
 *
 * 0.58.0 で天井の印を足したとき、**`parseModelTuning` に読む側を足し忘れた。**
 * 表のテストは組み立てたレコードを直に渡していたので通ってしまい、
 * **実際には一度も画面に出ていなかった。** 同じ取りこぼしを繰り返さない
 * ために、設定 → `parseModelTuning` → 表 の道を通して見る。
 */
describe("分あたりの上限の印が、設定から表まで届く", () => {
  const raw = {
    "gemini/gemini-flash-lite-latest": {
      measuredChars: 186_435,
      contextLimitedByRate: true,
    },
    // **`false` も中身である。** 「測ったが、上限では降りなかった」
    "ollama/gemma4:12b": {
      measuredChars: 30_000,
      contextLimitedByRate: false,
    },
    // 印の付く前の古い台帳。これまでどおりの扱いのまま
    "ollama/qwen3:8b": { measuredChars: 20_000 },
  };

  test("`true` が読めている", () => {
    const tuning = parseModelTuning(raw).get("gemini/gemini-flash-lite-latest");
    expect(tuning?.contextLimitedByRate).toBe(true);
  });

  test("**`false` も読めている**（`undefined` へ潰さない）", () => {
    const tuning = parseModelTuning(raw).get("ollama/gemma4:12b");
    expect(tuning?.contextLimitedByRate).toBe(false);
  });

  test("古い台帳には印が無いまま", () => {
    const tuning = parseModelTuning(raw).get("ollama/qwen3:8b");
    expect(tuning?.contextLimitedByRate).toBeUndefined();
  });

  test("**設定から読んだものを表にすると、断りが出る**", () => {
    const tuning = parseModelTuning(raw).get("gemini/gemini-flash-lite-latest");
    if (!tuning) throw new Error("読めていない");
    const markdown = buildTuningStatsMarkdown([
      entry("Gemini", "gemini-flash-lite-latest", tuning),
    ]);
    expect(rows(markdown)[0][6]).toBe("186,435（分あたりの上限で決まった値）");
  });

  test("**設定から読んだものを選ぶ画面に出しても、断りが出る**", () => {
    const tuning = parseModelTuning(raw).get("gemini/gemini-flash-lite-latest");
    expect(modelPickDetail([], tuning)).toBe(
      "読める 186,435字（分あたりの上限で頭打ち）"
    );
  });
});
