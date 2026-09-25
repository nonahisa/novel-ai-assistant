import { describe, expect, test } from "vitest";
import {
  buildEpisodePlotCheckPrompt,
  EPISODE_PLOT_CHECK_HINTS,
  EPISODE_PLOT_CHECK_KINDS,
  EPISODE_PLOT_CHECK_SCHEMA,
  EPISODE_PLOT_CHECK_SYSTEM_PROMPT,
  EPISODE_PLOT_CHECK_VERSION,
  episodePlotCheckBudget,
} from "../../../src/prompts/episodePlotCheck";
import {
  buildEpisodePlotContrastPrompt,
  EPISODE_PLOT_CONTRAST_HINTS,
  EPISODE_PLOT_CONTRAST_KINDS,
  EPISODE_PLOT_CONTRAST_SCHEMA,
  EPISODE_PLOT_CONTRAST_SYSTEM_PROMPT,
  EPISODE_PLOT_CONTRAST_VERSION,
} from "../../../src/prompts/episodePlotContrast";
import {
  validateEpisodePlotCheck,
  validateEpisodePlotContrast,
} from "../../../src/core/episodePlotValidation";

/**
 * P-27・P-28 のプロンプト（設計書6.36.3）。
 *
 * **指示の言葉は、そのまま答えとして返ってくる**（この作品で繰り返し
 * 起きた失敗3）。見本の値は2つに分ける。
 *
 *   - 実在値（箇条書きの1行）：返ってきても、実在の行を指しただけになる
 *   - 項目の言い換え（理由・引用の説明）：返ってきたら検証が弾く
 */

const ITEMS = [
  { text: "朝、兄の部屋を片付ける", line: 10 },
  { text: "形見の懐中時計を見つける", line: 11 },
  { text: "老人が訪ねてくる", line: 12 },
];

const CHECK_INPUT = {
  chapterLabel: "第3話",
  viewpoint: "ミナ（一人称）",
  goal: "ミナが旅に出ると決める。",
  items: ITEMS.map((item) => item.text),
  maxFindings: 3,
};

describe("P-27 単話プロットの検査のプロンプト", () => {
  test("版が定まっている（キャッシュと再現の手掛かり）", () => {
    expect(EPISODE_PLOT_CHECK_VERSION).toMatch(/^\d+\.\d+$/);
  });

  test("視点・目標・展開が材料として入る", () => {
    const prompt = buildEpisodePlotCheckPrompt(CHECK_INPUT);

    expect(prompt).toContain("第3話");
    expect(prompt).toContain("ミナ（一人称）");
    expect(prompt).toContain("ミナが旅に出ると決める。");
    for (const item of CHECK_INPUT.items) expect(prompt).toContain(item);
  });

  test("見る観点は3つだけを渡す", () => {
    const prompt = buildEpisodePlotCheckPrompt(CHECK_INPUT);
    for (const kind of EPISODE_PLOT_CHECK_KINDS) {
      expect(prompt).toContain(kind);
    }
  });

  test("書き直しの作文をさせない（修正案の欄を持たない）", () => {
    const items = EPISODE_PLOT_CHECK_SCHEMA.properties.findings.items;

    expect(items.required).toEqual(["item", "kind", "reason"]);
    expect(Object.keys(items.properties)).toEqual(["item", "kind", "reason"]);
    // 画面にも「こう直せ」の欄は無い
    expect(JSON.stringify(items.properties)).not.toContain("suggestion");
  });

  test("目標が空なら、目標の観点を尋ねない（見本の種別も停滞・重複にする）", () => {
    // 実機確認 2026-09-25 深夜：目標が空の19話に、e4b が「目標に向かっていない」を
    // 11件出した。「目標が無いときは判断できない」と書いても、見本の種別
    // （先頭の「目標に向かっていない」）ごと写してくる。**尋ねなければ返らない**
    const prompt = buildEpisodePlotCheckPrompt({ ...CHECK_INPUT, goal: "" });

    expect(prompt).not.toContain("目標に向かっていない");
    expect(prompt).not.toContain("目標と矛盾");
    expect(prompt).toContain('"kind": "停滞・重複"');
    expect(prompt).toContain("kind には次のどれか1つだけを入れてください：停滞・重複");
    // 目標の節そのものは「書かれていません」と断る（無いものを埋めさせない）
    expect(prompt).toContain("（書かれていません）");
  });

  test("目標が書いてあれば、3つの観点を尋ねる", () => {
    const prompt = buildEpisodePlotCheckPrompt(CHECK_INPUT);

    expect(prompt).toContain(`"kind": "${EPISODE_PLOT_CHECK_KINDS[0]}"`);
    expect(prompt).toContain(
      `kind には次のどれか1つだけを入れてください：${EPISODE_PLOT_CHECK_KINDS.join("、")}`
    );
  });

  test("見本の対象は実在の箇条書き（そのまま返っても実害が無い）", () => {
    const prompt = buildEpisodePlotCheckPrompt(CHECK_INPUT);

    expect(prompt).toContain(`"item": "${ITEMS[0].text}"`);

    // 対象と種別だけを見本どおりに返した応答は、実在の行を指している
    const { accepted } = validateEpisodePlotCheck(
      {
        findings: [
          {
            item: ITEMS[0].text,
            kind: EPISODE_PLOT_CHECK_KINDS[0],
            reason: "目標である旅立ちに繋がっていない。",
          },
        ],
      },
      { items: ITEMS, goal: CHECK_INPUT.goal, maxFindings: 3 }
    );
    expect(accepted).toHaveLength(1);
    expect(accepted[0].line).toBe(10);
  });

  test("理由の見本は言い換えで、返ってきたら検証が弾く", () => {
    const prompt = buildEpisodePlotCheckPrompt(CHECK_INPUT);
    for (const hint of EPISODE_PLOT_CHECK_HINTS) {
      expect(prompt).toContain(hint);
    }

    const { accepted, rejected } = validateEpisodePlotCheck(
      {
        findings: [
          {
            item: ITEMS[0].text,
            kind: EPISODE_PLOT_CHECK_KINDS[0],
            reason: EPISODE_PLOT_CHECK_HINTS[0],
          },
        ],
      },
      { items: ITEMS, goal: CHECK_INPUT.goal, maxFindings: 3 }
    );
    expect(accepted).toHaveLength(0);
    expect(rejected[0].reason).toBe("placeholder");
  });

  test("件数の上限は、箇条書きの数から決める", () => {
    expect(episodePlotCheckBudget(0)).toBeGreaterThanOrEqual(1);
    expect(episodePlotCheckBudget(3)).toBeLessThanOrEqual(5);
    expect(episodePlotCheckBudget(40)).toBeLessThanOrEqual(5);
    const prompt = buildEpisodePlotCheckPrompt(CHECK_INPUT);
    expect(prompt).toContain("3件");
  });

  test("システムプロンプトは、書き直しを禁じてJSONだけを求める", () => {
    expect(EPISODE_PLOT_CHECK_SYSTEM_PROMPT).toContain("JSON");
    expect(EPISODE_PLOT_CHECK_SYSTEM_PROMPT).toContain("書き直");
  });

  test("良いところを頼み（件数で絞らない）、指摘は0件でよいと言う（プロンプト設計書1.9）", () => {
    const prompt = buildEpisodePlotCheckPrompt(CHECK_INPUT);
    expect(prompt).toContain("strengths");
    expect(prompt).toContain("0件でも構いません");
    expect(prompt).toContain("数を絞る必要はありません");
    expect(EPISODE_PLOT_CHECK_SCHEMA.required).toContain("strengths");
    // 良いところの見本の理由も、返ってきたら検証が弾く言い換えである
    const { strengths } = validateEpisodePlotCheck(
      {
        findings: [],
        strengths: EPISODE_PLOT_CHECK_HINTS.map((hint) => ({
          item: ITEMS[0].text,
          why: hint,
        })),
      },
      { items: ITEMS, goal: CHECK_INPUT.goal, maxFindings: 3 }
    );
    expect(strengths).toEqual([]);
  });
});

const CONTRAST_INPUT = {
  chapterLabel: "第3話",
  goal: "ミナが旅に出ると決める。",
  items: ITEMS.map((item) => item.text),
  chapterText: "朝、兄の部屋を片付けた。\n窓の外で雨が降っていた。\n老人が訪ねてきた。",
  maxFindings: 3,
};

describe("P-28 単話プロットと本文の照合のプロンプト", () => {
  test("版が定まっている", () => {
    expect(EPISODE_PLOT_CONTRAST_VERSION).toMatch(/^\d+\.\d+$/);
  });

  test("箇条書きと本文の両方が材料として入る", () => {
    const prompt = buildEpisodePlotContrastPrompt(CONTRAST_INPUT);

    expect(prompt).toContain("老人が訪ねてくる");
    expect(prompt).toContain("窓の外で雨が降っていた。");
  });

  test("物差しがその話の箇条書きであることを、はっきり書く", () => {
    const prompt = buildEpisodePlotContrastPrompt(CONTRAST_INPUT);

    expect(prompt).toContain("箇条書き");
    // 作品全体のプロット（P-11）と混ぜない
    expect(prompt).not.toContain("作品全体のプロット");
  });

  test("見る観点は4つ（1.3 で「出来事の欠落」「主筋の改変」。作者の裁定 2026-09-25 昼）", () => {
    const prompt = buildEpisodePlotContrastPrompt(CONTRAST_INPUT);
    expect(EPISODE_PLOT_CONTRAST_KINDS).toHaveLength(4);
    for (const kind of EPISODE_PLOT_CONTRAST_KINDS) {
      expect(prompt).toContain(kind);
    }
    // 「起きていない」は「出来事の欠落」へ名前を替えた。古い名前を種別として指示に残さない
    expect(prompt).not.toContain("「起きていない」");
  });

  test("欠落と改変の分け方を言う（場面があるなら改変、無いなら欠落）", () => {
    const prompt = buildEpisodePlotContrastPrompt(CONTRAST_INPUT);
    expect(prompt).toMatch(/「主筋の改変」は、場面はあるのに/);
  });

  /*
    1.3 の最初の文面（「結果や決断が箇条書きと違う方向へ進んでいる」だけ）では、
    e4b が箇条書きどおりの話19話に「主筋の改変」を27件挙げ（理由は言い方・細部・
    前後の違い）、入れ替えた話でも順序の指摘を「主筋の改変」の札で返して、
    入れ替えを拾う数が 16/19 → 3/19 に落ちた。逆になったときだけ、と絞り、
    順番の違いは「順序の食い違い」へ向ける
  */
  test("主筋の改変は「逆になったときだけ」で、細部・順番の違いは含めないと言う", () => {
    const prompt = buildEpisodePlotContrastPrompt(CONTRAST_INPUT);
    expect(prompt).toContain("結果や決断が箇条書きと逆になったときだけです");
    expect(prompt).toContain("起きる順番が違うだけのものは「主筋の改変」にしないでください");
    expect(prompt).toContain("順番が違うなら「順序の食い違い」です");
  });

  /*
    e4b は箇条書きどおりの話（対照）に「箇条書きに無い」を出しすぎる
    （1.1 の測定で19話に36件、1.2 で15件）。理由を読むと、ほとんどが箇条書きの行の
    中身を本文が詳しく描いた場面だった（「本文の後半で、ホンゴーが捜索依頼を出す場面がある」）
  */
  test("箇条書きは要約で、行の中身を詳しく描いた場面は「箇条書きに無い」にしないと言う", () => {
    const prompt = buildEpisodePlotContrastPrompt(CONTRAST_INPUT);
    expect(prompt).toContain("箇条書きは話の要約です");
    expect(prompt).toContain("詳しく描いているだけなら「箇条書きに無い」にしないでください");
  });

  test("修正案の欄を持たない（指摘だけ）", () => {
    const items = EPISODE_PLOT_CONTRAST_SCHEMA.properties.findings.items;

    expect(items.required).toEqual(["kind", "plotItem", "excerpt", "reason"]);
    expect(items.properties.plotItem.type).toEqual(["string", "null"]);
    expect(items.properties.excerpt.type).toEqual(["string", "null"]);
    expect(JSON.stringify(items.properties)).not.toContain("suggestion");
  });

  test("見本の箇条書きは実在の行（そのまま返っても実害が無い）", () => {
    const prompt = buildEpisodePlotContrastPrompt(CONTRAST_INPUT);
    expect(prompt).toContain(`"plotItem": "${ITEMS[0].text}"`);
  });

  test("引用と理由の見本は言い換えで、返ってきたら検証が弾く", () => {
    const prompt = buildEpisodePlotContrastPrompt(CONTRAST_INPUT);
    for (const hint of EPISODE_PLOT_CONTRAST_HINTS) {
      expect(prompt).toContain(hint);
    }

    const { accepted } = validateEpisodePlotContrast(
      {
        findings: [
          {
            kind: EPISODE_PLOT_CONTRAST_KINDS[0],
            plotItem: ITEMS[0].text,
            excerpt: EPISODE_PLOT_CONTRAST_HINTS[0],
            reason: EPISODE_PLOT_CONTRAST_HINTS[1],
          },
        ],
      },
      { items: ITEMS, text: CONTRAST_INPUT.chapterText, maxFindings: 3 }
    );
    expect(accepted).toHaveLength(0);
  });

  /**
   * 作者の判断（2026-09-25「拾う方」）。1.1 で入れ替わった相手を必須にしたら、
   * 本物の入れ替えを拾う数が落ちた（26b 15/19 → 12/19）。1.2 は 1.0 の文面に戻し、
   * 相手を尋ねず、「書けないなら挙げない」とも言わない。
   */
  test("順序の指摘に、入れ替わった相手を必須で書かせない（拾う方）", () => {
    const prompt = buildEpisodePlotContrastPrompt(CONTRAST_INPUT);
    expect(prompt).not.toContain("swappedItem");
    expect(prompt).not.toContain("書けないなら挙げない");
    const items = EPISODE_PLOT_CONTRAST_SCHEMA.properties.findings.items;
    expect(JSON.stringify(items)).not.toContain("swapped");
  });

  test("システムプロンプトは、書き直しを禁じてJSONだけを求める", () => {
    expect(EPISODE_PLOT_CONTRAST_SYSTEM_PROMPT).toContain("JSON");
    expect(EPISODE_PLOT_CONTRAST_SYSTEM_PROMPT).toContain("書き直");
  });
});
