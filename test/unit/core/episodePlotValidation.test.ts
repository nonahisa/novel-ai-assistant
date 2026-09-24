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
        kind: "起きていない",
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

      expect(accepted[0]?.kind).toBe("起きていない");
    });

    test("付け替えたものが、同じ行の「起きていない」と重なれば1件にする", () => {
      const { accepted, rejected } = contrast([
        {
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
      expect(accepted[0].kind).toBe("起きていない");
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
