import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  describeEpisodePlotRejects,
  parseEpisodePlotFindings,
  validateEpisodePlotCheck,
  validateEpisodePlotContrast,
} from "../../src/core/episodePlotValidation";
import { EPISODE_PLOT_CHECK_KINDS } from "../../src/prompts/episodePlotCheck";
import { EPISODE_PLOT_CONTRAST_KINDS } from "../../src/prompts/episodePlotContrast";

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

function check(findings: unknown[], maxFindings = 5) {
  return validateEpisodePlotCheck({ findings }, { items: ITEMS, maxFindings });
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
