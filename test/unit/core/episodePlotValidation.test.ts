import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  describeEpisodePlotRejects,
  parseEpisodePlotFindings,
  validateEpisodePlotCheck,
  validateEpisodePlotContrast,
} from "../../../src/core/episodePlotValidation";
import { EPISODE_PLOT_CHECK_KINDS } from "../../../src/prompts/episodePlotCheck";
import { EPISODE_PLOT_CONTRAST_KINDS } from "../../../src/prompts/episodePlotContrast";

/**
 * P-27・P-28 の応答の検証（設計書6.36.3）。
 *
 * **AIの出力を信用しない。** 指せない指摘（実在しない箇条書き・本文に
 * 無い引用・どこも指していないもの）は捨てる。捨てた件数は呼び出し側が
 * 報告に出すので、**黙って減らさない。**
 */

const ITEMS = [
  { text: "朝、兄の部屋を片付ける", line: 10 },
  { text: "形見の懐中時計を見つける", line: 11 },
  { text: "老人が訪ねてくる", line: 12 },
];

const TEXT = [
  "朝、兄の部屋を片付けた。",
  "窓の外で雨が降っていた。",
  "老人が訪ねてきた。",
].join("\n");

/** 目標の書かれた単話プロット（目標が空のときの扱いは下の describe で見る） */
const GOAL = "ミナが旅に出ると決める。";

function check(findings: unknown[], maxFindings = 5) {
  return validateEpisodePlotCheck(
    { findings },
    { items: ITEMS, goal: GOAL, maxFindings }
  );
}

function contrast(findings: unknown[], maxFindings = 5) {
  return validateEpisodePlotContrast(
    { findings },
    { items: ITEMS, text: TEXT, maxFindings }
  );
}

describe("応答の読み取り", () => {
  test("コードフェンス付きでも読める", () => {
    const parsed = parseEpisodePlotFindings(
      '```json\n{"findings": [{"item": "あ"}]}\n```'
    );
    expect(parsed?.findings).toHaveLength(1);
  });

  test("読めなければ null（0件と区別する）", () => {
    expect(parseEpisodePlotFindings("すみません、できません")).toBeNull();
  });
});

describe("P-27 展開の検査の検証", () => {
  test("実在する箇条書きを指した指摘は通り、行番号が付く", () => {
    const { accepted } = check([
      {
        item: "老人が訪ねてくる",
        kind: EPISODE_PLOT_CHECK_KINDS[0],
        reason: "目標へ繋がる働きが読めない。",
      },
    ]);

    expect(accepted).toHaveLength(1);
    expect(accepted[0].line).toBe(12);
    expect(accepted[0].item).toBe("老人が訪ねてくる");
  });

  test("箇条書きに実在しない対象は捨てる", () => {
    const { accepted, rejected } = check([
      {
        item: "王都で剣を買う",
        kind: EPISODE_PLOT_CHECK_KINDS[0],
        reason: "目標へ繋がらない。",
      },
    ]);

    expect(accepted).toHaveLength(0);
    expect(rejected[0].reason).toBe("item_not_found");
  });

  test("箇条書きの一部だけを写してきても、実在の行として拾う", () => {
    // 「- 」を落とす・末尾を省くといった写し方は普通に起きる。
    // **実在の行に収まっているなら、その行を指したものとして扱う**
    const { accepted } = check([
      {
        item: "懐中時計を見つける",
        kind: EPISODE_PLOT_CHECK_KINDS[1],
        reason: "前の行と同じ場面が続いている。",
      },
    ]);

    expect(accepted).toHaveLength(1);
    // 画面へ出すのは、AIが写した断片ではなく実在の行そのもの
    expect(accepted[0].item).toBe("形見の懐中時計を見つける");
  });

  test("3種のどれでもない種別は捨てる", () => {
    const { accepted, rejected } = check([
      {
        item: "老人が訪ねてくる",
        kind: "文章が下手",
        reason: "読みにくい。",
      },
    ]);

    expect(accepted).toHaveLength(0);
    expect(rejected[0].reason).toBe("unknown_kind");
  });

  test("種別に説明が付いて返ってきても拾う", () => {
    const { accepted } = check([
      {
        item: "老人が訪ねてくる",
        kind: `${EPISODE_PLOT_CHECK_KINDS[2]}（目標と噛み合わない）`,
        reason: "目標と逆を向いている。",
      },
    ]);

    expect(accepted).toHaveLength(1);
    expect(accepted[0].kind).toBe(EPISODE_PLOT_CHECK_KINDS[2]);
  });

  test("理由が空・中身の無い言葉なら捨てる", () => {
    const { accepted, rejected } = check([
      { item: "老人が訪ねてくる", kind: EPISODE_PLOT_CHECK_KINDS[0], reason: "" },
      {
        item: "老人が訪ねてくる",
        kind: EPISODE_PLOT_CHECK_KINDS[0],
        reason: "空文字",
      },
    ]);

    expect(accepted).toHaveLength(0);
    expect(rejected.map((entry) => entry.reason)).toEqual([
      "placeholder",
      "placeholder",
    ]);
  });

  test("同じ行への二重の指摘は1件だけ残す", () => {
    const { accepted } = check([
      {
        item: "老人が訪ねてくる",
        kind: EPISODE_PLOT_CHECK_KINDS[0],
        reason: "目標へ繋がらない。",
      },
      {
        item: "老人が訪ねてくる",
        kind: EPISODE_PLOT_CHECK_KINDS[0],
        reason: "同じことをもう一度。",
      },
    ]);

    expect(accepted).toHaveLength(1);
  });

  test("件数の上限を超えた分は捨てる（捨てた件数は残す）", () => {
    const { accepted, rejected } = check(
      ITEMS.map((item) => ({
        item: item.text,
        kind: EPISODE_PLOT_CHECK_KINDS[0],
        reason: "目標へ繋がらない。",
      })),
      2
    );

    expect(accepted).toHaveLength(2);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBe("over_budget");
  });

  test("形が違うものは捨てる", () => {
    const { accepted, rejected } = check(["ただの文字列", { kind: 3 }]);

    expect(accepted).toHaveLength(0);
    expect(rejected).toHaveLength(2);
  });
});

/**
 * 助言の構え（プロンプト設計書1.9、作者の方針 2026-09-24）。
 * 「無理に助言を言わなくてもいい。ほめることができる場所は、省略せずきちんとほめて」
 */
describe("P-27 良いところ（1.9）", () => {
  test("指摘0件＋良いところありの応答が通り、良いところは実在の行で残る", () => {
    const result = validateEpisodePlotCheck(
      {
        findings: [],
        strengths: [
          { item: "形見の懐中時計を見つける", why: "目標の手がかりが早めに置かれている" },
          // 一部だけ写してきても実在の行として拾う（指摘と同じ物差し）
          { item: "老人が訪ねて", why: "外から話を動かす出来事になっている" },
        ],
      },
      { items: ITEMS, goal: GOAL, maxFindings: 5 }
    );
    expect(result.accepted).toEqual([]);
    expect(result.rejected).toEqual([]);
    expect(result.strengths).toEqual([
      { quote: "形見の懐中時計を見つける", why: "目標の手がかりが早めに置かれている" },
      { quote: "老人が訪ねてくる", why: "外から話を動かす出来事になっている" },
    ]);
  });

  test("箇条書きに無い行をほめたものは落とし、数を残す", () => {
    const result = validateEpisodePlotCheck(
      {
        findings: [],
        strengths: [
          { item: "王都で剣を買う", why: "作り物" },
          { item: "朝、兄の部屋を片付ける", why: "日常から入っている" },
        ],
      },
      { items: ITEMS, goal: GOAL, maxFindings: 5 }
    );
    expect(result.strengths.map((item) => item.quote)).toEqual(["朝、兄の部屋を片付ける"]);
    expect(result.strengthsDropped).toBe(1);
  });

  test("理由が埋め草・出力例の言い換えなら、良いところにしない", () => {
    const result = validateEpisodePlotCheck(
      {
        findings: [],
        strengths: [
          { item: "朝、兄の部屋を片付ける", why: "特になし" },
          { item: "老人が訪ねてくる", why: "（効いている理由）" },
        ],
      },
      { items: ITEMS, goal: GOAL, maxFindings: 5 }
    );
    expect(result.strengths).toEqual([]);
  });

  test("良いところは件数の上限（maxFindings）で切らない", () => {
    const result = validateEpisodePlotCheck(
      {
        findings: [],
        strengths: ITEMS.map((item) => ({ item: item.text, why: "効いている" })),
      },
      { items: ITEMS, goal: GOAL, maxFindings: 1 }
    );
    expect(result.strengths).toHaveLength(3);
  });

  test("読み取りで良いところの欄を捨てない（キャッシュへ残る形）", () => {
    const parsed = parseEpisodePlotFindings(
      JSON.stringify({ findings: [], strengths: [{ item: "老人が訪ねてくる", why: "理由" }] })
    );
    expect(parsed).toEqual({
      findings: [],
      strengths: [{ item: "老人が訪ねてくる", why: "理由" }],
    });
  });
});

describe("P-28 本文との照合の検証", () => {
  test("本文に実在する引用は通り、行番号が付く", () => {
    const { accepted } = contrast([
      {
        kind: EPISODE_PLOT_CONTRAST_KINDS[0],
        plotItem: null,
        excerpt: "窓の外で雨が降っていた。",
        reason: "箇条書きに無い場面が入っている。",
      },
    ]);

    expect(accepted).toHaveLength(1);
    expect(accepted[0].line).toBe(2);
    expect(accepted[0].plotItem).toBeNull();
  });

  test("本文に無い引用は捨てる（P-11と同じ流儀）", () => {
    const { accepted, rejected } = contrast([
      {
        kind: EPISODE_PLOT_CONTRAST_KINDS[0],
        plotItem: null,
        excerpt: "ミナは剣を抜いた。",
        reason: "箇条書きに無い。",
      },
    ]);

    expect(accepted).toHaveLength(0);
    expect(rejected[0].reason).toBe("excerpt_not_found");
  });

  test("箇条書きに無い行を指したものは捨てる", () => {
    const { accepted, rejected } = contrast([
      {
        kind: EPISODE_PLOT_CONTRAST_KINDS[1],
        plotItem: "王都へ向かう",
        excerpt: null,
        reason: "書かれていない。",
      },
    ]);

    expect(accepted).toHaveLength(0);
    expect(rejected[0].reason).toBe("plot_item_not_found");
  });

  test("箇条書きだけを指す指摘（起きていない）は通る", () => {
    const { accepted } = contrast([
      {
        kind: EPISODE_PLOT_CONTRAST_KINDS[1],
        plotItem: "形見の懐中時計を見つける",
        excerpt: null,
        reason: "本文にこの場面が見当たらない。",
      },
    ]);

    expect(accepted).toHaveLength(1);
    expect(accepted[0].excerpt).toBeNull();
    expect(accepted[0].plotLine).toBe(11);
  });

  test("どちらも指していない指摘は捨てる（読みようが無い）", () => {
    const { accepted, rejected } = contrast([
      {
        kind: EPISODE_PLOT_CONTRAST_KINDS[2],
        plotItem: null,
        excerpt: null,
        reason: "順番が違う。",
      },
    ]);

    expect(accepted).toHaveLength(0);
    expect(rejected[0].reason).toBe("nothing_pointed");
  });

  test("段落をまるごと写した引用は捨てる", () => {
    const long = "あ".repeat(200);
    const { accepted, rejected } = contrast([
      {
        kind: EPISODE_PLOT_CONTRAST_KINDS[0],
        plotItem: null,
        excerpt: long,
        reason: "箇条書きに無い。",
      },
    ]);

    expect(accepted).toHaveLength(0);
    expect(rejected[0].reason).toBe("excerpt_too_long");
  });

  test("理由が中身の無い言葉なら捨てる", () => {
    const { accepted, rejected } = contrast([
      {
        kind: EPISODE_PLOT_CONTRAST_KINDS[0],
        plotItem: null,
        excerpt: "窓の外で雨が降っていた。",
        reason: "該当なし",
      },
    ]);

    expect(accepted).toHaveLength(0);
    expect(rejected[0].reason).toBe("placeholder");
  });
});

/**
 * 「順序の食い違い」は、**入れ替わった相手が無くても落とさない**
 * （作者の判断、2026-09-25「拾う方」。プロンプト 1.2）。
 *
 * 1.1 では相手の行と2つの引用を必須にし、前後が本当に逆のときだけ通した。
 * 対照の誤検出は消えたが、本物の入れ替えを拾う数が落ちた（26b 15/19 → 12/19、
 * e4b 7/19 → 1/19）。**誤検出は残ってよいから、本物の入れ替えを落とさない。**
 *
 * 相手の欄は任意で、**書かれていれば提案パネルに添えるだけ**。
 * 落とす判定には使わない。
 */
describe("P-28 順序の食い違いは、相手が無くても落とさない（拾う方）", () => {
  /** 箇条書きでは「朝、兄の部屋」が先だが、本文では老人が先に来る */
  const SWAPPED_TEXT = [
    "老人が訪ねてきた。",
    "窓の外で雨が降っていた。",
    "朝、兄の部屋を片付けた。",
  ].join("\n");

  function contrastSwapped(findings: unknown[], maxFindings = 5) {
    return validateEpisodePlotContrast(
      { findings },
      { items: ITEMS, text: SWAPPED_TEXT, maxFindings }
    );
  }

  test("相手の欄の無い答え（1.0・1.2 の形）はそのまま通る", () => {
    const { accepted, rejected } = contrastSwapped([
      {
        kind: "順序の食い違い",
        plotItem: "朝、兄の部屋を片付ける",
        excerpt: "朝、兄の部屋を片付けた。",
        reason: "片付けが後ろに回っている。",
      },
    ]);

    expect(rejected).toEqual([]);
    expect(accepted).toHaveLength(1);
    expect(accepted[0]).toMatchObject({
      kind: "順序の食い違い",
      plotLine: 10,
      line: 3,
      swappedItem: null,
      swappedExcerpt: null,
    });
  });

  test("相手が書かれていれば、実在の行と本文の位置を添える", () => {
    const { accepted } = contrastSwapped([
      {
        kind: "順序の食い違い",
        plotItem: "朝、兄の部屋を片付ける",
        excerpt: "朝、兄の部屋を片付けた。",
        swappedItem: "老人が訪ねてくる",
        swappedExcerpt: "老人が訪ねてきた。",
        reason: "箇条書きでは片付けが先だが、本文では老人の訪問が先に来る。",
      },
    ]);

    expect(accepted[0]).toMatchObject({
      swappedItem: "老人が訪ねてくる",
      swappedPlotLine: 12,
      swappedExcerpt: "老人が訪ねてきた。",
      swappedLine: 1,
    });
  });

  test("本文でも同じ順に見えても落とさない（前後の判定はしない）", () => {
    // 1.1 ではここを落とした。どの引用がどの行に当たるかはコードでは
    // 確かめられず、26b の本物の入れ替えを2話この形で落としていた
    const { accepted, rejected } = contrast([
      {
        kind: "順序の食い違い",
        plotItem: "老人が訪ねてくる",
        excerpt: "老人が訪ねてきた。",
        swappedItem: "朝、兄の部屋を片付ける",
        swappedExcerpt: "朝、兄の部屋を片付けた。",
        reason: "老人の訪問は、この後に続く場面と関連しているため。",
      },
    ]);

    expect(rejected).toEqual([]);
    expect(accepted).toHaveLength(1);
  });

  test.each([
    ["相手の行が箇条書きに無い", "王都へ向かう", "老人が訪ねてきた。"],
    ["相手が自分の行と同じ", "朝、兄の部屋を片付ける", "朝、兄の部屋を片付けた。"],
  ])("%s相手は添えないが、指摘は残す", (_label, swappedItem, swappedExcerpt) => {
    const { accepted, rejected } = contrastSwapped([
      {
        kind: "順序の食い違い",
        plotItem: "朝、兄の部屋を片付ける",
        excerpt: "朝、兄の部屋を片付けた。",
        swappedItem,
        swappedExcerpt,
        reason: "片付けが後ろに回っている。",
      },
    ]);

    expect(rejected).toEqual([]);
    expect(accepted[0].swappedItem).toBeNull();
    expect(accepted[0].swappedExcerpt).toBeNull();
  });

  test("相手の引用が本文に無ければ、引用だけ添えない（本文に無い文を作者に読ませない）", () => {
    const { accepted } = contrastSwapped([
      {
        kind: "順序の食い違い",
        plotItem: "朝、兄の部屋を片付ける",
        excerpt: "朝、兄の部屋を片付けた。",
        swappedItem: "老人が訪ねてくる",
        swappedExcerpt: "老人が玄関の戸を叩いた。",
        reason: "片付けが後ろに回っている。",
      },
    ]);

    expect(accepted[0]).toMatchObject({
      swappedItem: "老人が訪ねてくる",
      swappedExcerpt: null,
      swappedLine: null,
    });
  });

  test("相手の欄は、順序以外の種別には添えない", () => {
    const { accepted } = contrast([
      {
        kind: "箇条書きに無い",
        plotItem: null,
        excerpt: "窓の外で雨が降っていた。",
        swappedItem: "老人が訪ねてくる",
        swappedExcerpt: "老人が訪ねてきた。",
        reason: "雨の場面は箇条書きに無い。",
      },
    ]);

    expect(accepted[0].swappedItem).toBeNull();
  });

  test("同じ2行の組を、向きを変えて二度挙げても1件にする", () => {
    const pair = {
      kind: "順序の食い違い",
      reason: "片付けと老人の訪問が入れ替わっている。",
    };
    const { accepted, rejected } = contrastSwapped([
      {
        ...pair,
        plotItem: "朝、兄の部屋を片付ける",
        excerpt: "朝、兄の部屋を片付けた。",
        swappedItem: "老人が訪ねてくる",
        swappedExcerpt: "老人が訪ねてきた。",
      },
      {
        ...pair,
        plotItem: "老人が訪ねてくる",
        excerpt: "老人が訪ねてきた。",
        swappedItem: "朝、兄の部屋を片付ける",
        swappedExcerpt: "朝、兄の部屋を片付けた。",
      },
    ]);

    expect(accepted).toHaveLength(1);
    expect(rejected[0].reason).toBe("duplicate");
  });

  describe("起きていない出来事に「順序の食い違い」の札を付けた答え", () => {
    /*
      e4b の仕込み（第1・4・7・14話）：足した出来事「ギルド長が突然辞任を発表し、
      ホンゴーが後任に指名される」に「順序の食い違い」を付け、引用は null、理由は
      「本文中でギルド長や後任指名に関する記述は見当たらない」。**中身は
      「起きていない」の指摘**なので、札を付け替えて通す（仕込みの見逃しを増やさない）
    */
    test("引用が空で、理由が「見当たらない」なら「起きていない」へ付け替える", () => {
      const { accepted, rejected } = contrast([
        {
          kind: "順序の食い違い",
          plotItem: "形見の懐中時計を見つける",
          excerpt: null,
          swappedItem: null,
          swappedExcerpt: null,
          reason: "本文中で懐中時計を見つけることに関する記述は見当たらない。",
        },
      ]);

      expect(rejected).toEqual([]);
      expect(accepted).toHaveLength(1);
      expect(accepted[0]).toMatchObject({
        // 1.3 で「起きていない」は「出来事の欠落」へ名前を替えた（同じ観点）
        kind: "出来事の欠落",
        plotItem: "形見の懐中時計を見つける",
        plotLine: 11,
        excerpt: null,
        line: null,
        swappedItem: null,
      });
    });

    test.each([
      "本文中でギルド長の辞任やホンゴーの後任指名は確認できない。",
      "本文中には、懐中時計を見つけたという記述がない。",
      "懐中時計を見つける場面は描かれていない。",
    ])("言い方が違っても付け替える：%s", (reason) => {
      const { accepted } = contrast([
        {
          kind: "順序の食い違い",
          plotItem: "形見の懐中時計を見つける",
          excerpt: null,
          swappedItem: null,
          swappedExcerpt: null,
          reason,
        },
      ]);

      expect(accepted[0]?.kind).toBe("出来事の欠落");
    });

    test("付け替えたものが、同じ行の「起きていない」と重なれば1件にする", () => {
      const { accepted, rejected } = contrast([
        {
          // 1.2 までの名前のまま返ってきても、「出来事の欠落」として読む
          kind: "起きていない",
          plotItem: "形見の懐中時計を見つける",
          excerpt: null,
          reason: "本文に懐中時計の場面が無い。",
        },
        {
          kind: "順序の食い違い",
          plotItem: "形見の懐中時計を見つける",
          excerpt: null,
          reason: "懐中時計に関する記述は見当たらない。",
        },
      ]);

      expect(accepted).toHaveLength(1);
      expect(rejected[0].reason).toBe("duplicate");
    });

    /*
      26b の仕込み（1.1 の測定、第3・14話）：足した出来事に「箇条書きに無い」を
      付け、plotItem にその行、引用は null、理由は「記述が本文にないため」。
      「箇条書きに無い」は本文の場面を引くはずの種別で、引用が無いのは形が
      合わない。中身は「起きていない」なので同じく付け替える
    */
    test("「箇条書きに無い」の札でも、引用が空で「本文にない」と言い切っていれば付け替える（26b の実物）", () => {
      const { accepted } = contrast([
        {
          kind: "箇条書きに無い",
          plotItem: "形見の懐中時計を見つける",
          excerpt: null,
          swappedItem: null,
          swappedExcerpt: null,
          reason: "懐中時計を見つけることに関する記述が本文にないため。",
        },
      ]);

      expect(accepted).toHaveLength(1);
      expect(accepted[0].kind).toBe("出来事の欠落");
      expect(accepted[0].plotLine).toBe(11);
    });

    test("箇条書きの行を指していなければ付け替えない（何が起きていないのか分からない）", () => {
      const { accepted, rejected } = contrast([
        {
          kind: "箇条書きに無い",
          plotItem: null,
          excerpt: null,
          reason: "本文に記述がない。",
        },
      ]);

      expect(accepted).toEqual([]);
      expect(rejected[0].reason).toBe("nothing_pointed");
    });

    test("引用があるなら付け替えない（本文に場面があるのに「起きていない」とは言えない）", () => {
      const { accepted, rejected } = contrast([
        {
          kind: "順序の食い違い",
          plotItem: "老人が訪ねてくる",
          excerpt: "老人が訪ねてきた。",
          swappedItem: null,
          swappedExcerpt: null,
          reason: "老人の訪問の前に、雨の描写は見当たらない。",
        },
      ]);

      expect(rejected).toEqual([]);
      expect(accepted[0].kind).toBe("順序の食い違い");
    });

    test("引用が空でも、理由が「無い」と言っていなければ付け替えない", () => {
      // 前後の話をしているのに引用を書かなかっただけ。順序の指摘のまま残す（拾う方）
      const { accepted, rejected } = contrast([
        {
          kind: "順序の食い違い",
          plotItem: "形見の懐中時計を見つける",
          excerpt: null,
          swappedItem: null,
          swappedExcerpt: null,
          reason: "懐中時計の場面が、老人の訪問より後に来ている。",
        },
      ]);

      expect(rejected).toEqual([]);
      expect(accepted[0].kind).toBe("順序の食い違い");
    });
  });
});

/**
 * 理由の中で、自分の指摘を打ち消している答え（実機確認 2026-09-25 深夜、
 * gemma4:e4b・ギルドの19話）。
 *
 * 箇条書きどおりに書いた話（対照）に「順序の食い違い」を挙げ、理由に
 * 「**順序は合致しているが**、本文の描写がより詳細」と書いてきた。
 * 自分で食い違っていないと言っている指摘は、作者に出さない
 * （矛盾検知の `self_denied` と同じ考え）。
 *
 * **ただし網は絞る。** 矛盾検知では「一致して**いるか**確認が必要」
 * （疑問）や「一致して**いるため**」（理由）まで打ち消しと読み、
 * 仕込みの正解を落とした（0.86.1 で直した。縛りの洗い出し1番）。
 * ここで落とすのは「順序（流れ）は一致している」「食い違いはない」と
 * **言い切った**形だけにする。
 */
describe("P-28 理由で自分の指摘を打ち消している答え", () => {
  /** 第9話の箇条書きと本文（照合に要る2行だけ。写しのまま） */
  const CH9_ITEMS = [
    {
      text: "ホンゴーがウィズの失踪廃止のケース記録を綴ると、メアリーがやってきて父の不在による生活の変化を語る。",
      line: 9,
    },
    {
      text: "その後、ギルマスからの呼び出しを告げられたホンゴーは、メアリーから食事に誘われるが、受給者の関係者という理由で断るのだった。",
      line: 10,
    },
  ];
  const CH9_TEXT = [
    "「お父さんの記録ですか？」",
    "\t部署の違うメアリーさんが、後ろから声をかけてくる。",
    "「あ、そうそう。ギルマスがホンゴーさんを呼んでこいって」",
  ].join("\n");

  function contrast9(findings: unknown[]) {
    return validateEpisodePlotContrast(
      { findings },
      { items: CH9_ITEMS, text: CH9_TEXT, maxFindings: 5 }
    );
  }

  test("「順序は合致しているが」と書いた順序の食い違いは落とす（e4b の実物の答え）", () => {
    const { accepted, rejected } = contrast9([
      {
        kind: "順序の食い違い",
        plotItem: CH9_ITEMS[0].text,
        excerpt: "「お父さんの記録ですか？」\n\t部署の違うメアリーさんが、後ろから声をかけてくる。",
        reason:
          "本文では、ケース記録を綴った後にメアリーが声をかけているため、順序は合致しているが、本文の描写がより詳細。",
      },
    ]);

    expect(accepted).toEqual([]);
    expect(rejected[0].reason).toBe("self_denied");
  });

  test("「流れは本文の描写と一致している」と書いた順序の食い違いも落とす（e4b の実物の理由）", () => {
    // 実物は引用が2行をつないだ形で本文照合に落ちていた。理由の形だけを見る
    const { rejected } = contrast9([
      {
        kind: "順序の食い違い",
        plotItem: CH9_ITEMS[1].text,
        excerpt: "「あ、そうそう。ギルマスがホンゴーさんを呼んでこいって」",
        reason:
          "ギルマスからの呼び出しは本文で発生しているが、メアリーからの誘いと断りの流れは本文の描写と一致している。",
      },
    ]);

    expect(rejected[0].reason).toBe("self_denied");
  });

  test("「食い違いはない」と言い切った指摘は、種別を問わず落とす", () => {
    const { rejected } = contrast([
      {
        kind: EPISODE_PLOT_CONTRAST_KINDS[1],
        plotItem: "老人が訪ねてくる",
        excerpt: null,
        reason: "本文との食い違いはありません。",
      },
    ]);

    expect(rejected[0].reason).toBe("self_denied");
  });

  describe("落としすぎない（矛盾検知で本物を落とした形）", () => {
    test("疑問の形（一致しているか）は打ち消しと読まない", () => {
      const { accepted } = contrast9([
        {
          kind: "順序の食い違い",
          plotItem: CH9_ITEMS[1].text,
          excerpt: "「あ、そうそう。ギルマスがホンゴーさんを呼んでこいって」",
          reason: "呼び出しと食事の誘いの順序が一致しているか、確かめてほしい。",
        },
      ]);

      expect(accepted).toHaveLength(1);
    });

    test("理由の形（一致しているため）は打ち消しと読まない", () => {
      const { accepted } = contrast9([
        {
          kind: "順序の食い違い",
          plotItem: CH9_ITEMS[1].text,
          excerpt: "「あ、そうそう。ギルマスがホンゴーさんを呼んでこいって」",
          reason:
            "前半の流れは一致しているため目立たないが、食事の誘いが呼び出しより前に描かれている。",
        },
      ]);

      expect(accepted).toHaveLength(1);
    });

    test("打ち消しと一緒に、入れ替わりを言い切っていれば残す", () => {
      const { accepted } = contrast9([
        {
          kind: "順序の食い違い",
          plotItem: CH9_ITEMS[1].text,
          excerpt: "「あ、そうそう。ギルマスがホンゴーさんを呼んでこいって」",
          reason:
            "前半の順序は合致しているが、食事の誘いと呼び出しは箇条書きと逆になっている。",
        },
      ]);

      expect(accepted).toHaveLength(1);
    });

    test("順序の話は、ほかの種別の打ち消しにならない", () => {
      // 「箇条書きに無い」の理由で順序に触れても、無い場面の指摘は生きている
      const { accepted } = contrast9([
        {
          kind: "箇条書きに無い",
          plotItem: null,
          excerpt: "\t部署の違うメアリーさんが、後ろから声をかけてくる。",
          reason: "順序は合致しているが、声をかける場面は箇条書きに無い。",
        },
      ]);

      expect(accepted).toHaveLength(1);
    });

    test("26b が挙げた本物の順序の食い違いは残す（実物の答え）", () => {
      const { accepted } = validateEpisodePlotContrast(
        {
          findings: [
            {
              kind: "順序の食い違い",
              plotItem: "受付のスタッフが驚きの声を上げ、ホンゴーが「メアリーでなくても良い」と伝える。",
              excerpt: "「いや、メアリーさんでなくても良いんですけど……」",
              reason: "スタッフの驚きの声が、ホンゴーのセリフよりも前に描かれているため。",
            },
          ],
        },
        {
          items: [
            {
              text: "受付のスタッフが驚きの声を上げ、ホンゴーが「メアリーでなくても良い」と伝える。",
              line: 10,
            },
          ],
          text: "キャーという黄色い悲鳴が様子をうかがう受付担当たちから聞こえてきた。\n「いや、メアリーさんでなくても良いんですけど……」",
          maxFindings: 5,
        }
      );

      expect(accepted).toHaveLength(1);
    });
  });
});

/**
 * 目標が空の単話プロットに「目標に向かっていない」を出す答え
 * （実機確認 2026-09-25 深夜、gemma4:e4b・ギルドの19話。19話とも目標の節が空）。
 *
 * 理由は「**目標が不明なため**、この展開が目標にどう繋がるか判断できません」。
 * プロンプトには「目標が書かれていないときは判断できません」と書いてあったが、
 * e4b は11件これを出した。**照らす目標が無いのだから、その観点の指摘は
 * 成り立たない**——コードで外す（プロンプトからもその観点を外した）。
 */
describe("P-27 目標が空のときは、目標の観点の指摘を出さない", () => {
  /** 第11話の箇条書き（写しのまま） */
  const CH11_ITEMS = [
    { text: "ホンゴーの部下として、異世界人のハルトが事務室にやってくる。", line: 9 },
    {
      text: "日本語を話すハルトは、自身の異能や帝国での経緯を語り、生活保護のケースワーカーとして働くことに不満を漏らしつつも、引き受けるのだった。",
      line: 10,
    },
  ];
  /** e4b の実物の答え（第11話） */
  const E4B_CH11 = [
    {
      item: "ホンゴーの部下として、異世界人のハルトが事務室にやってくる。",
      kind: "目標に向かっていない",
      reason: "この時点では、目標が不明なため、この展開が目標にどう繋がるか判断できません。",
    },
    {
      item: "日本語を話すハルトは、自身の異能や帝国での経緯を語り、生活保護のケースワーカーとして働くことに不満を漏らしつつも、引き受けるのだった。",
      kind: "目標に向かっていない",
      reason: "目標が不明なため、この展開が目標にどう繋がるか判断できません。",
    },
  ];

  test("目標が空なら「目標に向かっていない」は落とす（e4b の実物の答え）", () => {
    const { accepted, rejected } = validateEpisodePlotCheck(
      { findings: E4B_CH11 },
      { items: CH11_ITEMS, goal: "", maxFindings: 5 }
    );

    expect(accepted).toEqual([]);
    expect(rejected.map((entry) => entry.reason)).toEqual(["no_goal", "no_goal"]);
  });

  test("目標が空なら「目標と矛盾」も落とす（空白だけの目標も空とみなす）", () => {
    const { rejected } = validateEpisodePlotCheck(
      {
        findings: [
          { item: CH11_ITEMS[0].text, kind: "目標と矛盾", reason: "目標と逆を向いている。" },
        ],
      },
      { items: CH11_ITEMS, goal: " \n　", maxFindings: 5 }
    );

    expect(rejected[0].reason).toBe("no_goal");
  });

  test("目標が空でも、停滞・重複は目標が要らないので残す（e4b の実物の答え、第18話）", () => {
    const { accepted } = validateEpisodePlotCheck(
      {
        findings: [
          {
            item: "その後、ハルトと共に金髪美人の被保護者ジャンヌのケース記録を確認し、療養指導や就労指導について話し合う。",
            kind: "停滞・重複",
            reason:
              "前の項目で「線引きの重要性」というテーマが提示された直後に、具体的なケース記録の確認という作業に移行しており、テーマの深掘りという点で重複感がある可能性があります。",
          },
        ],
      },
      {
        items: [
          {
            text: "その後、ハルトと共に金髪美人の被保護者ジャンヌのケース記録を確認し、療養指導や就労指導について話し合う。",
            line: 10,
          },
        ],
        goal: "",
        maxFindings: 5,
      }
    );

    expect(accepted).toHaveLength(1);
  });

  test("目標が書いてあれば、目標に向かっていないは通す", () => {
    const { accepted } = validateEpisodePlotCheck(
      {
        findings: [
          {
            item: CH11_ITEMS[0].text,
            kind: "目標に向かっていない",
            reason: "ハルトが働くと決める流れに、この場面が繋がって見えない。",
          },
        ],
      },
      { items: CH11_ITEMS, goal: "ハルトが生活保護課で働くと決める。", maxFindings: 5 }
    );

    expect(accepted).toHaveLength(1);
  });
});

/**
 * **読むだけの機能である**（設計書6.36.3）。
 *
 * 単話プロットは作者が書くもので、AIに直させない（6.36.2）。
 * 書き込む道が紛れ込んでいないことを、機械で留める。
 */
describe("原稿にもプロットにも書き込まない", () => {
  const source = readFileSync("src/features/checkEpisodePlot.ts", "utf-8");

  test("書き込みの口を呼ばない", () => {
    for (const forbidden of [
      "atomicWriteFile",
      "writeTextFilePreservingFormat",
      "workspace.fs.writeFile",
      "applyEdit",
    ]) {
      expect(source, forbidden).not.toContain(forbidden);
    }
  });

  test("修正案を作らせる道が無い", () => {
    // プロンプト側にも欄は無いが、こちら側で組み立てないことも留める
    expect(source).not.toContain("suggestion");
  });
});

describe("捨てた理由の内訳", () => {
  test("件数だけでなく、種類ごとに数える", () => {
    const text = describeEpisodePlotRejects([
      { reason: "item_not_found" },
      { reason: "item_not_found" },
      { reason: "placeholder" },
    ]);

    expect(text).toContain("2件");
    expect(text).toContain("1件");
  });

  test("0件なら空文字（黙って何も言わない）", () => {
    expect(describeEpisodePlotRejects([])).toBe("");
  });
});

/**
 * 箇条書きの行を、番号ごと写して返す（2026-09-25 の測定、gemma4:e4b・ギルドの19話）。
 *
 * P-28 は順序を見るため箇条書きに番号を振って渡している（「1. 〜」）。e4b は
 * plotItem に「2. 受付嬢のメアリーが〜」と**番号ごと**写して返し、1.2 の測定で
 * 18件が「箇条書きに無い行を指した」として落ちた（仕込みの第8話を含む）。
 * 行の中身は実在の行そのものなので、番号を外して照らす。
 */
describe("P-28 番号ごと写した箇条書きの行", () => {
  test.each([
    "2. 形見の懐中時計を見つける",
    "２．形見の懐中時計を見つける",
    "2) 形見の懐中時計を見つける",
    "2、形見の懐中時計を見つける",
  ])("番号を外して実在の行に当てる：%s", (plotItem) => {
    const { accepted, rejected } = contrast([
      {
        kind: EPISODE_PLOT_CONTRAST_KINDS[1],
        plotItem,
        excerpt: null,
        reason: "本文に懐中時計の場面が見当たらない。",
      },
    ]);

    expect(rejected).toEqual([]);
    expect(accepted[0]).toMatchObject({
      plotItem: "形見の懐中時計を見つける",
      plotLine: 11,
    });
  });

  test("番号を外しても実在しない行なら、これまでどおり捨てる", () => {
    const { rejected } = contrast([
      {
        kind: EPISODE_PLOT_CONTRAST_KINDS[1],
        plotItem: "2. 王都へ向かう",
        excerpt: null,
        reason: "本文に見当たらない。",
      },
    ]);

    expect(rejected[0].reason).toBe("plot_item_not_found");
  });

  test("数字で始まる行そのもの（「3日後、〜」）は、番号と取り違えない", () => {
    const items = [...ITEMS, { text: "3日後、老人がまた来る", line: 13 }];
    const { accepted } = validateEpisodePlotContrast(
      {
        findings: [
          {
            kind: EPISODE_PLOT_CONTRAST_KINDS[1],
            plotItem: "3日後、老人がまた来る",
            excerpt: null,
            reason: "本文に見当たらない。",
          },
        ],
      },
      { items, text: TEXT, maxFindings: 5 }
    );

    expect(accepted[0]?.plotLine).toBe(13);
  });
});

/**
 * 台詞の途中から引いて、頭に「「」を足して返す（2026-09-25 の測定。1.2 の答えで
 * e4b の「本文に無い引用」7件中7件、26b の8件中4件がこの形）。
 *
 * 本文「「ぷはっ。やっぱ仕事のあとの酒はうめぇな。そうそう、うちの徒弟の〜」」に対し、
 * 引用が「「そうそう、うちの徒弟の〜」」。**かっこの内側は本文そのまま**なので、
 * 外側のかぎかっこを外して本文に当てる（外した形を引用として残す）。
 */
describe("P-28 台詞の途中から引いて、かぎかっこを足した引用", () => {
  const SPEECH = [
    "「ぷはっ。やっぱ仕事のあとの酒はうめぇな。そうそう、うちの徒弟に言っといたから」",
    "僕はそうならないための仕組みとして、制度を提案した。",
  ].join("\n");

  function speech(excerpt: string) {
    return validateEpisodePlotContrast(
      {
        findings: [
          {
            kind: EPISODE_PLOT_CONTRAST_KINDS[2],
            plotItem: "老人が訪ねてくる",
            excerpt,
            reason: "この場面は、老人の訪問より前に描かれている。",
          },
        ],
      },
      { items: ITEMS, text: SPEECH, maxFindings: 5 }
    );
  }

  test.each([
    ["「そうそう、うちの徒弟に言っといたから」", "そうそう、うちの徒弟に言っといたから", 1],
    ["「そうそう、うちの徒弟に", "そうそう、うちの徒弟に", 1],
    ["『僕はそうならないための仕組みとして』", "僕はそうならないための仕組みとして", 2],
  ])("かっこを外して本文に当てる：%s", (excerpt, grounded, line) => {
    const { accepted, rejected } = speech(excerpt);

    expect(rejected).toEqual([]);
    expect(accepted[0]).toMatchObject({ excerpt: grounded, line });
  });

  test("本文にそのままあるなら、かっこも含めて写したまま残す", () => {
    const { accepted } = speech(
      "「ぷはっ。やっぱ仕事のあとの酒はうめぇな。そうそう、うちの徒弟に言っといたから」"
    );

    expect(accepted[0]?.excerpt).toBe(
      "「ぷはっ。やっぱ仕事のあとの酒はうめぇな。そうそう、うちの徒弟に言っといたから」"
    );
  });

  test("かっこを外しても本文に無ければ、これまでどおり捨てる", () => {
    const { rejected } = speech("「王都へ向かおう」");
    expect(rejected[0].reason).toBe("excerpt_not_found");
  });

  test("かっこを外すと短すぎる（4字未満）なら当てない", () => {
    const { rejected } = speech("「そうそ」");
    expect(rejected[0].reason).toBe("excerpt_not_found");
  });
});

/**
 * 起きていない出来事を、箇条書きの欄ではなく**引用の欄**に写して返す
 * （2026-09-25 の測定、gemma4:26b・仕込みの第1話。1.0 から続く見逃し1件）。
 *
 * 足した出来事「ギルド長が突然辞任を発表し、ホンゴーが後任に指名される」を
 * excerpt に写し、kind は「箇条書きに無い」、理由は「〜場面が本文に存在しないため」。
 * 本文に無い引用として落ち、仕込みを見逃していた。中身は「出来事の欠落」なので、
 * **引用が箇条書きの行と一致し、本文には無く、理由が「無い」と言い切っていれば**付け替える。
 */
describe("P-28 箇条書きの行を引用の欄に写した「起きていない」", () => {
  test("引用が箇条書きの行で、理由が「本文に存在しない」なら「出来事の欠落」へ付け替える（26b の実物）", () => {
    const { accepted, rejected } = contrast([
      {
        kind: "箇条書きに無い",
        plotItem: null,
        excerpt: "形見の懐中時計を見つける",
        reason: "懐中時計を見つける場面が本文に存在しないため。",
      },
    ]);

    expect(rejected).toEqual([]);
    expect(accepted[0]).toMatchObject({
      kind: EPISODE_PLOT_CONTRAST_KINDS[1],
      plotItem: "形見の懐中時計を見つける",
      plotLine: 11,
      excerpt: null,
      line: null,
    });
  });

  test("理由が「無い」と言っていなければ付け替えない（本文に無い引用として捨てる）", () => {
    const { accepted, rejected } = contrast([
      {
        kind: "箇条書きに無い",
        plotItem: null,
        excerpt: "形見の懐中時計を見つける",
        reason: "懐中時計の場面が加わっている。",
      },
    ]);

    expect(accepted).toEqual([]);
    expect(rejected[0].reason).toBe("excerpt_not_found");
  });

  test("引用が本文にもあるなら付け替えない（本文に場面がある）", () => {
    const text = `${TEXT}\n形見の懐中時計を見つける`;
    const { accepted } = validateEpisodePlotContrast(
      {
        findings: [
          {
            kind: "箇条書きに無い",
            plotItem: null,
            excerpt: "形見の懐中時計を見つける",
            reason: "懐中時計の場面の記述は本文にない。",
          },
        ],
      },
      { items: ITEMS, text, maxFindings: 5 }
    );

    expect(accepted[0]?.kind).toBe("箇条書きに無い");
  });

  test("「主筋の改変」の札でも同じく付け替える（場面が無いなら、起きていない）", () => {
    const { accepted } = contrast([
      {
        kind: "主筋の改変",
        plotItem: null,
        excerpt: "形見の懐中時計を見つける",
        reason: "懐中時計を見つける場面の描写は本文にない。",
      },
    ]);

    expect(accepted[0]).toMatchObject({ kind: "出来事の欠落", plotLine: 11 });
  });

  test("引用が箇条書きのどの行にも当たらなければ付け替えない", () => {
    const { accepted, rejected } = contrast([
      {
        kind: "箇条書きに無い",
        plotItem: null,
        excerpt: "ミナが剣を抜く",
        reason: "剣を抜く場面は本文に存在しないため。",
      },
    ]);

    expect(accepted).toEqual([]);
    expect(rejected[0].reason).toBe("excerpt_not_found");
  });
});

/**
 * 1.3 で足した「主筋の改変」（作者の裁定、2026-09-25 昼）。
 *
 * 箇条書きの出来事は本文でも起きているが、結果や決断が違う方向へ進んでいる。
 * **変わった元の行が要る**（どの筋と違うのかを作者が読めないため）。
 */
describe("P-28 主筋の改変", () => {
  const CHANGE = EPISODE_PLOT_CONTRAST_KINDS[3];

  test("種別の並びは変えずに末尾へ足した（添え字で引く検証とテストを壊さない）", () => {
    expect([...EPISODE_PLOT_CONTRAST_KINDS]).toEqual([
      "箇条書きに無い",
      "出来事の欠落",
      "順序の食い違い",
      "主筋の改変",
    ]);
  });

  test("箇条書きの行と本文の場面の両方を指していれば通る", () => {
    const { accepted, rejected } = contrast([
      {
        kind: CHANGE,
        plotItem: "老人が訪ねてくる",
        excerpt: "老人が訪ねてきた。",
        reason: "箇条書きでは訪ねてくるだけだが、本文では追い返している。",
      },
    ]);

    expect(rejected).toEqual([]);
    expect(accepted[0]).toMatchObject({
      kind: CHANGE,
      plotItem: "老人が訪ねてくる",
      plotLine: 12,
      line: 3,
    });
  });

  test("変わった元の行を指していなければ捨てる（「箇条書きに無い」かどうかを推し量らない）", () => {
    const { accepted, rejected } = contrast([
      {
        kind: CHANGE,
        plotItem: null,
        excerpt: "老人が訪ねてきた。",
        reason: "結末が逆になっている。",
      },
    ]);

    expect(accepted).toEqual([]);
    expect(rejected[0].reason).toBe("change_without_item");
    expect(describeEpisodePlotRejects(rejected)).toContain("改変の元の行を指していない");
  });

  test("引用が空で「無い」と言い切っていれば「出来事の欠落」へ付け替える", () => {
    const { accepted } = contrast([
      {
        kind: CHANGE,
        plotItem: "形見の懐中時計を見つける",
        excerpt: null,
        reason: "懐中時計を見つける場面は描かれていない。",
      },
    ]);

    expect(accepted[0]?.kind).toBe("出来事の欠落");
  });

  test("引用が空でも「無い」と言っていなければ、改変のまま残す（飛び先は話の先頭）", () => {
    const { accepted } = contrast([
      {
        kind: CHANGE,
        plotItem: "老人が訪ねてくる",
        excerpt: null,
        reason: "老人は訪ねてくるが、箇条書きと逆に主人公を責める。",
      },
    ]);

    expect(accepted[0]).toMatchObject({ kind: CHANGE, excerpt: null, line: null });
  });

  describe("理由で自分の指摘を打ち消している答え（順序の網と同じ作り）", () => {
    test.each([
      "結果は箇条書きどおりだが、描写がより詳しい。",
      "結末は箇条書きと一致している。",
      "決断の方向は箇条書きと同じである。",
      "食い違いは特にない。",
    ])("言い切った打ち消しは落とす：%s", (reason) => {
      const { accepted, rejected } = contrast([
        { kind: CHANGE, plotItem: "老人が訪ねてくる", excerpt: "老人が訪ねてきた。", reason },
      ]);

      expect(accepted).toEqual([]);
      expect(rejected[0].reason).toBe("self_denied");
    });

    test.each([
      // 疑問・理由の形は打ち消しと読まない（0.86.1 の教訓）
      "結果が箇条書きどおりか、確かめる必要がある。",
      // 違う方向を言い切っていれば、打ち消しが混ざっても残す
      "前半の結果は箇条書きどおりだが、最後の決断は逆になっている。",
      "結末が箇条書きと異なる。",
    ])("打ち消しと読まない：%s", (reason) => {
      const { accepted } = contrast([
        { kind: CHANGE, plotItem: "老人が訪ねてくる", excerpt: "老人が訪ねてきた。", reason },
      ]);

      expect(accepted).toHaveLength(1);
    });

    test("結果の網は「主筋の改変」にだけ当てる（ほかの種別の理由で言っても落とさない）", () => {
      const { accepted } = contrast([
        {
          kind: EPISODE_PLOT_CONTRAST_KINDS[0],
          plotItem: null,
          excerpt: "窓の外で雨が降っていた。",
          reason: "結果は箇条書きどおりだが、雨の場面は箇条書きに無い。",
        },
      ]);

      expect(accepted).toHaveLength(1);
    });
  });
});

/**
 * 「主筋の改変」の理由が、**箇条書きの筋を言い直しただけ**の答え
 * （実機確認 3巡目、2026-09-25 午後。gemma4:e4b・ハイエルフ未亡人の写し第14話）。
 *
 * あらすじどおりの箇条書きに「主筋の改変」を挙げ、理由は「本文では…突き放す流れに
 * なっている」。**逆の結果・決断を一言も言っていない**。「結果は箇条書きどおり」と
 * 言い切った打ち消しの網（`CHANGE_DENIAL_PATTERN`）は、この形をすり抜ける。
 *
 * 下の材料は測定の実物（箇条書きの行・引用・理由はそのまま。本文は引用の行だけ）。
 * **本物の改変（結果を逆にした仕込み）は落とさない**——作者の判断は「拾う方」。
 */
describe("P-28 主筋の改変：理由が箇条書きの筋の言い直しにすぎない答え", () => {
  const CHANGE = EPISODE_PLOT_CONTRAST_KINDS[3];

  /** 第14話（あらすじどおり）の箇条書き。行番号は単話プロットの行 */
  const EP14 = [
    {
      text: "エルシーの魔法で洞窟の入り口が崩落した後、アジャーノはオークの群れから救い出した孤児院の子供たちと対峙する。",
      line: 8,
    },
    {
      text: "マーフたちは稼ぐ方法を学ぶために同行していたが、生活苦から命の危険を冒していた。",
      line: 9,
    },
    {
      text: "子供たちから金を貸してほしいと懇願されるも、アジャーノは借金を抱える自身の状況を鑑み、突き放して帝都へ引き返す。",
      line: 10,
    },
  ];
  const EP14_TEXT = [
    "「あんちゃん！　あんちゃんもうちの孤児院出身なんだろ？　必ず返すから、オレたちにカネを貸してくれっ！」",
    "",
    "「すぐ死にそうな奴らに、カネなんか貸せるわけねぇだろ」",
    "俺は吐き捨てるように言った。俺が、俺のために、俺の責任で借りたカネだ。",
  ].join("\n");

  function ep14(findings: unknown[]) {
    return validateEpisodePlotContrast(
      { findings },
      { items: EP14, text: EP14_TEXT, maxFindings: 5 }
    );
  }

  test("あらすじどおりの話の「改変」2件（e4b の実物）は、筋の言い直しとして落とす", () => {
    const { accepted, rejected } = ep14([
      {
        kind: CHANGE,
        plotItem: "アジャーノはオークの群れから救い出した孤児院の子供たちと対峙する。",
        excerpt:
          "「あんちゃん！　あんちゃんもうちの孤児院出身なんだろ？　必ず返すから、オレたちにカネを貸してくれっ！」",
        reason:
          "本文では、子供たちから金を貸してほしいと懇願され、アジャーノが突き放す流れになっている。",
      },
      {
        kind: CHANGE,
        plotItem:
          "子供たちから金を貸してほしいと懇願されるも、アジャーノは借金を抱える自身の状況を鑑み、突き放して帝都へ引き返す。",
        excerpt:
          "「すぐ死にそうな奴らに、カネなんか貸せるわけねぇだろ」\n俺は吐き捨てるように言った。俺が、俺のために、俺の責任で借りたカネだ。",
        reason:
          "本文では、アジャーノが「すぐ死にそうな奴ら」という理由で貸すことを拒否し、帝都へ引き返している。",
      },
    ]);

    expect(accepted).toEqual([]);
    expect(rejected.map((r) => r.reason)).toEqual(["restated_item", "restated_item"]);
    expect(describeEpisodePlotRejects(rejected)).toContain("筋の言い直し");
  });

  test("「箇条書きでは〜だけで、本文では〜が深まっている」も、逆を言っていないので落とす", () => {
    const { accepted, rejected } = ep14([
      {
        kind: CHANGE,
        plotItem: "アジャーノはオークの群れから救い出した孤児院の子供たちと対峙する。",
        excerpt: "「すぐ死にそうな奴らに、カネなんか貸せるわけねぇだろ」",
        reason:
          "箇条書きでは対峙するだけで、本文では金銭を貸すかどうかのやり取りで対峙が深まっている。",
      },
    ]);

    expect(accepted).toEqual([]);
    expect(rejected[0].reason).toBe("restated_item");
  });

  test("「順序の食い違い」の言い直しには当てない（順序は拾う方のまま。作者の判断）", () => {
    const { accepted } = ep14([
      {
        kind: EPISODE_PLOT_CONTRAST_KINDS[2],
        plotItem: "アジャーノはオークの群れから救い出した孤児院の子供たちと対峙する。",
        excerpt: "「すぐ死にそうな奴らに、カネなんか貸せるわけねぇだろ」",
        reason:
          "本文では、子供たちから金を貸してほしいと懇願され、アジャーノが突き放す流れになっている。",
      },
    ]);

    expect(accepted).toHaveLength(1);
  });

  /**
   * 本物の改変（結果を逆にした仕込み）の理由の実物。3巡目・ギルドの 1.3 の測定で
   * 仕込みに当たった答えから、**形の違うものを1つずつ**選んだ。
   * どれも落とさない（26b 8/8・e4b 4/8 を減らさない）。
   */
  test.each([
    {
      // 「箇条書きでは〜が、本文では〜」と対比している（26b の大半と e4b の一部）
      item: "子供たちから金を貸してほしいと懇願されたアジャーノは、快く金を貸してやる。",
      excerpt: "「すぐ死にそうな奴らに、カネなんか貸せるわけねぇだろ」",
      reason: "箇条書きでは快く貸すとなっているが、本文では貸すことを拒否している。",
    },
    {
      // かぎかっこの中身を外しても対比が残る
      item: "アジャーノは、魔法の鞄とエルシーの雇用、肉の定期納品に関する契約へのサインをきっぱり断った。",
      excerpt: "悩んだ末、結局契約書にサインした。",
      reason: "箇条書きでは「きっぱり断った」とあるが、本文では「結局契約書にサインした」と記述されているため。",
    },
    {
      // 対比の言葉は無いが、箇条書きの行が「〜ず」「〜なかった」で、本文は逆（e4b 第7話）
      item: "アジャーノは戦わずに逃げ出し、沼ワニとも戦わなかったので、愛用の槍は無事だった。",
      excerpt: "そのままの勢いで沼ワニの目に突き刺す。",
      reason: "本文では、アジャーノは沼ワニと戦い、愛用の槍は穂先が曲がり使用不能になっている。",
    },
    {
      // 理由の側で打ち消している（ギルド第11話）
      item: "日本語を話すハルトは、自身の異能や帝国での経緯を語り、生活保護のケースワーカーの仕事を断って帝都へ帰るのだった。",
      excerpt: "やるっすよ",
      reason: "本文の最後では、ハルトは生活保護のケースワーカーの仕事を断らずに引き受けている。",
    },
    {
      // 「〜ではなく」（ギルド第4話、26b）
      item: "そこでグレイは、師匠が山賊団とは無関係だったと知って安堵する。",
      excerpt: "師匠は変わっちまった。",
      reason: "師匠が山賊団の幹部であることが判明し、グレイは安堵ではなくショックを受けている。",
    },
    {
      // 決断の語が対になっている：箇条書き「断る」／理由「同意している」（ギルド第1話、1.3a の e4b）
      item: "仲間や制度に支えられていることを指摘されても、ジャックは採集に行くことをきっぱり断る。",
      excerpt: "それも良いかもしれないな",
      reason: "本文では、指摘を受けた後、最終的に「行ってもいいが」と行くことに同意している。",
    },
    {
      // 決断の語が対になっている：箇条書き「受ける」／理由「断り」（ギルド第18話、e4b）
      item: "メアリーから食事などに誘われるホンゴーは、線引きなど気にせず誘いを受ける。",
      excerpt: "線引きは大事だ。",
      reason: "本文では、ホンゴーがメアリーからの誘いを断り、線引きを意識している様子が描かれている。",
    },
  ])("本物の改変は落とさない：$reason", ({ item, excerpt, reason }) => {
    const { accepted, rejected } = validateEpisodePlotContrast(
      { findings: [{ kind: CHANGE, plotItem: item, excerpt, reason }] },
      { items: [{ text: item, line: 5 }], text: excerpt, maxFindings: 5 }
    );

    expect(rejected).toEqual([]);
    expect(accepted[0]?.kind).toBe(CHANGE);
  });

  test("決断の語の対は、箇条書きの行に同じ側の語もあれば効かせない（「拒否」の言い直し）", () => {
    // ギルド第17話（あらすじどおり、e4b）。箇条書きも理由も「拒否」で、逆ではない
    const item =
      "冒険者の技量不足を指摘し、生活保護の適用を拒否して周辺での採集を促すと、冒険者は怒って帰っていった。";
    const excerpt = "街周辺での採集ならできるでしょう。";
    const { rejected } = validateEpisodePlotContrast(
      {
        findings: [
          {
            kind: CHANGE,
            plotItem: item,
            excerpt,
            reason:
              "本文では、生活保護の適用を拒否し、採集を促した結果、冒険者は「肩を怒らせて立ち上がった」後、帰っていった。",
          },
        ],
      },
      { items: [{ text: item, line: 5 }], text: excerpt, maxFindings: 5 }
    );

    expect(rejected[0]?.reason).toBe("restated_item");
  });

  test("箇条書きのどの行とも言葉が重ならない理由は、言い直しとは読まない（落とさない）", () => {
    const { accepted } = contrast([
      {
        kind: CHANGE,
        plotItem: "老人が訪ねてくる",
        excerpt: "老人が訪ねてきた。",
        reason: "結果が箇条書きどおりか、確かめる必要がある。",
      },
    ]);

    expect(accepted).toHaveLength(1);
  });
});

/**
 * 1.3 で種別の説明の言葉を指示に足した。**指示の言葉は理由の欄にそのまま返ってくる**
 * （失敗3）ので、説明をなぞっただけの理由は中身の無い答えとして捨てる。
 */
describe("P-28 種別の説明をなぞっただけの理由", () => {
  test.each([
    ["主筋の改変", "箇条書きの出来事は本文でも起きているが、結果や決断が箇条書きと逆になっている"],
    ["箇条書きに無い", "箇条書きのどの行にも当たらない出来事が、本文で起きている。"],
    ["出来事の欠落", "（箇条書きにある出来事が、本文で起きていない）"],
  ])("%s の説明を写しただけなら捨てる", (kind, reason) => {
    const { accepted, rejected } = contrast([
      { kind, plotItem: "老人が訪ねてくる", excerpt: "老人が訪ねてきた。", reason },
    ]);

    expect(accepted).toEqual([]);
    expect(rejected[0].reason).toBe("placeholder");
  });

  test("説明の言葉を含んでいても、中身があれば通す（丸ごと同じときだけ捨てる）", () => {
    const { accepted } = contrast([
      {
        kind: "主筋の改変",
        plotItem: "老人が訪ねてくる",
        excerpt: "老人が訪ねてきた。",
        reason: "結果や決断が箇条書きと違う方向へ進んでいる：老人を追い返している。",
      },
    ]);

    expect(accepted).toHaveLength(1);
  });
});
