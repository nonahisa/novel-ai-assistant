import { describe, expect, test } from "vitest";
import { buildOpeningCheckPrompt } from "../../../src/prompts/openingCheck";
import {
  buildReaderAdvicePrompt,
  READER_ADVICE_GUIDELINES,
} from "../../../src/prompts/readerAdvice";
import { buildEpisodePlotCheckPrompt } from "../../../src/prompts/episodePlotCheck";
import { WORK_CHAT_SYSTEM_PROMPT } from "../../../src/prompts/workChat";
import {
  ADVICE_STATE_PROMPTS,
  ADVICE_TYPE_PROMPTS,
} from "../../../src/prompts/advicePolicy";
import { buildTitleFitPrompt } from "../../../src/prompts/titleFit";

/**
 * 助言・講評を返すプロンプトに、件数を強いる語が戻ってこないかを見張る
 * （プロンプト設計書1.9、作者の方針 2026-09-24）。
 *
 * 「作品が高い水準でバランスをとっているとき、無理に助言を言わなくても
 * いいです。あと、ほめることができる場所は、省略せずきちんとほめて
 * ください。」
 *
 * **対象は助言・講評・診断を返すものだけ。** 誤字脱字・矛盾・伏線・逸脱の
 * ような「見つける」機能は、見逃しと誤検出の両方を測る決まりのままなので
 * ここでは見ない。
 *
 * 見るのは「最低N件」「必ず改善点を」「N つ挙げよ」「指摘は1つだけ」の類。
 * **上限（「多くても2つまで」）は見ない**——上限は強いる語ではない。
 */

const ADVICE_PROMPTS: Array<[string, string]> = [
  [
    "冒頭診断（P-24）",
    buildOpeningCheckPrompt({ workTitle: "作品", genre: "", logline: "", openingText: "本文" }),
  ],
  ["読者の反応の助言（P-40）", buildReaderAdvicePrompt({ workTitle: "作品", materials: [] })],
  ["読者の反応の約束（P-40・相談と共有）", READER_ADVICE_GUIDELINES],
  [
    "単話プロットの検査（P-27）",
    buildEpisodePlotCheckPrompt({
      chapterLabel: "第1話",
      viewpoint: "",
      goal: "旅に出る",
      items: ["朝、部屋を片付ける", "手紙を見つける"],
      maxFindings: 2,
    }),
  ],
  ["相談（P-21）", WORK_CHAT_SYSTEM_PROMPT],
  ...Object.entries(ADVICE_TYPE_PROMPTS).map(
    ([id, text]): [string, string] => [`助言方針のタイプ（P-36 ${id}）`, text]
  ),
  ...Object.entries(ADVICE_STATE_PROMPTS).map(
    ([id, text]): [string, string] => [`助言方針の調子（P-36 ${id}）`, text]
  ),
  [
    "タイトル適合度（P-41）",
    buildTitleFitPrompt({
      readerType: "lore_deep",
      targets: [{ id: "title", kind: "title", label: "作品タイトル", text: "鉛の海" }],
    }),
  ],
];

/** 件数を強いる言い方。見つかったら、その機能は直す所を件数で作りうる */
const FORCING_PATTERNS: RegExp[] = [
  /必ず[^。\n]{0,10}(改善点|改善案|指摘|助言|直しどころ|直すべき)/u,
  /(最低|少なくとも)[^。\n]{0,4}[0-9０-９一二三四五]+\s*(つ|個|件|点)/u,
  /[0-9０-９一二三四五]+\s*(つ|個|件|点)を?挙げ(よ|て|なさい)/u,
  /指摘は[0-9０-９一二三]+つだけ/u,
  /比率は[0-9０-９]+対[0-9０-９]+/u,
  /直しどころを[0-9０-９一]+点だけ/u,
  /場面を一つだけ/u,
];

describe("助言・講評のプロンプトに、件数を強いる語が無い（1.9）", () => {
  test.each(ADVICE_PROMPTS)("%s", (_label, prompt) => {
    for (const pattern of FORCING_PATTERNS) {
      expect(prompt, String(pattern)).not.toMatch(pattern);
    }
  });
});

describe("助言を返す機能は、直す所が無ければ無くてよいと言っている（1.9）", () => {
  const permits: Array<[string, string]> = [
    ADVICE_PROMPTS[0],
    ADVICE_PROMPTS[1],
    ADVICE_PROMPTS[3],
    ADVICE_PROMPTS[4],
  ];
  test.each(permits)("%s", (_label, prompt) => {
    expect(prompt).toMatch(/見当たらなければ|0件でも構いません/u);
  });
});
