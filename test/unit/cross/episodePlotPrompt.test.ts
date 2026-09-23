import { describe, expect, test } from "vitest";
import {
  buildEpisodePlotCheckPrompt,
  EPISODE_PLOT_CHECK_HINTS,
  EPISODE_PLOT_CHECK_KINDS,
  EPISODE_PLOT_CHECK_SCHEMA,
  EPISODE_PLOT_CHECK_SYSTEM_PROMPT,
  EPISODE_PLOT_CHECK_VERSION,
  episodePlotCheckBudget,
} from "../../src/prompts/episodePlotCheck";
import {
  buildEpisodePlotContrastPrompt,
  EPISODE_PLOT_CONTRAST_HINTS,
  EPISODE_PLOT_CONTRAST_KINDS,
  EPISODE_PLOT_CONTRAST_SCHEMA,
  EPISODE_PLOT_CONTRAST_SYSTEM_PROMPT,
  EPISODE_PLOT_CONTRAST_VERSION,
} from "../../src/prompts/episodePlotContrast";
import {
  validateEpisodePlotCheck,
  validateEpisodePlotContrast,
} from "../../src/core/episodePlotValidation";

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
      { items: ITEMS, maxFindings: 3 }
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
      { items: ITEMS, maxFindings: 3 }
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

  test("見る観点は3つだけ", () => {
    const prompt = buildEpisodePlotContrastPrompt(CONTRAST_INPUT);
    for (const kind of EPISODE_PLOT_CONTRAST_KINDS) {
      expect(prompt).toContain(kind);
    }
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

  test("システムプロンプトは、書き直しを禁じてJSONだけを求める", () => {
    expect(EPISODE_PLOT_CONTRAST_SYSTEM_PROMPT).toContain("JSON");
    expect(EPISODE_PLOT_CONTRAST_SYSTEM_PROMPT).toContain("書き直");
  });
});
