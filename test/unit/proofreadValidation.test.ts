import { describe, expect, test } from "vitest";
import {
  explainProofreadReason,
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
import { issueBudget, PROOFREAD_REASONS } from "../../src/prompts/proofread";
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

/**
 * 1.5で足した2観点（設計書6.30）。
 *
 * 作者の創作論（読みやすさの技術）から起こしたもので、**先の4つのように
 * 実データの失敗から削り出した観点ではない。実モデルでの見逃し・誤検出は
 * まだ測っていない。** ここで確かめているのは「検証を素通りしないか」だけで、
 * AIがこの2つをどれだけ拾えるかは分かっていない。
 */
describe("漢字ひらき・語尾単調（1.5で追加）", () => {
  const kanji = chunkOf("所謂、彼は殆ど何も言わなかった。");

  test("漢字ひらきは、ひらがなの修正案ごと通る", () => {
    // 機械的に直せるので、修正案を書かせている
    const result = validateProofreadIssues(
      {
        issues: [
          {
            line: 11,
            original: "所謂",
            suggestion: "いわゆる",
            reason: "漢字ひらき",
            explanation: "「所謂（いわゆる）」で読みが詰まります",
            confidence: "high",
          },
        ],
      },
      kanji
    );

    expect(result.rejected).toEqual([]);
    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0].suggestion).toBe("いわゆる");
  });

  test("語尾単調は、修正案が空のまま通る", () => {
    // **どの文をどう変えるかは文体そのもの**なので、作者が決める
    const result = validateProofreadIssues(
      {
        issues: [
          {
            line: 12,
            original: "彼は歩いた。彼は走った。彼は止まった。",
            suggestion: "",
            reason: "語尾単調",
            explanation: "「〜た。」で終わる文が3連続です",
            confidence: "medium",
          },
        ],
      },
      chunk
    );

    expect(result.rejected).toEqual([]);
    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0].suggestion).toBe("");
  });

  /**
   * **作者が名指しで守った語は、新しい観点でも守られる。**
   * 推敲は原文まるごとを置き換えるので、守る語が原文に入っていれば
   * 必ず巻き込む。固有名詞・作品の造語をひらかれると作品が壊れる。
   */
  test.each([
    ["漢字ひらき", "所謂", "いわゆる"],
    ["語尾単調", "所謂", ""],
  ])("直さない語を含む %s の指摘は出さない", (reason, original, suggestion) => {
    const result = validateProofreadIssues(
      {
        issues: [
          {
            line: 11,
            original,
            suggestion,
            reason,
            explanation: "読みが詰まります",
            confidence: "high",
          },
        ],
      },
      kanji,
      [{ word: "所謂", note: "この作品の言い回し", addedAt: "2026-08-27" }]
    );

    expect(result.accepted).toHaveLength(0);
    expect(result.rejected[0].reason).toBe("kept_word");
  });

  test("札は増えたが、選択肢を写した返し方も拾える", () => {
    // 実データで起きた形（設計書6.10.1）。6つに増えても同じ
    expect(normalizeReason("漢字ひらき：読みが詰まります")).toBe("漢字ひらき");
    expect(normalizeReason("語尾単調")).toBe("語尾単調");
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

  test("決めた6種類以外の理由を弾く", () => {
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
    expect(normalizeReason("冗長|同語反復|係り受け|長文|漢字ひらき|語尾単調")).toBe(
      "冗長"
    );
    expect(normalizeReason("同語反復：近い範囲で…")).toBe("同語反復");
  });

  test("知らない語は決めない", () => {
    expect(normalizeReason("語彙")).toBeUndefined();
    expect(normalizeReason("")).toBeUndefined();
  });
});

/**
 * **札を足したのに決まり文句を足し忘れる**と、その種類だけ画面から
 * 説明が消える（AIが explanation を返さなかったときに何も出なくなる）。
 * 種類は増えていくので、1つずつ書き並べるのではなく、一覧から確かめる。
 */
describe("種類ごとの決まり文句", () => {
  test.each(PROOFREAD_REASONS)("%s には言葉がある", (reason) => {
    expect(explainProofreadReason(reason)).toBeTruthy();
  });

  test("推敲以外の種類には足さない", () => {
    // 誤字脱字の `reason` は説明そのものなので、重ねる言葉は無い
    expect(explainProofreadReason("誤字")).toBeUndefined();
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

/**
 * 新観点（1.5）の検収で入れた2つの防御（本体、2026-08-28）。
 *
 * 1. 語尾単調の説明としてモデルが自然に書くのは「リズムが単調」で、
 *    これが禁止語の網に掛かると**新観点の指摘が全部落ちる**。
 *    札そのものがその観点の話である場合だけ、その語を許す。
 * 2. 語尾単調の原文は複数文で、50字制限で途中まで切れていることがある。
 *    そこへ修正案が付くと切れた範囲がまるごと置き換わるので、コードで空にする。
 */
describe("新観点の説明と修正案の防御", () => {
  const chunk = {
    text: "彼は走った。彼は跳んだ。彼は飛んだ。彼は泳いだ。",
    startLine: 0,
    chapterStart: 1,
    chapterEnd: 1,
  } as never;

  test("語尾単調の説明の「リズム」は弾かない", () => {
    const { accepted, rejected } = validateProofreadIssues(
      {
        issues: [
          {
            line: 1,
            original: "彼は走った。彼は跳んだ。彼は飛んだ。",
            suggestion: "",
            reason: "語尾単調",
            explanation: "「〜た。」で終わる文が続き、リズムが単調です",
            confidence: "high",
          },
        ],
      },
      chunk
    );
    expect(rejected).toEqual([]);
    expect(accepted).toHaveLength(1);
  });

  test("語尾単調でも、文体そのものの話は弾いたまま", () => {
    const { accepted, rejected } = validateProofreadIssues(
      {
        issues: [
          {
            line: 1,
            original: "彼は走った。彼は跳んだ。彼は飛んだ。",
            suggestion: "",
            reason: "語尾単調",
            explanation: "文体が単調で、描写に工夫がありません",
            confidence: "high",
          },
        ],
      },
      chunk
    );
    expect(accepted).toEqual([]);
    expect(rejected[0]?.reason).toBe("forbidden_aspect");
  });

  test("冗長の説明の「リズム」は、これまでどおり弾く", () => {
    const { accepted, rejected } = validateProofreadIssues(
      {
        issues: [
          {
            line: 1,
            original: "彼は走った。彼は跳んだ。",
            suggestion: "",
            reason: "冗長",
            explanation: "リズムが悪く冗長です",
            confidence: "high",
          },
        ],
      },
      chunk
    );
    expect(accepted).toEqual([]);
    expect(rejected[0]?.reason).toBe("forbidden_aspect");
  });

  test("語尾単調に修正案が付いてきても、コードで空にする", () => {
    const { accepted } = validateProofreadIssues(
      {
        issues: [
          {
            line: 1,
            original: "彼は走った。彼は跳んだ。彼は飛んだ。",
            suggestion: "彼は走った。跳んだかと思えば、宙を飛ぶ。",
            reason: "語尾単調",
            explanation: "「〜た。」で終わる文が3連続です",
            confidence: "high",
          },
        ],
      },
      chunk
    );
    expect(accepted).toHaveLength(1);
    expect(accepted[0].suggestion).toBe("");
  });
});

/**
 * 常用漢字表との照合の注記（作者の指定、2026-08-28）。
 *
 * 判定はAIにさせない（表を正確に覚えていない）。コードで照合し、
 * **参考として**添える——ひらくかどうかは作者の判断が優先。
 */
describe("漢字ひらきへの常用漢字表の注記", () => {
  const chunk = {
    text: "悍ましい夜だった。然し彼は歩き続けた。",
    startLine: 0,
    chapterStart: 1,
    chapterEnd: 1,
  } as never;

  function acceptedOf(original: string, explanation: string) {
    return validateProofreadIssues(
      {
        issues: [
          {
            line: 1,
            original,
            suggestion: "",
            reason: "漢字ひらき",
            explanation,
            confidence: "high",
          },
        ],
      },
      chunk
    ).accepted;
  }

  test("表に無い字は、参考として説明に添えられる", () => {
    const accepted = acceptedOf(
      "悍ましい夜だった。",
      "「悍ましい（おぞましい）」で読みが詰まります"
    );
    expect(accepted).toHaveLength(1);
    expect(accepted[0].explanation).toContain("「悍」は常用漢字表");
    expect(accepted[0].explanation).toContain("平成22年内閣告示第2号");
  });

  test("表の字だけなら、注記は付かない", () => {
    const accepted = acceptedOf(
      "然し彼は歩き続けた。",
      "「然し（しかし）」で読みが詰まります"
    );
    expect(accepted).toHaveLength(1);
    expect(accepted[0].explanation).not.toContain("常用漢字表");
  });

  test("決まり文句に「作者の判断が優先」が入っている", () => {
    expect(explainProofreadReason("漢字ひらき")).toContain(
      "作者の判断が優先"
    );
  });
});
