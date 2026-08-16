import { describe, expect, test } from "vitest";
import {
  hasLongSentence,
  hasRepetition,
  isDialogueOnly,
  mentionsForbiddenAspect,
  normalizeReason,
  parseProofreadResult,
  sortProofreadIssues,
  validateProofreadIssues,
  type AcceptedProofreadIssue,
} from "../../src/core/proofreadValidation";
import { issueBudget } from "../../src/prompts/proofread";
import type { Chunk } from "../../src/core/chunker";

/**
 * 推敲の提案の検証（設計書6.9.1）。
 *
 * **いちばん危ないのは出しすぎること。** 誤字脱字には正解があるが、
 * 推敲には無い。AIはどの文にも何かしら言えるので、放っておくと
 * 全部の文に提案が付き、作者は読むだけで疲れて機能ごと使わなくなる。
 */
function chunkOf(text: string): Chunk {
  return {
    filePath: "C:/works/007.txt",
    index: 0,
    text,
    startLine: 10,
    chapterStart: 7,
    chapterEnd: 7,
    hash: "abc123",
    segments: [],
  } as unknown as Chunk;
}

const chunk = chunkOf(
  "まず最初に、彼は立ち上がった。\n彼は歩いた。彼は走った。彼は止まった。\n夜が明けた。"
);

function item(overrides: Record<string, unknown> = {}) {
  return {
    line: 11,
    original: "まず最初に",
    suggestion: "まず",
    reason: "冗長",
    explanation: "同じ意味が重なっています",
    confidence: "high",
    ...overrides,
  };
}

describe("応答の読み取り", () => {
  test("コードフェンス付きでも読める", () => {
    expect(
      parseProofreadResult('```json\n{"issues":[{"line":1}]}\n```')?.issues
    ).toHaveLength(1);
  });

  test("読めなければ null", () => {
    expect(parseProofreadResult("特にありません")).toBeNull();
  });
});

describe("受け入れる提案", () => {
  test("本文に実在する原文は通す", () => {
    const result = validateProofreadIssues({ issues: [item()] }, chunk);

    expect(result.accepted).toHaveLength(1);
    // 推敲は原文まるごとを置き換える
    expect(result.accepted[0].target).toBe("まず最初に");
  });
});

describe("弾く提案", () => {
  test("本文に無い原文を弾く", () => {
    // 言い換えた「原文」を返すことがあり、適用するとどこにも当たらない
    const result = validateProofreadIssues(
      { issues: [item({ original: "はじめに彼は" })] },
      chunk
    );

    expect(result.rejected[0].reason).toBe("original_not_found");
  });

  test("決めた4種類以外の理由を弾く", () => {
    // **文体への干渉が紛れ込む口を塞ぐ**
    for (const reason of ["語彙", "リズム", "描写不足", "もっと小説らしく"]) {
      const result = validateProofreadIssues(
        { issues: [item({ reason })] },
        chunk
      );
      expect(result.rejected[0]?.reason, reason).toBe("unknown_reason");
    }
  });

  test("変わっていない提案を弾く", () => {
    // 押しても何も起きない
    const result = validateProofreadIssues(
      { issues: [item({ suggestion: "まず最初に" })] },
      chunk
    );

    expect(result.rejected[0].reason).toBe("no_change");
  });

  test("チャンクの外の行を弾く", () => {
    expect(
      validateProofreadIssues({ issues: [item({ line: 999 })] }, chunk)
        .rejected[0].reason
    ).toBe("line_out_of_range");
  });

  test("形が違うものを弾く", () => {
    const result = validateProofreadIssues(
      { issues: ["冗長です", null, { line: 11 }] },
      chunk
    );

    expect(result.accepted).toHaveLength(0);
    expect(result.rejected).toHaveLength(3);
  });

  test("応答が空でも落ちない", () => {
    expect(validateProofreadIssues(null, chunk).accepted).toEqual([]);
  });
});

/**
 * 実データ（いじめられっ子・gemma4:e4b）で実際に返ってきたものを固定する。
 *
 * **禁じた観点が、許した札を着て入ってきた。** 札だけ見ていると素通りする。
 */
describe("実データで見つかった、通してはいけない提案", () => {
  test("「長文」の札だが、長文でない箇所を弾く", () => {
    // 「文の区切りが連続しており、流れがやや急ぎ足」のような**文体の話**に
    // この札が付いてくる
    const short = chunkOf("彼は歩いた。彼は走った。");
    const result = validateProofreadIssues(
      {
        issues: [
          {
            line: 11,
            original: "彼は歩いた。彼は走った。",
            suggestion: "",
            reason: "長文",
            explanation: "文の区切りが連続しています",
            confidence: "medium",
          },
        ],
      },
      short
    );

    expect(result.rejected[0].reason).toBe("not_long");
  });

  test("本当の長文は通す", () => {
    // 一文が80字を超え、読点が5個以上
    const long =
      "彼は、朝早くに起きて、顔を洗い、着替えを済ませ、鞄を持って、玄関を出て、" +
      "駅までの道を急ぎ足で歩き、いつもの電車に間に合うように改札を抜け、" +
      "席に座って本を開き、目的の駅まで一度も顔を上げなかった。";
    expect(long.length).toBeGreaterThan(80);
    expect(hasLongSentence(long)).toBe(true);
    expect(hasLongSentence("短い文。もう一つ短い文。")).toBe(false);
  });

  test("「同語反復」の札だが、繰り返しが無い箇所を弾く", () => {
    const text = chunkOf("コメント欄には、ばっちり名前が出てしまっていた。");
    const result = validateProofreadIssues(
      {
        issues: [
          {
            line: 11,
            original: "コメント欄には、ばっちり名前が出てしまっていた。",
            suggestion: "",
            reason: "同語反復",
            explanation: "「ばっちり」がやや砕けています",
            confidence: "low",
          },
        ],
      },
      text
    );

    expect(result.rejected[0].reason).toBe("not_repeated");
  });

  test("本当の繰り返しは通す", () => {
    expect(hasRepetition("母さんも怒鳴り返している。母さんが怒鳴っている。")).toBe(
      true
    );
    // 2文字の並び（「ている」など）はどの文にも出るので、境は3文字
    expect(hasRepetition("彼は走った。")).toBe(false);
  });

  /**
   * 作者の10作品・44,000字で測ったときに実際に挙がったもの
   * （gemma4:e4b、2026-08-17）。
   *
   * **繰り返しは本当にあるが、それは人物の喋り方だった。**
   * `hasRepetition` は数えるだけなので、ここは素通りしていた。
   */
  describe("台詞の中の繰り返しは、人物の話し方として通さない", () => {
    test.each([
      // 関西弁（長命ハイエルフの投資運用）
      "「あんた、クォーターやろ？　なんゆうてまんのや？　そやかて」",
      // わざと崩した喋り（短編 N1071IJ）
      "「わた、く、しは、で　んかを、あいして　い ます……」",
      // 強調の反復（長命ハイエルフの投資運用）
      "「商人は帝国を打倒したりせぇへん。商人は商人らしく、遠慮なく稼いだれ」",
      // 台詞が2つ続く場合も、地の文は無い
      "「行こう」「行かない」",
    ])("弾く: %s", (original) => {
      expect(isDialogueOnly(original)).toBe(true);
    });

    test.each([
      // 地の文の対句。直すかどうかは作者が決める
      "ある者は主人に報告に、ある者は店員を呼び集めるために駆け込んでいく。",
      // 台詞に地の文が続く形
      "「行こう」と彼は言った。彼はまた言った。",
      // 台詞そのものが無い
      "母さんも怒鳴り返している。母さんが怒鳴っている。",
    ])("通す: %s", (original) => {
      expect(isDialogueOnly(original)).toBe(false);
    });

    test("検証の流れの中でも弾かれる", () => {
      const line = "「商人は打倒せぇへん。商人は商人らしく稼いだれ」";
      const result = validateProofreadIssues(
        {
          issues: [
            {
              line: 11,
              original: line,
              suggestion: "",
              reason: "同語反復",
              explanation: "「商人は」が繰り返されています",
              confidence: "medium",
            },
          ],
        },
        chunkOf(line)
      );

      expect(result.accepted).toHaveLength(0);
      expect(result.rejected[0].reason).toBe("dialogue_voice");
    });
  });

  test.each([
    "「なんか」が口語的で、やや唐突に感じます",
    "表現が文脈に合っていません",
    "リズムが単調です",
    "描写が物足りません",
  ])("説明が禁じた観点を語っていたら弾く: %s", (explanation) => {
    expect(mentionsForbiddenAspect(explanation)).toBe(true);
  });

  test.each([
    "同じ意味が重なっています",
    "修飾の関係が2通りに読めます",
    "「母さん」が近くで繰り返されています",
  ])("許した観点の説明は通す: %s", (explanation) => {
    expect(mentionsForbiddenAspect(explanation)).toBe(false);
  });

  test("札が正しくても、説明が文体の話なら弾く", () => {
    const result = validateProofreadIssues(
      {
        issues: [
          item({ explanation: "「なんか」が口語的で、文脈上やや唐突です" }),
        ],
      },
      chunk
    );

    expect(result.rejected[0].reason).toBe("forbidden_aspect");
  });
});

describe("修正案が無い提案", () => {
  test("修正案が空でも受け入れる", () => {
    // 長すぎる文をどう割るかは文体の書き換えになる。**それは作者が決めること**
    const result = validateProofreadIssues(
      { issues: [item({ suggestion: "" })] },
      chunk
    );

    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0].suggestion).toBe("");
  });

  test("原文が無ければ、やはり弾く", () => {
    // どこの話か分からない指摘は使えない
    expect(
      validateProofreadIssues({ issues: [item({ original: "" })] }, chunk)
        .rejected[0].reason
    ).toBe("shape");
  });
});

describe("出しすぎを切る", () => {
  test("1000字あたり3件まで", () => {
    expect(issueBudget(1000)).toBe(3);
    expect(issueBudget(4000)).toBe(12);
  });

  test("短い本文でも1件は挙げられる", () => {
    // 0件だと、短いチャンクでは何も指摘できなくなる
    expect(issueBudget(100)).toBe(1);
    expect(issueBudget(0)).toBe(1);
  });

  test("上限を超えたぶんを弾く", () => {
    // **ここが無いと、全部の文に提案が付いた状態が作者へ届く**
    const text = "あ".repeat(1000);
    const many = Array.from({ length: 10 }, (_, index) => ({
      line: 11,
      original: "あ".repeat(index + 2),
      suggestion: `直し${index}`,
      reason: "冗長",
      explanation: "",
      confidence: "high",
    }));

    const result = validateProofreadIssues({ issues: many }, chunkOf(text));

    expect(result.accepted).toHaveLength(3);
    expect(
      result.rejected.filter((entry) => entry.reason === "over_budget")
    ).toHaveLength(7);
  });

  test("切るときは確信度の高いものを残す", () => {
    // 迷っている提案だけが手元に来ては、質の低いものを読まされる
    const text = "あ".repeat(400); // 上限1件
    const issues = [
      {
        line: 11,
        original: "ああ",
        suggestion: "い",
        reason: "冗長",
        explanation: "",
        confidence: "low",
      },
      {
        line: 11,
        original: "あああ",
        suggestion: "う",
        reason: "冗長",
        explanation: "",
        confidence: "high",
      },
    ];

    const result = validateProofreadIssues({ issues }, chunkOf(text));

    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0].confidence).toBe("high");
  });
});

describe("理由の読み取り", () => {
  test("選択肢を写して返されても拾う", () => {
    // 矛盾検知で実際に起きた形（設計書6.10.1）
    expect(normalizeReason("冗長|同語反復|係り受け|長文")).toBe("冗長");
    expect(normalizeReason("同語反復：近い範囲で…")).toBe("同語反復");
  });

  test("知らない語は決めない", () => {
    expect(normalizeReason("語彙")).toBeUndefined();
    expect(normalizeReason("")).toBeUndefined();
  });
});

describe("並べ方", () => {
  test("確信度の高いものを上に", () => {
    const make = (
      confidence: "high" | "medium" | "low",
      line: number
    ): AcceptedProofreadIssue => ({
      line,
      original: "x",
      target: "x",
      suggestion: "y",
      reason: "冗長",
      explanation: "",
      confidence,
    });

    expect(
      sortProofreadIssues([make("low", 1), make("high", 2), make("medium", 3)])
        .map((entry) => entry.confidence)
    ).toEqual(["high", "medium", "low"]);
  });
});
