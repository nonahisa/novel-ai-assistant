import { describe, expect, test } from "vitest";
import {
  deniesDeviation,
  normalizeType,
  parseDeviationResult,
  referencesPlot,
  sortDeviations,
  validateDeviations,
  type AcceptedDeviation,
} from "../../src/core/deviationValidation";
import { deviationBudget } from "../../src/prompts/deviationCheck";

/**
 * プロット逸脱・間延びの検証（設計書6.10.2）。
 *
 * **今日ここまでで2度、同じ失敗をしている**（矛盾検知・推敲）。
 * どちらも「AIが材料側の文を引いて本文だと言う」「許した札に禁じた中身を
 * 入れる」だった。**最初から同じ手当てを入れてある。**
 *
 * この機能に固有の危うさは、**照らし合わせた先が実在しないこと**である。
 */
const PLOT = [
  "# 幽霊になった少年",
  "",
  "## ログライン",
  "いじめで死んだ少年が幽霊になり、証拠を残して真相を明かす。",
  "",
  "## あらすじ",
  "- 太志が体育倉庫で目を覚ます",
  "- 近所のおばあさんに霊視される",
  "- 遺書の存在が明かされる",
].join("\n");

const TEXT = [
  "太志は体育倉庫で目を覚ました。",
  "おばあさんが手を伸ばしてくる。",
  "空から急にドラゴンが降りてきた。",
].join("\n");

const episode = { text: TEXT, plot: PLOT };

function item(overrides: Record<string, unknown> = {}) {
  return {
    lineStart: 3,
    lineEnd: 3,
    excerpt: "空から急にドラゴンが降りてきた。",
    type: "逸脱",
    reason: "あらすじに無い展開で、主筋に繋がっていません",
    plotReference: "遺書の存在が明かされる",
    severity: "medium",
    confidence: "high",
    ...overrides,
  };
}

describe("応答の読み取り", () => {
  test("コードフェンス付きでも読める", () => {
    expect(
      parseDeviationResult('```json\n{"deviations":[{"lineStart":1}]}\n```')
        ?.deviations
    ).toHaveLength(1);
  });

  test("読めなければ null", () => {
    expect(parseDeviationResult("問題ありません")).toBeNull();
  });
});

describe("受け入れる指摘", () => {
  test("本文にもプロットにも根拠があれば通す", () => {
    const result = validateDeviations({ deviations: [item()] }, episode);

    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0].type).toBe("逸脱");
  });

  test("プロットの見出しを指しているだけでも通す", () => {
    // 引用ではないが、照らした先としては特定できている
    const result = validateDeviations(
      { deviations: [item({ plotReference: "あらすじ" })] },
      episode
    );

    expect(result.accepted).toHaveLength(1);
  });

  test("終わりの行が読めなければ、始まりの行だけを指す", () => {
    const result = validateDeviations(
      { deviations: [item({ lineEnd: "おわり" })] },
      episode
    );

    expect(result.accepted[0].lineEnd).toBe(3);
  });

  test("終わりの行が逆さまでも壊れない", () => {
    const result = validateDeviations(
      { deviations: [item({ lineStart: 3, lineEnd: 1 })] },
      episode
    );

    expect(result.accepted[0].lineEnd).toBe(3);
  });
});

describe("弾く指摘", () => {
  test("照らした先がプロットに無ければ弾く", () => {
    // **「プロットの『主人公の成長』と照らして」と言われても、
    // プロットにそんな項目が無ければ、その指摘は根拠を持たない**
    const result = validateDeviations(
      { deviations: [item({ plotReference: "主人公の成長という主題" })] },
      episode
    );

    expect(result.accepted).toHaveLength(0);
    expect(result.rejected[0].reason).toBe("plot_reference_not_found");
  });

  test("本文に無い引用を弾く", () => {
    // プロットの文をそのまま引いて「本文にこうある」と言う
    const result = validateDeviations(
      { deviations: [item({ excerpt: "遺書の存在が明かされる" })] },
      episode
    );

    expect(result.rejected[0].reason).toBe("excerpt_not_found");
  });

  test("本文の外の行を弾く", () => {
    expect(
      validateDeviations({ deviations: [item({ lineStart: 99 })] }, episode)
        .rejected[0].reason
    ).toBe("line_out_of_range");
  });

  test("知らない種別を弾く", () => {
    expect(
      validateDeviations({ deviations: [item({ type: "冗長" })] }, episode)
        .rejected[0].reason
    ).toBe("unknown_type");
  });

  test("理由が空なら弾く", () => {
    // 「なぜそう判断したか」が無い指摘は、作者が判断できない
    expect(
      validateDeviations({ deviations: [item({ reason: "" })] }, episode)
        .rejected[0].reason
    ).toBe("shape");
  });

  test("形が違うものを弾く", () => {
    const result = validateDeviations(
      { deviations: ["逸脱しています", null, { lineStart: 1 }] },
      episode
    );

    expect(result.accepted).toHaveLength(0);
    expect(result.rejected).toHaveLength(3);
  });

  test("応答が空でも落ちない", () => {
    expect(validateDeviations(null, episode).accepted).toEqual([]);
  });
});

/**
 * 実データ（いじめられっ子・gemma4:e4b）で実際に返ってきたものを固定する。
 */
describe("実データで見つかった、通してはいけない指摘", () => {
  test.each([
    "プロットの…事象自体はカバーしています",
    "プロットに沿っており、問題ありません",
    "幽霊であることの描写として追加された可能性があります",
    "行動の背景説明として追加された情報と見なせます",
    "人物の掘り下げとして働いています",
  ])("「これは逸脱ではない」と自分で書いていたら弾く: %s", (reason) => {
    expect(deniesDeviation(reason)).toBe(true);
  });

  test.each([
    "プロットのどの部分とも直接結びついていません",
    "あらすじに無い展開で、主筋に繋がっていません",
  ])("本当の指摘を否定と読み違えない: %s", (reason) => {
    expect(deniesDeviation(reason)).toBe(false);
  });

  test("段落をまるごと写した引用を弾く", () => {
    // **実データで数百字の塊が返ってきた。** それは引用ではなく、
    // どこを指しているのか分からない
    const result = validateDeviations(
      { deviations: [item({ excerpt: "太志".repeat(60) })] },
      episode
    );

    expect(result.rejected[0].reason).toBe("excerpt_too_long");
  });

  test("理由が自己否定なら、他が揃っていても弾く", () => {
    const result = validateDeviations(
      { deviations: [item({ reason: "プロットの事象自体はカバーしています" })] },
      episode
    );

    expect(result.accepted).toHaveLength(0);
    expect(result.rejected[0].reason).toBe("self_denied");
  });
});

describe("照らした先の確かめ方", () => {
  test("プロットの語句をそのまま引いていれば通す", () => {
    expect(referencesPlot("遺書の存在が明かされる", PLOT)).toBe(true);
  });

  test("見出しの名前でも通す", () => {
    expect(referencesPlot("あらすじ", PLOT)).toBe(true);
    expect(referencesPlot("ログライン", PLOT)).toBe(true);
  });

  test("プロットに無いものは通さない", () => {
    expect(referencesPlot("主人公の成長という主題", PLOT)).toBe(false);
    expect(referencesPlot("", PLOT)).toBe(false);
  });
});

describe("出しすぎを切る", () => {
  test("1つの話でせいぜい4件まで", () => {
    // 5件も出たら、プロットのほうが古いかAIが探しすぎている
    expect(deviationBudget(2000)).toBe(1);
    expect(deviationBudget(8000)).toBe(4);
    expect(deviationBudget(40_000)).toBe(4);
  });

  test("短い話でも1件は挙げられる", () => {
    expect(deviationBudget(100)).toBe(1);
  });

  test("上限を超えたぶんを弾く", () => {
    const many = Array.from({ length: 5 }, () => item());
    const result = validateDeviations({ deviations: many }, episode);

    // TEXT は短いので上限1件
    expect(result.accepted).toHaveLength(1);
    expect(
      result.rejected.filter((entry) => entry.reason === "over_budget")
    ).toHaveLength(4);
  });

  test("切るときは確信度の高いものを残す", () => {
    const result = validateDeviations(
      {
        deviations: [
          item({ confidence: "low" }),
          item({ confidence: "high", lineStart: 1, excerpt: "太志は体育倉庫で" }),
        ],
      },
      episode
    );

    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0].confidence).toBe("high");
  });
});

describe("種別の読み取り", () => {
  test("選択肢を写して返されても拾う", () => {
    // 矛盾検知・推敲で実際に起きた形
    expect(normalizeType("逸脱|間延び")).toBe("逸脱");
    expect(normalizeType("間延び：物語が前進していない")).toBe("間延び");
  });

  test("知らない語は決めない", () => {
    expect(normalizeType("冗長")).toBeUndefined();
  });
});

describe("並べ方", () => {
  test("確信度の高いものを上に", () => {
    const make = (
      confidence: "high" | "medium" | "low",
      lineStart: number
    ): AcceptedDeviation => ({
      lineStart,
      lineEnd: lineStart,
      excerpt: "x",
      type: "逸脱",
      reason: "r",
      plotReference: "p",
      severity: "medium",
      confidence,
    });

    expect(
      sortDeviations([make("low", 1), make("high", 2), make("medium", 3)]).map(
        (entry) => entry.confidence
      )
    ).toEqual(["high", "medium", "low"]);
  });
});
