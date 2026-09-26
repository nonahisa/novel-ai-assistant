import { describe, expect, test } from "vitest";
import {
  deniesDeviation,
  normalizeType,
  parseDeviationResult,
  referencesPlot,
  salvageDeviationResult,
  sortDeviations,
  validateDeviations,
  type AcceptedDeviation,
} from "../../../src/core/deviationValidation";
import { deviationBudget } from "../../../src/prompts/deviationCheck";

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

/**
 * 2026-09-18、答え付きの台（`test/fixtures/seeded/deviation`）で測ったとき、
 * **gemma4:12b は仕込み3件とも場所を当てていたのに検算が全部落とした**（0/3）。
 * 同じ台で 26b は 3/3。**小さいモデルほどこの関門に落ちていた。**
 *
 * 作者の裁定は「2つともゆるめる」。そのとき実際に落ちた文字列を固定する。
 */
describe("2026-09-18 に検算が落としすぎていたもの", () => {
  /** 仕込み台のプロット（第3話の筋書きは「訪ね」） */
  const SEEDED_PLOT = [
    "## 主筋",
    "",
    "海斗の父は漁船で沖へ出たまま帰らない。海斗は、父の船が帰る道しるべになるはずの灯台がなぜ消えたのかを確かめ、もう一度灯をともすことを目指す。",
    "",
    "### 第3話　灯台守の話",
    "",
    "海斗と陽菜は町はずれの家を訪ね、灯台守の老人に会う。老人は灯を落としたのは自分だと認め、父の最後の航海について知っていることを話す。",
  ].join("\n");

  test("一文字の言い換え（訪れ／訪ね）でも根拠として通す", () => {
    expect(
      referencesPlot("海斗と陽菜は町はずれの家を訪れ、灯台守の老人に会う。", SEEDED_PLOT)
    ).toBe(true);
  });

  test("でっち上げた文は通さない", () => {
    // プロットのどこにも無い展開。言い換えを許しても、これは落ちる
    expect(
      referencesPlot("海斗は転校生とバンドを組み、文化祭で演奏する。", SEEDED_PLOT)
    ).toBe(false);
  });

  test("作者に確かめてほしいと書いただけなら、否定とは読まない", () => {
    // 実データでそのまま返ってきた理由文。「伏線」の語に当たって落ちていた
    expect(
      deniesDeviation(
        "バンド活動や文化祭に向けた準備の描写は、プロットの主筋に直接関わっているか判断が難しいため、意図的な伏線かどうかの確認が必要です。"
      )
    ).toBe(false);
  });

  test.each([
    "これは伏線かもしれないので、作者の確認が必要です",
    "掘り下げなのか逸脱なのか、判断がつきません",
    "テーマの補強かどうかは確かめてください",
  ])("問いかけ・保留は通す: %s", (reason) => {
    expect(deniesDeviation(reason)).toBe(false);
  });

  test.each([
    "これは伏線であるため、逸脱ではありません",
    "人物の掘り下げとして置かれています",
  ])("言い切って否定しているものは落とす: %s", (reason) => {
    expect(deniesDeviation(reason)).toBe(true);
  });

  test.each([
    "プロットに沿っていません",
    "第2話で置かれた伏線が回収されていません",
  ])("打ち消されている言い回しを、否定と取り違えない: %s", (reason) => {
    expect(deniesDeviation(reason)).toBe(false);
  });
});

/**
 * 2026-09-26 の逸脱の測り直し（教科書チートの写し。プロットの第1話の死因を「交通事故」に
 * 違えた）で、さくら Kimi-K2.6 が**食い違いを言い当てた指摘**を、検算が `self_denied` で
 * 落とした。理由の後ろに添えた「〜伏線として機能する可能性がある」に当たったためで、
 * 前半では「プロットでは〜だが、本文では〜」と**食い違いをはっきり言っている**。
 */
describe("食い違いを言い切ったうえで添えた一言を、否定と読まない", () => {
  test("実際に落ちた理由文（第1話の死因）", () => {
    expect(
      deniesDeviation(
        "プロットでは交通事故で死亡するが、本文では教室で心臓発作で倒れ、AEDを求める場面で保健の教科書がないというやり取りが追加されている。これは後の天使による教科書出現の伏線として機能する可能性がある。"
      )
    ).toBe(false);
  });

  test.each([
    "プロットではターナが問い詰めるが、本文ではマイナが問い詰めている。人物の掘り下げとして置かれた場面と思われる",
    "プロットと異なり、本文では父ではなくイントが残骸を持ち上げている。描写として追加されたものと考えられる",
  ])("食い違いを言い切っていれば通す: %s", (reason) => {
    expect(deniesDeviation(reason)).toBe(false);
  });

  test.each([
    // 言い切って打ち消しているものは、これまでどおり落とす
    "プロットでは交通事故だが、本文では心臓発作になっている。ただし逸脱ではありません",
    // 対比の形が無く、狙いだと決めつけているだけのもの（既存の網）
    "幽霊であることの描写として追加された可能性があります",
  ])("打ち消しや決めつけだけのものは、これまでどおり落とす: %s", (reason) => {
    expect(deniesDeviation(reason)).toBe(true);
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

/**
 * 「該当なし」を**配列の要素で**表してくる（残課題8。2026-09-22、さくらのAI
 * `preview/gemma-4-31B-it` の第11話）。excerpt・reason・plotReference が
 * すべて「（該当箇所なし）」、lineStart・lineEnd が 0 の要素だった。
 *
 * **指摘にも、検証で除外した件数にも数えない。** 除外に数えると、作者には
 * 「AIが何か挙げたが根拠が無かった」と読める。実際は「何も無い」と言っただけ。
 */
describe("該当なしを表す埋め草の要素", () => {
  const filler = {
    lineStart: 0,
    lineEnd: 0,
    excerpt: "（該当箇所なし）",
    type: "逸脱",
    reason: "（該当箇所なし）",
    plotReference: "（該当箇所なし）",
    severity: "low",
    confidence: "low",
  };

  test("実機の形は、指摘にも除外にも数えず、埋め草として数える", () => {
    const result = validateDeviations({ deviations: [filler] }, episode);

    expect(result.accepted).toHaveLength(0);
    expect(result.rejected).toHaveLength(0);
    expect(result.fillers).toBe(1);
  });

  test.each([
    "該当なし",
    "該当箇所なし",
    "なし",
    "特になし",
    "N/A",
    // **プロンプトに新しく書いた指示語**（「空の配列で返す」）が
    // そのまま返ってくる前提で押さえる（CLAUDE.md 失敗3）
    "空の配列",
    "（空の配列）",
  ])("引用が「%s」なら埋め草", (excerpt) => {
    const result = validateDeviations(
      { deviations: [item({ excerpt })] },
      episode
    );
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected).toHaveLength(0);
    expect(result.fillers).toBe(1);
  });

  test("行番号が0で、引用が本文に無ければ埋め草", () => {
    const result = validateDeviations(
      { deviations: [item({ lineStart: 0, lineEnd: 0, excerpt: "特に無し。" })] },
      episode
    );
    expect(result.fillers).toBe(1);
    expect(result.rejected).toHaveLength(0);
  });

  test("行番号が0でも、引用が本文に在るなら行の取り違え（これまでどおり除外に数える）", () => {
    // 中身のある指摘を黙って消さない。行を間違えただけかもしれないので、
    // 除外の件数として作者に見えるようにしておく
    const result = validateDeviations(
      { deviations: [item({ lineStart: 0 })] },
      episode
    );
    expect(result.fillers).toBe(0);
    expect(result.rejected[0].reason).toBe("line_out_of_range");
  });

  test("埋め草と本物が並んでいたら、本物だけを通す", () => {
    const result = validateDeviations(
      { deviations: [filler, item()] },
      episode
    );
    expect(result.accepted).toHaveLength(1);
    expect(result.fillers).toBe(1);
    expect(result.rejected).toHaveLength(0);
  });

  test("ふつうの指摘は埋め草に数えない", () => {
    expect(
      validateDeviations({ deviations: [item()] }, episode).fillers
    ).toBe(0);
  });
});

/**
 * 空白だけの行で埋まって切り詰められた応答から、閉じられるところまで読む。
 */
describe("空白で埋まった応答を救う", () => {
  const blank = "\n        ".repeat(3000);

  test("埋め草を閉じたあとで空白に入った応答は、救って0件になる", () => {
    const text =
      '{"deviations": [{"lineStart": 0, "lineEnd": 0, "excerpt": "（該当箇所なし）", ' +
      '"type": "逸脱", "reason": "（該当箇所なし）", "plotReference": "（該当箇所なし）", ' +
      '"severity": "low", "confidence": "low"}' +
      blank;

    // ふつうの読み方では読めない（閉じていない）
    expect(parseDeviationResult(text)).toBeNull();

    const salvaged = salvageDeviationResult(text);
    expect(salvaged?.deviations).toHaveLength(1);
    const result = validateDeviations(salvaged, episode);
    expect(result.accepted).toHaveLength(0);
    expect(result.fillers).toBe(1);
  });

  test("本物の指摘を書き終えてから空白に入ったなら、その指摘は残る", () => {
    const text = '{"deviations": [' + JSON.stringify(item()) + "," + blank;

    const result = validateDeviations(salvageDeviationResult(text), episode);
    expect(result.accepted).toHaveLength(1);
  });

  test("空白で埋まっていない応答は救わない（ふつうの切り詰めは失敗のまま）", () => {
    // 救いは「空白で埋まった」回に限る。ふつうの切り詰めを閉じて読むと、
    // 途中まで書いた指摘を読めたことにしてしまう
    const text =
      '{"deviations": [' + JSON.stringify(item()) + ', {"lineStart": 4';
    expect(salvageDeviationResult(text)).toBeNull();
  });

  test("閉じても形にならなければ null", () => {
    expect(salvageDeviationResult("{" + blank)).toBeNull();
  });
});
