import { describe, expect, test } from "vitest";
import {
  ADVICE_HISTORY_MAX,
  ADVICE_QUESTIONS,
  ADVICE_STATE_FRESH_DAYS,
  ADVICE_TYPES,
  adviceLevel,
  advicePolicyLogLines,
  applyProfileSignals,
  appendAdviceHistory,
  describeAdvicePolicyUpdate,
  describeAdviceTypeChange,
  isDiagnosisStale,
  isStateFresh,
  parseProfileSignals,
  resolveAdviceType,
  scoreAnswers,
  type AdviceProfile,
  type AdviceScores,
  type AdviceTypeId,
} from "../../src/core/advicePolicy";
import {
  ADVICE_STATE_PROMPTS,
  ADVICE_TYPE_PROMPTS,
  buildAdvicePolicyPrompt,
} from "../../src/prompts/advicePolicy";
import { AdvicePolicyStore } from "../../src/core/advicePolicyStore";
import { parseWorkChatAnswer } from "../../src/prompts/workChat";

/**
 * 相談の助言方針（設計書6.86、P-36）。
 *
 * **同じ助言が、作者によって正反対の意味で届く**という前提で作った仕組み。
 * ここで守るのは3つ。
 *
 * 1. 段階の境界と、同点のときの主軸の順（答えが同じなら結果も同じ）
 * 2. **タイプの文章を共有していないこと**——1回の相談で送るのは1つだけで、
 *    その文章に他のタイプの記述が混ざっていない
 * 3. 推定で点数が動くときの上下限と、受容度「低」の2回ルール
 */

const now = new Date("2026-09-07T00:00:00.000Z");

function scores(reader: number, self: number, taste: number): AdviceScores {
  return { reader, self, taste };
}

function profile(
  override: Partial<AdviceProfile> & { scores: AdviceScores }
): AdviceProfile {
  return {
    answers: [],
    updatedAt: now.toISOString(),
    ...override,
  };
}

describe("段階の境界", () => {
  test("0〜1は低、2〜4は中、5〜6は高", () => {
    expect(adviceLevel(0)).toBe("low");
    expect(adviceLevel(1)).toBe("low");
    expect(adviceLevel(2)).toBe("mid");
    expect(adviceLevel(4)).toBe("mid");
    expect(adviceLevel(5)).toBe("high");
    expect(adviceLevel(6)).toBe("high");
  });

  test("推定で動いた小数も、同じ物差しで測る", () => {
    // 1.5 はまだ低、2.0 から中。4.5 はまだ中、5.0 から高
    expect(adviceLevel(1.5)).toBe("low");
    expect(adviceLevel(4.5)).toBe("mid");
    expect(adviceLevel(4.9)).toBe("mid");
    expect(adviceLevel(5.5)).toBe("high");
  });
});

describe("答えの集計", () => {
  test("軸ごとに3問ぶんを合計する", () => {
    // X=2+2+2、Y=1+1+0、Z=0+0+0
    const result = scoreAnswers([2, 2, 2, 1, 1, 0, 0, 0, 0]);
    expect(result).toEqual(scores(6, 2, 0));
  });

  test("答えが足りなくても落ちない", () => {
    expect(scoreAnswers([])).toEqual(scores(0, 0, 0));
  });

  test("質問は9問で、軸ごとに3問ずつ", () => {
    expect(ADVICE_QUESTIONS).toHaveLength(9);
    for (const axis of ["reader", "self", "taste"] as const) {
      expect(ADVICE_QUESTIONS.filter((q) => q.axis === axis)).toHaveLength(3);
    }
  });
});

describe("タイプの判定", () => {
  const CASES: Array<[AdviceTypeId, AdviceScores]> = [
    ["reader_first", scores(6, 0, 0)],
    ["reader_message", scores(6, 3, 0)],
    ["reader_craft", scores(6, 0, 3)],
    ["self_reflective", scores(0, 6, 0)],
    ["self_dialogue", scores(3, 6, 0)],
    ["self_world", scores(0, 6, 3)],
    ["taste_explorer", scores(0, 0, 6)],
    ["taste_sharing", scores(3, 0, 6)],
    ["taste_myth", scores(0, 3, 6)],
    ["balanced", scores(3, 3, 3)],
    ["seeking_purpose", scores(0, 0, 0)],
  ];

  test.each(CASES)("%s に到達できる", (expected, input) => {
    expect(resolveAdviceType(input)).toBe(expected);
  });

  test("11タイプすべてに到達する例がある", () => {
    // ここが落ちたら、届かないタイプができている
    expect(new Set(CASES.map(([id]) => id)).size).toBe(
      Object.keys(ADVICE_TYPES).length
    );
  });

  test("3軸すべて低なら目的模索型", () => {
    expect(resolveAdviceType(scores(1, 1, 0))).toBe("seeking_purpose");
  });

  test("3軸すべて中なら均衡模索型", () => {
    expect(resolveAdviceType(scores(2, 4, 3))).toBe("balanced");
  });

  test("同点は X → Y → Z の順で主軸を決める", () => {
    // 全部高で同点。主軸はX、副軸は残りの同点からY
    expect(resolveAdviceType(scores(6, 6, 6))).toBe("reader_message");
    // YとZが同点。主軸はY、副軸は低いXが中なので…ではなくZ（同点はYが先）
    expect(resolveAdviceType(scores(0, 6, 6))).toBe("self_world");
  });

  test("副軸は「中以上」だけ。低い軸は副軸にしない", () => {
    // Yが1点（低）なので副軸にならない
    expect(resolveAdviceType(scores(6, 1, 0))).toBe("reader_first");
  });
});

describe("状態の期限", () => {
  test("14日以内なら使う", () => {
    const at = new Date(now.getTime() - 13 * 24 * 60 * 60 * 1000);
    expect(isStateFresh(at.toISOString(), now)).toBe(true);
  });

  test("14日を過ぎたら未知として扱う", () => {
    const at = new Date(
      now.getTime() - (ADVICE_STATE_FRESH_DAYS + 1) * 24 * 60 * 60 * 1000
    );
    expect(isStateFresh(at.toISOString(), now)).toBe(false);
  });

  test("読めない日付は未知として扱う", () => {
    expect(isStateFresh("きのう", now)).toBe(false);
  });
});

describe("診断のやり直しの目安", () => {
  test("30日を過ぎたら古いと言う", () => {
    const at = new Date(now.getTime() - 31 * 24 * 60 * 60 * 1000);
    expect(isDiagnosisStale(at.toISOString(), now)).toBe(true);
  });

  test("29日ならまだ言わない", () => {
    const at = new Date(now.getTime() - 29 * 24 * 60 * 60 * 1000);
    expect(isDiagnosisStale(at.toISOString(), now)).toBe(false);
  });

  test("読めない日付を「古い」と言い切らない", () => {
    expect(isDiagnosisStale("", now)).toBe(false);
  });
});

describe("送るのは、該当する文章だけ", () => {
  const typeTexts = Object.values(ADVICE_TYPE_PROMPTS);

  test("タイプの文章は、ちょうど1つだけ入る", () => {
    const text = buildAdvicePolicyPrompt(profile({ scores: scores(6, 0, 0) }), now);
    const included = typeTexts.filter((body) => text.includes(body));
    expect(included).toHaveLength(1);
    expect(included[0]).toBe(ADVICE_TYPE_PROMPTS.reader_first);
  });

  test("調子が新しければ、状態の文章も1つ入る", () => {
    const text = buildAdvicePolicyPrompt(
      profile({
        scores: scores(6, 0, 0),
        state: {
          acceptance: "high",
          confidence: "low",
          updatedAt: now.toISOString(),
        },
      }),
      now
    );
    const included = Object.values(ADVICE_STATE_PROMPTS).filter((body) =>
      text.includes(body)
    );
    expect(included).toEqual([ADVICE_STATE_PROMPTS["high-low"]]);
  });

  test("14日を過ぎた調子は送らない", () => {
    const old = new Date(
      now.getTime() - (ADVICE_STATE_FRESH_DAYS + 1) * 24 * 60 * 60 * 1000
    );
    const text = buildAdvicePolicyPrompt(
      profile({
        scores: scores(6, 0, 0),
        state: {
          acceptance: "high",
          confidence: "low",
          updatedAt: old.toISOString(),
        },
      }),
      now
    );
    const included = Object.values(ADVICE_STATE_PROMPTS).filter((body) =>
      text.includes(body)
    );
    expect(included).toEqual([]);
  });

  test("調子が無くても、タイプの文章は送る（相談は止めない）", () => {
    const text = buildAdvicePolicyPrompt(profile({ scores: scores(0, 0, 0) }), now);
    expect(text).toContain(ADVICE_TYPE_PROMPTS.seeking_purpose);
  });

  test("推定であることと、診断した日を書く", () => {
    const text = buildAdvicePolicyPrompt(
      profile({
        scores: scores(6, 0, 0),
        updatedAt: "2026-08-30T12:00:00.000Z",
      }),
      now
    );
    expect(text).toContain("推定");
    expect(text).toContain("2026-08-30");
    // いまの作者の言葉のほうを優先させる
    expect(text).toContain("いまの作者の言葉を優先");
  });

  test("読めない日付でも作れる", () => {
    const text = buildAdvicePolicyPrompt(
      profile({ scores: scores(6, 0, 0), updatedAt: "" }),
      now
    );
    expect(text).toContain("診断日は不明");
  });
});

describe("プロンプトを共有していない", () => {
  test("11タイプの文章がすべて違う", () => {
    const texts = Object.values(ADVICE_TYPE_PROMPTS);
    expect(texts).toHaveLength(11);
    expect(new Set(texts).size).toBe(11);
  });

  test("各タイプの文章に、他のタイプの名前が出てこない", () => {
    // 出ていたら「共有しない」が崩れている。他のタイプの記述に
    // 引きずられた助言が返る（作者の指定、2026-09-07）
    const leaks: string[] = [];
    for (const [id, body] of Object.entries(ADVICE_TYPE_PROMPTS)) {
      for (const [other, info] of Object.entries(ADVICE_TYPES)) {
        if (other === id) continue;
        if (body.includes(info.label)) leaks.push(`${id} に ${info.label}`);
      }
    }
    expect(leaks).toEqual([]);
  });

  test("9つの状態の文章がすべて違う", () => {
    const texts = Object.values(ADVICE_STATE_PROMPTS);
    expect(texts).toHaveLength(9);
    expect(new Set(texts).size).toBe(9);
  });

  test("タイプの文章は250〜450字、状態の文章は150〜300字", () => {
    for (const [id, body] of Object.entries(ADVICE_TYPE_PROMPTS)) {
      expect(body.length, id).toBeGreaterThanOrEqual(250);
      expect(body.length, id).toBeLessThanOrEqual(450);
    }
    for (const [key, body] of Object.entries(ADVICE_STATE_PROMPTS)) {
      expect(body.length, key).toBeGreaterThanOrEqual(150);
      expect(body.length, key).toBeLessThanOrEqual(300);
    }
  });
});

describe("相談からの推定で点数を動かす", () => {
  test("+1は0.5だけ上げ、-1は0.5だけ下げる", () => {
    const before = profile({ scores: scores(3, 3, 3) });
    const after = applyProfileSignals(before, { reader: 1, taste: -1 }, now);
    expect(after.scores).toEqual(scores(3.5, 3, 2.5));
  });

  test("0や省略では動かさない（同じものを書き戻さない）", () => {
    const before = profile({ scores: scores(3, 3, 3) });
    expect(applyProfileSignals(before, { reader: 0 }, now)).toBe(before);
    expect(applyProfileSignals(before, {}, now)).toBe(before);
  });

  test("0未満・6超へは出ない", () => {
    const low = applyProfileSignals(
      profile({ scores: scores(0, 6, 0) }),
      { reader: -1, self: 1 },
      now
    );
    expect(low.scores).toEqual(scores(0, 6, 0));
  });

  test("段階の境界をまたぐと、タイプが変わる", () => {
    // 読者志向 1.5（低）→ 2.0（中）で、副軸として立ち上がる
    const before = profile({ scores: scores(1.5, 3, 0) });
    expect(resolveAdviceType(before.scores)).toBe("self_reflective");

    const after = applyProfileSignals(before, { reader: 1 }, now);
    expect(after.scores.reader).toBe(2);
    expect(resolveAdviceType(after.scores)).toBe("self_dialogue");
  });

  test("診断時の点数は残る", () => {
    const before = profile({ scores: scores(3, 3, 3) });
    const after = applyProfileSignals(before, { reader: 1 }, now);
    expect(after.baseScores).toEqual(scores(3, 3, 3));

    // 二度目に動いても、診断時の値は上書きされない
    const twice = applyProfileSignals(after, { reader: 1 }, now);
    expect(twice.baseScores).toEqual(scores(3, 3, 3));
    expect(twice.scores.reader).toBe(4);
  });

  test("診断した日時は、推定では動かさない", () => {
    const before = profile({
      scores: scores(3, 3, 3),
      updatedAt: "2026-08-01T00:00:00.000Z",
    });
    const after = applyProfileSignals(before, { reader: 1 }, now);
    expect(after.updatedAt).toBe("2026-08-01T00:00:00.000Z");
  });
});

describe("操作ログに残す行", () => {
  test("診断していれば、タイプを1行残す（実機確認リスト F-95 の代わり）", () => {
    const lines = advicePolicyLogLines(profile({ scores: scores(6, 0, 0) }), now);
    expect(lines).toEqual(["相談: 助言方針 読者最適型"]);
  });

  /** 「方針を消す」のあとも、診断前も、ここを通る */
  test("診断していなければ、1行も残さない（実機確認リスト F-95 の代わり）", () => {
    expect(advicePolicyLogLines(undefined, now)).toEqual([]);
  });

  test("診断から30日を過ぎたら、その手掛かりも残す（実機確認リスト F-95 の代わり）", () => {
    const lines = advicePolicyLogLines(
      profile({ scores: scores(6, 0, 0), updatedAt: "2026-07-01T00:00:00.000Z" }),
      now
    );
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("日を過ぎています");
  });

  test("推定で動いた軸を、小数1桁で残す（実機確認リスト F-95 の代わり）", () => {
    const before = profile({ scores: scores(3.5, 3, 3) });
    const after = applyProfileSignals(before, { reader: 1 }, now);
    expect(describeAdvicePolicyUpdate(before, after)).toBe(
      "相談: 助言方針の推定を更新 読者志向 3.5→4.0（均衡模索型のまま）"
    );
  });

  /** 受容度・自信度は、画面に出さないと決めたもの。ログからも漏らさない */
  test("受容度・自信度の値はログに出ない（実機確認リスト F-95 の代わり）", () => {
    const before = profile({ scores: scores(3, 3, 3) });
    const after = applyProfileSignals(
      before,
      { reader: 1, receptivity: "low", confidence: "high" },
      now
    );
    const line = describeAdvicePolicyUpdate(before, after) ?? "";
    expect(line).not.toContain("受容");
    expect(line).not.toContain("自信");
    expect(line).not.toContain("low");
    expect(line).not.toContain("high");
  });

  test("動いた軸が無ければ、何も書かない（実機確認リスト F-95 の代わり）", () => {
    const before = profile({ scores: scores(3, 3, 3) });
    expect(describeAdvicePolicyUpdate(before, before)).toBeUndefined();
  });

  test("タイプが変わったときだけ、作者へ知らせる（実機確認リスト F-95 の代わり）", () => {
    const before = profile({ scores: scores(1.5, 3, 0) });
    const after = applyProfileSignals(before, { reader: 1 }, now);
    expect(describeAdviceTypeChange(before, after)).toBe(
      "助言方針の推定が変わりました：内省表現型 → 対話表現型"
    );
    expect(describeAdviceTypeChange(before, before)).toBeUndefined();
  });
});

describe("調子の推定", () => {
  test("受容度「低」は、2回続かないと下げない", () => {
    const first = applyProfileSignals(
      profile({ scores: scores(3, 3, 3) }),
      { acceptance: "low" },
      now
    );
    expect(first.state?.acceptance).not.toBe("low");
    expect(first.state?.lowStreak).toBe(1);

    const second = applyProfileSignals(first, { acceptance: "low" }, now);
    expect(second.state?.acceptance).toBe("low");
  });

  test("高・中はその場で反映し、連続の数え直しをする", () => {
    const first = applyProfileSignals(
      profile({ scores: scores(3, 3, 3) }),
      { acceptance: "low" },
      now
    );
    const back = applyProfileSignals(first, { acceptance: "high" }, now);
    expect(back.state?.acceptance).toBe("high");
    expect(back.state?.lowStreak).toBe(0);

    // 数え直したので、次の1回では下がらない
    const again = applyProfileSignals(back, { acceptance: "low" }, now);
    expect(again.state?.acceptance).not.toBe("low");
  });

  test("自信度は届いた値をそのまま入れる", () => {
    const after = applyProfileSignals(
      profile({ scores: scores(3, 3, 3) }),
      { confidence: "low" },
      now
    );
    expect(after.state?.confidence).toBe("low");
    expect(after.state?.updatedAt).toBe(now.toISOString());
  });
});

describe("変化の履歴", () => {
  test("タイプが変わったときだけ積む", () => {
    const before = profile({ scores: scores(1.5, 3, 0) });
    const changed = applyProfileSignals(before, { reader: 1 }, now);
    expect(changed.history).toHaveLength(1);
    expect(changed.history?.[0].typeId).toBe("self_reflective");
    expect(changed.history?.[0].source).toBe("estimated");

    // タイプが変わらない動きでは積まない（2.0→2.5 はどちらも中）
    const same = applyProfileSignals(changed, { reader: 1 }, now);
    expect(same.history).toHaveLength(1);
  });

  test("診断で積んだ記録は diagnosis になる", () => {
    const before = profile({
      scores: scores(0, 0, 0),
      updatedAt: "2026-08-30T00:00:00.000Z",
    });
    const next = profile({ scores: scores(6, 0, 0) });
    const merged = appendAdviceHistory(before, next, "diagnosis");
    expect(merged.history?.[0]).toMatchObject({
      typeId: "seeking_purpose",
      source: "diagnosis",
      updatedAt: "2026-08-30T00:00:00.000Z",
    });
  });

  test("初回は積むものが無い", () => {
    const next = profile({ scores: scores(6, 0, 0) });
    expect(appendAdviceHistory(undefined, next).history).toBeUndefined();
  });

  test("5件で切れる（古いものから落ちる）", () => {
    let current = profile({ scores: scores(0, 0, 0) });
    // 交互にタイプが変わる保存を7回重ねる
    for (let i = 0; i < 7; i++) {
      const next = profile({
        scores: i % 2 === 0 ? scores(6, 0, 0) : scores(0, 0, 0),
        history: current.history,
      });
      current = appendAdviceHistory(current, next, "diagnosis");
    }
    expect(current.history).toHaveLength(ADVICE_HISTORY_MAX);
  });
});

describe("AIが返した profileSignals を絞る", () => {
  test("-1・0・+1 と、低中高だけを受ける", () => {
    expect(
      parseProfileSignals({
        reader: 1,
        self: -1,
        taste: 0,
        acceptance: "high",
        confidence: "mid",
      })
    ).toEqual({
      reader: 1,
      self: -1,
      taste: 0,
      acceptance: "high",
      confidence: "mid",
    });
  });

  test("想定外の値は捨てる", () => {
    // 指示語がそのまま返る（"low|mid|high"）・幅を超える数・文字列の数
    expect(
      parseProfileSignals({
        reader: 3,
        self: 0.5,
        taste: "+1",
        acceptance: "low|mid|high",
        confidence: "とても低い",
      })
    ).toBeUndefined();
  });

  test("何も読み取れなければ undefined", () => {
    expect(parseProfileSignals(null)).toBeUndefined();
    expect(parseProfileSignals("なし")).toBeUndefined();
    expect(parseProfileSignals({})).toBeUndefined();
  });

  test("相談の答えを読むときにも、壊れた値は捨てる", () => {
    const good = parseWorkChatAnswer(
      JSON.stringify({ reply: "はい", profileSignals: { reader: 1 } })
    );
    expect(good.profileSignals).toEqual({ reader: 1 });

    const bad = parseWorkChatAnswer(
      JSON.stringify({ reply: "はい", profileSignals: { reader: "+1" } })
    );
    expect(bad.profileSignals).toBeUndefined();

    const none = parseWorkChatAnswer(JSON.stringify({ reply: "はい" }));
    expect(none.profileSignals).toBeUndefined();
  });
});

describe("保存先", () => {
  /** `vscode.Memento` の代役。作品ごとの鍵で出し入れできればよい */
  function memento() {
    const state = new Map<string, unknown>();
    return {
      keys: () => [...state.keys()],
      get: (key: string) => state.get(key),
      update: (key: string, value: unknown) => {
        if (value === undefined) state.delete(key);
        else state.set(key, value);
        return Promise.resolve();
      },
      setKeysForSync: () => undefined,
    };
  }

  test("作品ごとに出し入れできる", async () => {
    const state = memento();
    const store = new AdvicePolicyStore(state as never);
    const value = profile({ scores: scores(6, 0, 0) });

    expect(store.get("w1")).toBeUndefined();
    await store.set("w1", value);
    expect(store.get("w1")).toEqual(value);
    // 別の作品には影響しない
    expect(store.get("w2")).toBeUndefined();

    await store.clear("w1");
    expect(store.get("w1")).toBeUndefined();
  });

  test("鍵に作品IDが入る", () => {
    const state = memento();
    const store = new AdvicePolicyStore(state as never);
    void store.set("w1", profile({ scores: scores(0, 0, 0) }));
    expect(state.keys()).toEqual(["novelai.advicePolicy.w1"]);
  });
});
